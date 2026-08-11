-- Optional participant consent for scoped administrator review of canonical
-- Ask Jack conversation history. Conversation text stays only in chat_messages;
-- this table is an append-only participant/scope consent audit.

create table public.conversation_review_consents (
  id uuid primary key default gen_random_uuid(),
  actor_user_id text not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pilot_id uuid not null,
  chat_session_id text not null,
  state text not null check (state in ('granted', 'declined', 'withdrawn')),
  privacy_notice_version text not null,
  consent_version text not null,
  source text not null default 'pilot_consent_addendum'
    check (source in ('pilot_consent_addendum', 'account_privacy')),
  occurred_at timestamptz not null default now(),
  retained_until timestamptz not null default (now() + interval '24 months'),
  created_at timestamptz not null default now(),
  foreign key (organization_id, pilot_id)
    references public.pilots(organization_id, id) on delete cascade
);

create index conversation_review_consents_current_idx
  on public.conversation_review_consents
    (organization_id, pilot_id, actor_user_id, occurred_at desc);
create index conversation_review_consents_chat_session_idx
  on public.conversation_review_consents
    (actor_user_id, chat_session_id, occurred_at desc);
create index conversation_review_consents_retention_idx
  on public.conversation_review_consents (retained_until);

alter table public.chat_messages
  add column organization_id uuid,
  add column pilot_id uuid,
  add column test_session_id uuid references public.test_sessions(id) on delete set null,
  add column conversation_review_consent_id uuid
    references public.conversation_review_consents(id) on delete set null,
  add constraint chat_messages_conversation_review_scope_fkey
    foreign key (organization_id, pilot_id)
      references public.pilots(organization_id, id) on delete set null,
  add constraint chat_messages_conversation_review_linkage_check
    check (
      (organization_id is null and pilot_id is null)
      or
      (organization_id is not null and pilot_id is not null)
    );

alter table public.test_sessions
  add column chat_session_id text;

create index test_sessions_chat_scope_idx
  on public.test_sessions
    (organization_id, pilot_id, actor_user_id, chat_session_id)
  where chat_session_id is not null;

create index chat_messages_conversation_review_scope_idx
  on public.chat_messages (organization_id, pilot_id, user_id, created_at desc)
  where conversation_review_consent_id is not null;

create or replace function public.validate_chat_conversation_review_linkage()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  -- Permit FK cleanup to remove expired consent/scope references without
  -- deleting canonical product history. Fresh application writes still pass
  -- through the complete linkage checks below.
  if tg_op = 'UPDATE'
    and old.conversation_review_consent_id is not null
    and (
      new.conversation_review_consent_id is null
      or new.organization_id is null
      or new.pilot_id is null
    )
  then
    return new;
  end if;

  if new.conversation_review_consent_id is null then
    if new.organization_id is not null or new.pilot_id is not null or new.test_session_id is not null then
      raise exception 'new chat scope linkage requires conversation-review consent'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if not exists (
    select 1
    from public.conversation_review_consents consent
    where consent.id = new.conversation_review_consent_id
      and consent.actor_user_id = new.user_id
      and consent.organization_id = new.organization_id
      and consent.pilot_id = new.pilot_id
      and consent.chat_session_id = new.session_id
      and consent.state = 'granted'
      and consent.id = (
        select latest.id
        from public.conversation_review_consents latest
        where latest.actor_user_id = consent.actor_user_id
          and latest.organization_id = consent.organization_id
          and latest.pilot_id = consent.pilot_id
        order by latest.occurred_at desc, latest.created_at desc, latest.id desc
        limit 1
      )
  ) then
    raise exception 'chat conversation-review consent does not match current owner and pilot scope'
      using errcode = '23514';
  end if;

  if new.test_session_id is not null and not exists (
    select 1
    from public.test_sessions session
    where session.id = new.test_session_id
      and session.actor_user_id = new.user_id
      and session.organization_id = new.organization_id
      and session.pilot_id = new.pilot_id
  ) then
    raise exception 'chat test session does not match conversation-review owner and pilot scope'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger validate_chat_conversation_review_linkage_trigger
before insert or update of user_id, organization_id, pilot_id, test_session_id,
  conversation_review_consent_id
on public.chat_messages
for each row execute function public.validate_chat_conversation_review_linkage();

alter table public.conversation_review_consents enable row level security;
revoke all on table public.conversation_review_consents from anon, authenticated;
grant all on table public.conversation_review_consents to service_role;

revoke all on function public.validate_chat_conversation_review_linkage()
  from public, anon, authenticated;
grant execute on function public.validate_chat_conversation_review_linkage() to service_role;

comment on table public.conversation_review_consents is
  'Append-only, participant-level consent for scoped admin review of canonical chat history; stores no conversation content.';
comment on column public.chat_messages.conversation_review_consent_id is
  'Consent linkage stamped on eligible canonical chat writes. Historical owner rows remain canonical and become reviewable only while the owner has current scoped consent.';
