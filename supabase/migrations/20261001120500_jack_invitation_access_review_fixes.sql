-- Fix post-merge review findings from PR #213 without weakening the access boundary.
-- 1) Membership source/role is deterministic across multiple verified emails.
-- 2) Revoking one invitation falls back to the newest remaining accepted grant.
-- Existing invitation/account deletion locking remains unchanged.

create or replace function public.accept_jack_invitations(p_user_id text, p_email text)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare invitation public.jack_access_invitations; accepted integer := 0;
begin
  if p_user_id is null or p_user_id !~ '^[a-zA-Z0-9_-]{1,128}$' or p_email is null or length(p_email) > 254 then
    raise exception 'Invalid verified identity';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('jack-access:invitations', 0));
  if exists (
    select 1 from public.jack_access_deleted_accounts
    where subject_hash = encode(sha256(convert_to(p_user_id, 'UTF8')), 'hex')
  ) then
    return 0;
  end if;

  for invitation in
    select i.*
    from public.jack_access_invitations i
    join public.organizations o on o.id = i.organization_id and o.status = 'active'
    where i.email = lower(btrim(p_email))
      and i.clerk_user_id = p_user_id
      and i.status = 'pending'
      and i.expires_at > now()
    order by i.created_at, i.id
    for update of i
  loop
    update public.jack_access_invitations
    set status = 'accepted', accepted_by_user_id = p_user_id, accepted_at = now()
    where id = invitation.id;

    insert into public.jack_memberships (organization_id, user_id, role, source_invitation_id)
    values (invitation.organization_id, p_user_id, invitation.role, invitation.id)
    on conflict (organization_id, user_id) do nothing;

    -- Verified emails are processed independently by the API. Whichever order
    -- Clerk returns them in, only a newer accepted invitation may replace the
    -- current source. An inactive membership may be reactivated by any newly
    -- accepted valid invitation.
    update public.jack_memberships m
    set role = invitation.role,
        active = true,
        source_invitation_id = invitation.id,
        updated_at = now()
    where m.organization_id = invitation.organization_id
      and m.user_id = p_user_id
      and (
        m.source_invitation_id = invitation.id
        or not m.active
        or not exists (
          select 1
          from public.jack_access_invitations current_source
          where current_source.id = m.source_invitation_id
            and current_source.status = 'accepted'
            and (current_source.created_at, current_source.id)
                > (invitation.created_at, invitation.id)
        )
      );

    accepted := accepted + 1;
  end loop;
  return accepted;
end $$;

create or replace function public.revoke_jack_invitation(p_invitation_id uuid, p_actor_user_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare invitation public.jack_access_invitations;
begin
  perform pg_advisory_xact_lock(hashtextextended('jack-access:invitations', 0));
  if exists (
    select 1 from public.jack_access_deleted_accounts
    where subject_hash = encode(sha256(convert_to(p_actor_user_id, 'UTF8')), 'hex')
  ) then
    raise exception 'Account deletion prevents invitation mutation' using errcode = '42501';
  end if;

  select * into invitation
  from public.jack_access_invitations
  where id = p_invitation_id
  for update;
  if not found or invitation.status = 'revoked' then return; end if;

  update public.jack_access_invitations
  set status = 'revoked', revoked_by_user_id = p_actor_user_id
  where id = p_invitation_id;

  -- If the revoked invitation currently backs membership, preserve access when
  -- another accepted invitation for the same subject/org still authorizes it.
  update public.jack_memberships m
  set role = fallback.role,
      active = true,
      source_invitation_id = fallback.id,
      updated_at = now()
  from (
    select i.id, i.role
    from public.jack_access_invitations i
    where i.organization_id = invitation.organization_id
      and i.accepted_by_user_id = invitation.accepted_by_user_id
      and i.status = 'accepted'
    order by i.created_at desc, i.id desc
    limit 1
  ) fallback
  where m.source_invitation_id = p_invitation_id;

  -- No accepted fallback remains.
  update public.jack_memberships
  set active = false, updated_at = now()
  where source_invitation_id = p_invitation_id;
end $$;

-- Repair any pre-existing membership source deterministically. Accepted grants
-- persist independently of invitation expiry by design.
with newest as (
  select distinct on (organization_id, accepted_by_user_id)
    organization_id,
    accepted_by_user_id as user_id,
    id as source_invitation_id,
    role
  from public.jack_access_invitations
  where status = 'accepted' and accepted_by_user_id is not null
  order by organization_id, accepted_by_user_id, created_at desc, id desc
)
update public.jack_memberships m
set role = newest.role,
    active = true,
    source_invitation_id = newest.source_invitation_id,
    updated_at = now()
from newest
where m.organization_id = newest.organization_id
  and m.user_id = newest.user_id
  and (
    not m.active
    or m.source_invitation_id is distinct from newest.source_invitation_id
    or m.role is distinct from newest.role
  );

revoke all on function public.accept_jack_invitations(text,text), public.revoke_jack_invitation(uuid,text)
from public, anon, authenticated;
grant execute on function public.accept_jack_invitations(text,text), public.revoke_jack_invitation(uuid,text)
to service_role;
