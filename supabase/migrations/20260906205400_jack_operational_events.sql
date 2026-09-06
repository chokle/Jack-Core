-- One operational journal. Reuses existing pilot session, consent, retention and
-- account-deletion fences; contains no transcripts, answers or coordinates.
create sequence public.jack_operational_event_sequence;
create table public.jack_operational_events (
  event_id uuid primary key,
  sequence bigint not null unique,
  actor_user_id text not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pilot_id uuid not null,
  test_session_id uuid not null references public.test_sessions(id) on delete cascade,
  consent_id uuid not null references public.telemetry_consents(id) on delete cascade,
  site_id text,
  crew_id text,
  event jsonb not null check (jsonb_typeof(event) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  retained_until timestamptz not null default (now() + interval '90 days'),
  foreign key (organization_id, pilot_id) references public.pilots(organization_id, id) on delete cascade,
  -- No site/crew membership adapter has been authorized yet.
  check (site_id is null and crew_id is null)
);
alter sequence public.jack_operational_event_sequence owned by public.jack_operational_events.sequence;
create index jack_operational_stream_idx on public.jack_operational_events
  (organization_id, pilot_id, actor_user_id, test_session_id, sequence);
create index jack_operational_retention_idx on public.jack_operational_events (retained_until);
alter table public.jack_operational_events enable row level security;
revoke all on public.jack_operational_events from public, anon, authenticated;
revoke all on public.jack_operational_events from service_role;
revoke all on sequence public.jack_operational_event_sequence from public, anon, authenticated;
grant select, insert, delete on public.jack_operational_events to service_role;
grant usage on sequence public.jack_operational_event_sequence to service_role;

create function public.validate_jack_operational_event() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if not public.telemetry_consent_is_current(new.actor_user_id, new.organization_id,
    new.pilot_id, 'telemetry', new.consent_id) then
    raise exception 'Current operational telemetry consent required' using errcode = '23514';
  end if;
  if not exists (select 1 from public.test_sessions s
    where s.id = new.test_session_id and s.actor_user_id = new.actor_user_id
      and s.organization_id = new.organization_id and s.pilot_id = new.pilot_id
      and s.telemetry_consent_id = new.consent_id and s.telemetry_status = 'granted'
      and s.status = 'active') then
    raise exception 'Operational session scope mismatch' using errcode = '23514';
  end if;
  if not exists (select 1 from public.pilot_memberships m
    where m.user_id = new.actor_user_id and m.organization_id = new.organization_id
      and m.pilot_id = new.pilot_id and m.role = 'tester' and m.active
      and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())) then
    raise exception 'Active scoped operational membership required' using errcode = '23514';
  end if;
  if new.event ->> 'version' is distinct from '1'
    or new.event ->> 'id' is distinct from new.event_id::text
    or new.event ->> 'sessionId' is distinct from new.test_session_id::text
    or new.event #>> '{scope,userId}' is distinct from new.actor_user_id
    or new.event #>> '{scope,organizationId}' is distinct from new.organization_id::text
    or new.event #>> '{scope,siteId}' is not null or new.event ->> 'crewId' is not null then
    raise exception 'Operational event provenance mismatch' using errcode = '23514';
  end if;
  -- Runs after the existing actor fence acquires the withdrawal/deletion lock.
  -- Sequence allocation is therefore ordered by committed actor stream writes.
  new.sequence := nextval('public.jack_operational_event_sequence'::regclass);
  new.event := jsonb_set(new.event, '{sequence}', to_jsonb(new.sequence));
  return new;
end;
$$;
revoke all on function public.validate_jack_operational_event() from public, anon, authenticated;
create trigger a_jack_operational_account_fence before insert on public.jack_operational_events
  for each row execute function public.enforce_telemetry_account_deletion_fence('actor_user_id');
create trigger b_jack_operational_validate before insert on public.jack_operational_events
  for each row execute function public.validate_jack_operational_event();

create function public.purge_jack_operational_consent() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.scope = 'telemetry' and new.state <> 'granted' then
    delete from public.jack_operational_events where actor_user_id = new.actor_user_id
      and organization_id = new.organization_id and pilot_id = new.pilot_id;
  end if;
  return new;
end;
$$;
revoke all on function public.purge_jack_operational_consent() from public, anon, authenticated;
create trigger jack_operational_consent_purge after insert on public.telemetry_consents
  for each row execute function public.purge_jack_operational_consent();

create function public.purge_jack_operational_account() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.jack_operational_events where
    encode(sha256(convert_to(actor_user_id, 'UTF8')), 'hex') = new.actor_hash;
  return new;
end;
$$;
revoke all on function public.purge_jack_operational_account() from public, anon, authenticated;
create trigger jack_operational_account_purge after insert on public.telemetry_account_deletion_fences
  for each row execute function public.purge_jack_operational_account();
