-- General Jack access is independent of optional pilot participation.
-- Existing pilot memberships, consent, and knowledge scopes are untouched.
create table public.jack_access_invitations (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id),
  email text check (email is null or (email = lower(btrim(email)) and length(email) <= 254)),
  role text not null check (role in ('member', 'champion')),
  invited_by_user_id text,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  delivery_status text not null default 'pending' check (delivery_status in ('pending', 'sent', 'unknown')),
  clerk_invitation_id text unique,
  clerk_user_id text,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_by_user_id text,
  accepted_at timestamptz,
  revoked_by_user_id text,
  created_at timestamptz not null default now(),
  check (status <> 'pending' or email is not null)
);
create unique index jack_access_pending_email_unique on public.jack_access_invitations (organization_id, email) where status = 'pending';
create index jack_access_invitation_email_idx on public.jack_access_invitations (email, status);
create table public.jack_memberships (
  organization_id uuid not null references public.organizations(id),
  user_id text not null,
  role text not null check (role in ('member', 'champion')),
  active boolean not null default true,
  source_invitation_id uuid not null references public.jack_access_invitations(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index jack_memberships_user_idx on public.jack_memberships (user_id, active);
create table public.jack_access_audit (
  id bigint generated always as identity primary key,
  invitation_id uuid references public.jack_access_invitations(id),
  organization_id uuid not null references public.organizations(id),
  actor_user_id text,
  target_user_id text,
  action text not null,
  role text not null,
  occurred_at timestamptz not null default now()
);
-- Permanent subject fence prevents concurrent acceptance during account deletion.
create table public.jack_access_deleted_accounts (
  subject_hash text primary key check (subject_hash ~ '^[0-9a-f]{64}$'),
  deleted_at timestamptz not null default now()
);
alter table public.jack_access_invitations enable row level security;
alter table public.jack_memberships enable row level security;
alter table public.jack_access_audit enable row level security;
alter table public.jack_access_deleted_accounts enable row level security;
revoke all on public.jack_access_invitations, public.jack_memberships, public.jack_access_audit, public.jack_access_deleted_accounts from public, anon, authenticated;
-- Supabase default privileges may already grant service_role ALL; narrow those
-- before granting direct writes only to invitation intent/delivery metadata.
revoke all on public.jack_access_invitations, public.jack_memberships, public.jack_access_audit, public.jack_access_deleted_accounts from service_role;
grant select, insert, update on public.jack_access_invitations to service_role;
grant select on public.jack_memberships, public.jack_access_audit, public.jack_access_deleted_accounts to service_role;

-- Low-volume invitation mutations use one transaction lock. The statement
-- trigger runs before row locks; every deletion/accept/revoke RPC takes this
-- same lock first, avoiding a row-lock/advisory-lock inversion with late writes.
create function public.lock_jack_invitation_writes() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('jack-access:invitations', 0));
  return null;
end $$;
create trigger jack_invitation_write_lock before insert or update on public.jack_access_invitations
for each statement execute function public.lock_jack_invitation_writes();
create function public.guard_jack_invitation_subjects() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (
    select 1 from public.jack_access_deleted_accounts d
    where d.subject_hash in (
      encode(sha256(convert_to(NEW.invited_by_user_id, 'UTF8')), 'hex'),
      encode(sha256(convert_to(NEW.clerk_user_id, 'UTF8')), 'hex'),
      encode(sha256(convert_to(NEW.accepted_by_user_id, 'UTF8')), 'hex'),
      encode(sha256(convert_to(NEW.revoked_by_user_id, 'UTF8')), 'hex')
    )
  ) then raise exception 'Account deletion prevents invitation mutation' using errcode = '42501'; end if;
  if TG_OP = 'UPDATE' and OLD.status = 'revoked' and (
    NEW.status <> 'revoked' or (NEW.email is not null and NEW.email is distinct from OLD.email) or
    (NEW.clerk_user_id is not null and NEW.clerk_user_id is distinct from OLD.clerk_user_id) or
    (NEW.clerk_invitation_id is not null and NEW.clerk_invitation_id is distinct from OLD.clerk_invitation_id)
  ) then raise exception 'Revoked invitation cannot be rebound' using errcode = '42501'; end if;
  return NEW;
end $$;
create trigger jack_invitation_subject_guard before insert or update on public.jack_access_invitations
for each row execute function public.guard_jack_invitation_subjects();
revoke all on function public.lock_jack_invitation_writes(), public.guard_jack_invitation_subjects() from public, anon, authenticated, service_role;

create function public.audit_jack_invitation() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare action_name text; actor text;
begin
  if TG_OP = 'INSERT' then action_name := 'invited'; actor := NEW.invited_by_user_id;
  elsif NEW.status is distinct from OLD.status then
    action_name := NEW.status;
    actor := case when NEW.status = 'accepted' then NEW.accepted_by_user_id else NEW.revoked_by_user_id end;
  elsif NEW.delivery_status is distinct from OLD.delivery_status then
    action_name := 'delivery_' || NEW.delivery_status; actor := NEW.invited_by_user_id;
  else return NEW;
  end if;
  insert into public.jack_access_audit (invitation_id, organization_id, actor_user_id, target_user_id, action, role)
  values (NEW.id, NEW.organization_id, actor, NEW.accepted_by_user_id, action_name, NEW.role);
  return NEW;
end $$;
create trigger jack_invitation_audit after insert or update on public.jack_access_invitations for each row execute function public.audit_jack_invitation();
revoke all on function public.audit_jack_invitation() from public, anon, authenticated, service_role;

-- Trusted server only, after Clerk confirms the primary email is verified.
create function public.accept_jack_invitations(p_user_id text, p_email text)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare invitation public.jack_access_invitations; accepted integer := 0;
begin
  if p_user_id is null or p_user_id !~ '^[a-zA-Z0-9_-]{1,128}$' or p_email is null or length(p_email) > 254 then raise exception 'Invalid verified identity'; end if;
  perform pg_advisory_xact_lock(hashtextextended('jack-access:invitations', 0));
  if exists (select 1 from public.jack_access_deleted_accounts where subject_hash = encode(sha256(convert_to(p_user_id, 'UTF8')), 'hex')) then return 0; end if;
  for invitation in
    select i.* from public.jack_access_invitations i join public.organizations o on o.id = i.organization_id and o.status = 'active'
    where i.email = lower(btrim(p_email)) and i.clerk_user_id = p_user_id
      and i.status = 'pending' and i.expires_at > now()
    order by i.created_at, i.id for update of i
  loop
    insert into public.jack_memberships (organization_id, user_id, role, source_invitation_id)
    values (invitation.organization_id, p_user_id, invitation.role, invitation.id)
    on conflict (organization_id, user_id) do update set role = excluded.role, active = true,
      source_invitation_id = excluded.source_invitation_id, updated_at = now();
    update public.jack_access_invitations set status = 'accepted', accepted_by_user_id = p_user_id, accepted_at = now() where id = invitation.id;
    accepted := accepted + 1;
  end loop;
  return accepted;
end $$;
create function public.revoke_jack_invitation(p_invitation_id uuid, p_actor_user_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare invitation public.jack_access_invitations;
begin
  perform pg_advisory_xact_lock(hashtextextended('jack-access:invitations', 0));
  if exists (select 1 from public.jack_access_deleted_accounts where subject_hash = encode(sha256(convert_to(p_actor_user_id, 'UTF8')), 'hex')) then
    raise exception 'Account deletion prevents invitation mutation' using errcode = '42501';
  end if;
  select * into invitation from public.jack_access_invitations where id = p_invitation_id for update;
  if not found or invitation.status = 'revoked' then return; end if;
  update public.jack_access_invitations set status = 'revoked', revoked_by_user_id = p_actor_user_id where id = p_invitation_id;
  -- Revoking an older invitation cannot remove a newer authorized grant.
  update public.jack_memberships set active = false, updated_at = now() where source_invitation_id = p_invitation_id;
end $$;
create function public.begin_jack_access_account_deletion(p_user_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_user_id is null or p_user_id !~ '^[a-zA-Z0-9_-]{1,128}$' then raise exception 'Invalid account identity'; end if;
  perform pg_advisory_xact_lock(hashtextextended('jack-access:invitations', 0));
  insert into public.jack_access_deleted_accounts (subject_hash)
  values (encode(sha256(convert_to(p_user_id, 'UTF8')), 'hex')) on conflict do nothing;
end $$;
create function public.delete_jack_access_account(p_user_id text, p_verified_emails text[] default '{}')
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.begin_jack_access_account_deletion(p_user_id);
  delete from public.jack_memberships where user_id = p_user_id;
  -- Scrub the bound recipient and attributable verified email, without fencing
  -- that address forever against a distinct, subsequently authorized identity.
  update public.jack_access_invitations set
    status = case when accepted_by_user_id = p_user_id or clerk_user_id = p_user_id or
      (email = any(p_verified_emails)) then 'revoked' else status end,
    email = case when accepted_by_user_id = p_user_id or clerk_user_id = p_user_id or
      (email = any(p_verified_emails)) then null else email end,
    clerk_user_id = case when clerk_user_id = p_user_id then null else clerk_user_id end,
    clerk_invitation_id = case when accepted_by_user_id = p_user_id or clerk_user_id = p_user_id or
      (email = any(p_verified_emails)) then null else clerk_invitation_id end,
    accepted_by_user_id = case when accepted_by_user_id = p_user_id then null else accepted_by_user_id end,
    invited_by_user_id = case when invited_by_user_id = p_user_id then null else invited_by_user_id end,
    revoked_by_user_id = case when revoked_by_user_id = p_user_id then null else revoked_by_user_id end
  where accepted_by_user_id = p_user_id or clerk_user_id = p_user_id or invited_by_user_id = p_user_id or
    revoked_by_user_id = p_user_id or (email = any(p_verified_emails));
  delete from public.jack_access_audit where actor_user_id = p_user_id or target_user_id = p_user_id;
end $$;
revoke all on function public.accept_jack_invitations(text,text), public.revoke_jack_invitation(uuid,text), public.begin_jack_access_account_deletion(text), public.delete_jack_access_account(text,text[]) from public, anon, authenticated;
grant execute on function public.accept_jack_invitations(text,text), public.revoke_jack_invitation(uuid,text), public.begin_jack_access_account_deletion(text), public.delete_jack_access_account(text,text[]) to service_role;
