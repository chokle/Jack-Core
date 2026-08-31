-- Durable, idempotent privacy cleanup obligations for append-only telemetry
-- withdrawals. Withdrawal authority and its exact cleanup obligation are created
-- atomically; a worker can then finish post-commit cleanup after any process crash.

-- A hashed tombstone is intentionally retained after whole-account deletion. It
-- contains no raw account identifier and prevents stale authenticated requests
-- from recreating attributable consent or cleanup rows after deletion begins.
create table if not exists public.telemetry_account_deletion_fences (
  actor_hash text primary key check (actor_hash ~ '^[0-9a-f]{64}$'),
  first_started_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now()
);

alter table public.telemetry_account_deletion_fences enable row level security;
revoke all on table public.telemetry_account_deletion_fences from public, anon, authenticated;
grant all on table public.telemetry_account_deletion_fences to service_role;

-- A database-assigned sequence makes "latest consent" total and independent of
-- caller clocks. The actor trigger below serializes inserts for the same actor.
alter table public.telemetry_consents
  add column if not exists consent_sequence bigint generated always as identity;
create index if not exists telemetry_consents_actor_latest_sequence_idx
  on public.telemetry_consents (
    actor_user_id,
    pilot_id,
    scope,
    occurred_at desc,
    consent_sequence desc
  );

create table if not exists public.telemetry_withdrawal_jobs (
  id uuid primary key,
  actor_user_id text not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pilot_id uuid not null,
  scopes text[] not null,
  consent_ids uuid[] not null,
  -- All pre-withdrawal grant IDs for each requested scope. Data rows are cleaned
  -- by this lineage rather than by a request-start clock boundary, so a delayed
  -- old-epoch write is included while a later re-grant is never touched.
  epoch_consent_ids jsonb not null default '{}'::jsonb
    check (jsonb_typeof(epoch_consent_ids) = 'object'),
  -- Exact pre-withdraw row IDs cover legacy/null-link records that cannot be
  -- selected through a consent FK. Attributable-write triggers share the actor
  -- lock, so this snapshot is a complete old-epoch boundary.
  epoch_row_ids jsonb not null default '{}'::jsonb
    check (jsonb_typeof(epoch_row_ids) = 'object'),
  withdrawn_at timestamptz not null,
  consent_retained_until timestamptz not null,
  deletion_due_at timestamptz not null,
  status text not null default 'pending'
    check (status in (
      'awaiting_consent',
      'pending',
      'processing',
      'retrying',
      'completed',
      'cancelled'
    )),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  completed_at timestamptz,
  retained_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, pilot_id)
    references public.pilots(organization_id, id) on delete cascade,
  check (
    cardinality(scopes) > 0
    and cardinality(scopes) = cardinality(consent_ids)
    and scopes <@ array['telemetry', 'screen', 'microphone']::text[]
  ),
  check (
    not ('telemetry' = any(scopes))
    or (
      'screen' = any(scopes)
      and 'microphone' = any(scopes)
    )
  )
);

create index if not exists telemetry_withdrawal_jobs_due_idx
  on public.telemetry_withdrawal_jobs (next_attempt_at)
  where status in ('awaiting_consent', 'pending', 'retrying');

create index if not exists telemetry_withdrawal_jobs_lease_idx
  on public.telemetry_withdrawal_jobs (lease_expires_at)
  where status = 'processing';

create index if not exists telemetry_withdrawal_jobs_actor_scope_idx
  on public.telemetry_withdrawal_jobs (actor_user_id, pilot_id, created_at desc);

create index if not exists telemetry_withdrawal_jobs_retention_idx
  on public.telemetry_withdrawal_jobs (retained_until)
  where retained_until is not null;

-- Also upgrades a pre-release environment that created the table from an
-- earlier draft before this migration was finalized.
alter table public.telemetry_withdrawal_jobs
  add column if not exists epoch_consent_ids jsonb not null default '{}'::jsonb;
alter table public.telemetry_withdrawal_jobs
  add column if not exists epoch_row_ids jsonb not null default '{}'::jsonb;

alter table public.telemetry_withdrawal_jobs enable row level security;
revoke all on table public.telemetry_withdrawal_jobs from public, anon, authenticated;
grant all on table public.telemetry_withdrawal_jobs to service_role;

create or replace function public.enforce_telemetry_account_deletion_fence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id text;
  v_actor_hash text;
  v_now timestamptz;
begin
  v_actor_user_id := pg_catalog.to_jsonb(new) ->> coalesce(tg_argv[0], 'actor_user_id');
  if v_actor_user_id is null or v_actor_user_id = '' then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_actor_user_id, 20260831)
  );
  v_actor_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_actor_user_id, 'UTF8')),
    'hex'
  );
  if exists (
    select 1
    from public.telemetry_account_deletion_fences fence
    where fence.actor_hash = v_actor_hash
  ) then
    raise exception 'account deletion is already in progress'
      using errcode = 'P0001';
  end if;

  -- Consent order is server-owned. A request that waited behind withdrawal
  -- cannot smuggle a stale pre-lock timestamp into a new consent epoch.
  if tg_table_name = 'telemetry_consents' and tg_op = 'INSERT' then
    v_now := pg_catalog.clock_timestamp();
    new.occurred_at := v_now;
    new.created_at := v_now;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_telemetry_account_deletion_fence()
  from public, anon, authenticated;
grant execute on function public.enforce_telemetry_account_deletion_fence()
  to service_role;

drop trigger if exists telemetry_consents_account_deletion_fence
  on public.telemetry_consents;
create trigger telemetry_consents_account_deletion_fence
before insert on public.telemetry_consents
for each row execute function public.enforce_telemetry_account_deletion_fence('actor_user_id');

drop trigger if exists telemetry_withdrawal_jobs_account_deletion_fence
  on public.telemetry_withdrawal_jobs;
create trigger telemetry_withdrawal_jobs_account_deletion_fence
before insert on public.telemetry_withdrawal_jobs
for each row execute function public.enforce_telemetry_account_deletion_fence('actor_user_id');

drop trigger if exists test_sessions_account_deletion_fence on public.test_sessions;
create trigger test_sessions_account_deletion_fence
before insert or update on public.test_sessions
for each row execute function public.enforce_telemetry_account_deletion_fence('actor_user_id');

drop trigger if exists test_events_account_deletion_fence on public.test_events;
create trigger test_events_account_deletion_fence
before insert or update on public.test_events
for each row execute function public.enforce_telemetry_account_deletion_fence('actor_user_id');

drop trigger if exists test_recordings_account_deletion_fence on public.test_recordings;
create trigger test_recordings_account_deletion_fence
before insert or update on public.test_recordings
for each row execute function public.enforce_telemetry_account_deletion_fence('tester_user_id');

drop trigger if exists test_feedback_account_deletion_fence on public.test_feedback;
create trigger test_feedback_account_deletion_fence
before insert or update on public.test_feedback
for each row execute function public.enforce_telemetry_account_deletion_fence('tester_user_id');

drop trigger if exists activity_ingest_failures_account_deletion_fence
  on public.activity_ingest_failures;
create trigger activity_ingest_failures_account_deletion_fence
before insert on public.activity_ingest_failures
for each row execute function public.enforce_telemetry_account_deletion_fence('actor_user_id');

-- VOLATILE is deliberate: an attributable write may begin before withdrawal,
-- block on the actor lock, then resume after withdrawal commits. The post-lock
-- consent read must take a fresh READ COMMITTED snapshot.
create or replace function public.telemetry_consent_is_current(
  p_actor_user_id text,
  p_organization_id uuid,
  p_pilot_id uuid,
  p_scope text,
  p_consent_id uuid
)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select coalesce((
    select consent.id = p_consent_id and consent.state = 'granted'
    from public.telemetry_consents consent
    where consent.actor_user_id = p_actor_user_id
      and consent.organization_id = p_organization_id
      and consent.pilot_id = p_pilot_id
      and consent.scope = p_scope
    order by consent.occurred_at desc, consent.consent_sequence desc
    limit 1
  ), false);
$$;

revoke all on function public.telemetry_consent_is_current(
  text, uuid, uuid, text, uuid
) from public, anon, authenticated;
grant execute on function public.telemetry_consent_is_current(
  text, uuid, uuid, text, uuid
) to service_role;

create or replace function public.telemetry_grant_is_current(
  p_actor_user_id text,
  p_organization_id uuid,
  p_pilot_id uuid
)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select coalesce((
    select consent.state = 'granted'
    from public.telemetry_consents consent
    where consent.actor_user_id = p_actor_user_id
      and consent.organization_id = p_organization_id
      and consent.pilot_id = p_pilot_id
      and consent.scope = 'telemetry'
    order by consent.occurred_at desc, consent.consent_sequence desc
    limit 1
  ), false);
$$;

revoke all on function public.telemetry_grant_is_current(text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.telemetry_grant_is_current(text, uuid, uuid)
  to service_role;

create or replace function public.enforce_current_telemetry_lineage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_actor_user_id text;
  v_organization_id uuid;
  v_pilot_id uuid;
  v_session record;
begin
  v_row := pg_catalog.to_jsonb(new);

  if tg_table_name = 'test_sessions' then
    v_actor_user_id := v_row ->> 'actor_user_id';
    v_organization_id := (v_row ->> 'organization_id')::uuid;
    v_pilot_id := (v_row ->> 'pilot_id')::uuid;
    if v_row ->> 'telemetry_status' = 'granted'
      and not public.telemetry_consent_is_current(
        v_actor_user_id, v_organization_id, v_pilot_id, 'telemetry',
        (v_row ->> 'telemetry_consent_id')::uuid
      )
    then
      raise exception 'telemetry consent is not current for session write'
        using errcode = '23514';
    end if;
    if v_row ->> 'screen_consent_state' = 'granted'
      and not public.telemetry_consent_is_current(
        v_actor_user_id, v_organization_id, v_pilot_id, 'screen',
        (v_row ->> 'screen_consent_id')::uuid
      )
    then
      raise exception 'screen consent is not current for session write'
        using errcode = '23514';
    end if;
    if v_row ->> 'microphone_consent_state' = 'granted'
      and not public.telemetry_consent_is_current(
        v_actor_user_id, v_organization_id, v_pilot_id, 'microphone',
        (v_row ->> 'microphone_consent_id')::uuid
      )
    then
      raise exception 'microphone consent is not current for session write'
        using errcode = '23514';
    end if;

  elsif tg_table_name = 'test_events' then
    if v_row ->> 'redacted_at' is null
      and not public.telemetry_consent_is_current(
        v_row ->> 'actor_user_id',
        (v_row ->> 'organization_id')::uuid,
        (v_row ->> 'pilot_id')::uuid,
        'telemetry',
        (v_row ->> 'consent_id')::uuid
      )
    then
      raise exception 'telemetry consent is not current for event write'
        using errcode = '23514';
    end if;

  elsif tg_table_name = 'test_recordings' then
    -- Privacy cleanup may set deletion_due_at using old lineage. Any ordinary
    -- insert/update (including clearing that marker during stale finalization)
    -- must still carry exact current recording consent IDs.
    if v_row ->> 'organization_id' is not null
      and v_row ->> 'deletion_due_at' is null
    then
      if not public.telemetry_consent_is_current(
        v_row ->> 'tester_user_id',
        (v_row ->> 'organization_id')::uuid,
        (v_row ->> 'pilot_id')::uuid,
        'screen',
        (v_row ->> 'screen_consent_id')::uuid
      ) then
        raise exception 'screen consent is not current for recording write'
          using errcode = '23514';
      end if;
      if v_row ->> 'microphone_consent_id' is not null
        and not public.telemetry_consent_is_current(
          v_row ->> 'tester_user_id',
          (v_row ->> 'organization_id')::uuid,
          (v_row ->> 'pilot_id')::uuid,
          'microphone',
          (v_row ->> 'microphone_consent_id')::uuid
        )
      then
        raise exception 'microphone consent is not current for recording write'
          using errcode = '23514';
      end if;
    end if;

  elsif tg_table_name = 'test_feedback' then
    if v_row ->> 'pilot_id' is not null
      and v_row ->> 'deletion_due_at' is null
    then
      if v_row ->> 'test_session_id' is not null then
        select
          session.actor_user_id,
          session.organization_id,
          session.pilot_id,
          session.telemetry_consent_id
        into v_session
        from public.test_sessions session
        where session.id = (v_row ->> 'test_session_id')::uuid;
        if not found
          or v_session.actor_user_id <> v_row ->> 'tester_user_id'
          or not public.telemetry_consent_is_current(
            v_session.actor_user_id,
            v_session.organization_id,
            v_session.pilot_id,
            'telemetry',
            v_session.telemetry_consent_id
          )
        then
          raise exception 'telemetry consent is not current for feedback write'
            using errcode = '23514';
        end if;
      elsif not public.telemetry_grant_is_current(
        v_row ->> 'tester_user_id',
        (v_row ->> 'organization_id')::uuid,
        (v_row ->> 'pilot_id')::uuid
      ) then
        raise exception 'telemetry consent is not current for feedback write'
          using errcode = '23514';
      end if;
    end if;

  elsif tg_table_name = 'activity_ingest_failures' then
    if v_row ->> 'actor_user_id' is not null
      and v_row ->> 'pilot_id' is not null
      and not public.telemetry_grant_is_current(
        v_row ->> 'actor_user_id',
        (v_row ->> 'organization_id')::uuid,
        (v_row ->> 'pilot_id')::uuid
      )
    then
      raise exception 'telemetry consent is not current for ingest-failure write'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_current_telemetry_lineage()
  from public, anon, authenticated;
grant execute on function public.enforce_current_telemetry_lineage()
  to service_role;

drop trigger if exists test_sessions_current_consent_lineage on public.test_sessions;
create trigger test_sessions_current_consent_lineage
before insert or update on public.test_sessions
for each row execute function public.enforce_current_telemetry_lineage();

drop trigger if exists test_events_current_consent_lineage on public.test_events;
create trigger test_events_current_consent_lineage
before insert or update on public.test_events
for each row execute function public.enforce_current_telemetry_lineage();

drop trigger if exists test_recordings_current_consent_lineage on public.test_recordings;
create trigger test_recordings_current_consent_lineage
before insert or update on public.test_recordings
for each row execute function public.enforce_current_telemetry_lineage();

drop trigger if exists test_feedback_current_consent_lineage on public.test_feedback;
create trigger test_feedback_current_consent_lineage
before insert or update on public.test_feedback
for each row execute function public.enforce_current_telemetry_lineage();

drop trigger if exists activity_ingest_failures_current_consent_lineage
  on public.activity_ingest_failures;
create trigger activity_ingest_failures_current_consent_lineage
before insert on public.activity_ingest_failures
for each row execute function public.enforce_current_telemetry_lineage();

-- One transaction owns both the authoritative append and its cleanup obligation.
-- The actor lock also serializes this operation with whole-account deletion and
-- with ordinary consent inserts through the trigger above.
create or replace function public.append_telemetry_withdrawal(
  p_job_id uuid,
  p_actor_user_id text,
  p_organization_id uuid,
  p_pilot_id uuid,
  p_scopes text[],
  p_consent_ids uuid[],
  p_consent_retained_until timestamptz,
  p_deletion_due_at timestamptz,
  p_privacy_notice_version text,
  p_consent_version text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_withdrawn_at timestamptz;
  v_epoch_consent_ids jsonb;
  v_epoch_row_ids jsonb;
  v_actor_hash text;
begin
  if p_actor_user_id is null or p_actor_user_id = ''
    or p_scopes is null or cardinality(p_scopes) = 0
    or p_consent_ids is null
    or cardinality(p_scopes) <> cardinality(p_consent_ids)
    or exists (
      select 1
      from unnest(p_scopes) requested(scope)
      where requested.scope not in ('telemetry', 'screen', 'microphone')
    )
    or exists (
      select 1
      from unnest(p_scopes) requested(scope)
      group by requested.scope
      having count(*) > 1
    )
    or (
      'telemetry' = any(p_scopes)
      and not (
        'screen' = any(p_scopes)
        and 'microphone' = any(p_scopes)
      )
    )
  then
    raise exception 'invalid telemetry withdrawal manifest'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_actor_user_id, 20260831)
  );
  v_actor_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_actor_user_id, 'UTF8')),
    'hex'
  );
  if exists (
    select 1
    from public.telemetry_account_deletion_fences fence
    where fence.actor_hash = v_actor_hash
  ) then
    raise exception 'account deletion is already in progress'
      using errcode = 'P0001';
  end if;

  v_withdrawn_at := pg_catalog.clock_timestamp();
  select coalesce(
    pg_catalog.jsonb_object_agg(snapshot.scope, snapshot.consent_ids),
    '{}'::jsonb
  )
  into v_epoch_consent_ids
  from (
    select consent.scope, pg_catalog.jsonb_agg(
      consent.id order by consent.occurred_at, consent.id
    ) as consent_ids
    from public.telemetry_consents consent
    where consent.actor_user_id = p_actor_user_id
      and consent.organization_id = p_organization_id
      and consent.pilot_id = p_pilot_id
      and consent.scope = any(p_scopes)
      and consent.state = 'granted'
    group by consent.scope
  ) snapshot;

  select pg_catalog.jsonb_build_object(
    'activity_ingest_failures',
    coalesce((
      select pg_catalog.jsonb_agg(failure.id order by failure.id)
      from public.activity_ingest_failures failure
      where failure.actor_user_id = p_actor_user_id
        and failure.pilot_id = p_pilot_id
    ), '[]'::jsonb),
    'test_feedback',
    coalesce((
      select pg_catalog.jsonb_agg(feedback.id order by feedback.id)
      from public.test_feedback feedback
      where feedback.tester_user_id = p_actor_user_id
        and (
          feedback.pilot_id = p_pilot_id
          or feedback.test_session_id in (
            select session.id
            from public.test_sessions session
            where session.actor_user_id = p_actor_user_id
              and session.pilot_id = p_pilot_id
          )
        )
    ), '[]'::jsonb),
    'test_recordings',
    coalesce((
      select pg_catalog.jsonb_agg(recording.id order by recording.id)
      from public.test_recordings recording
      where recording.tester_user_id = p_actor_user_id
        and (
          recording.pilot_id = p_pilot_id
          or recording.test_session_id in (
            select session.id
            from public.test_sessions session
            where session.actor_user_id = p_actor_user_id
              and session.pilot_id = p_pilot_id
          )
        )
    ), '[]'::jsonb)
  )
  into v_epoch_row_ids;

  insert into public.telemetry_withdrawal_jobs (
    id,
    actor_user_id,
    organization_id,
    pilot_id,
    scopes,
    consent_ids,
    epoch_consent_ids,
    epoch_row_ids,
    withdrawn_at,
    consent_retained_until,
    deletion_due_at,
    status,
    attempts,
    next_attempt_at,
    created_at,
    updated_at
  ) values (
    p_job_id,
    p_actor_user_id,
    p_organization_id,
    p_pilot_id,
    p_scopes,
    p_consent_ids,
    v_epoch_consent_ids,
    v_epoch_row_ids,
    v_withdrawn_at,
    p_consent_retained_until,
    p_deletion_due_at,
    'pending',
    0,
    v_withdrawn_at,
    v_withdrawn_at,
    v_withdrawn_at
  );

  insert into public.telemetry_consents (
    id,
    actor_user_id,
    organization_id,
    pilot_id,
    scope,
    state,
    privacy_notice_version,
    consent_version,
    source,
    occurred_at,
    retained_until,
    created_at
  )
  select
    p_consent_ids[manifest.index],
    p_actor_user_id,
    p_organization_id,
    p_pilot_id,
    p_scopes[manifest.index],
    'withdrawn',
    p_privacy_notice_version,
    p_consent_version,
    'account_privacy',
    v_withdrawn_at,
    p_consent_retained_until,
    v_withdrawn_at
  from pg_catalog.generate_subscripts(p_scopes, 1) manifest(index);

  return v_withdrawn_at;
end;
$$;

revoke all on function public.append_telemetry_withdrawal(
  uuid, text, uuid, uuid, text[], uuid[], timestamptz, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.append_telemetry_withdrawal(
  uuid, text, uuid, uuid, text[], uuid[], timestamptz, timestamptz, text, text
) to service_role;

-- Establish the fence before any broader account cleanup. Retrying is idempotent:
-- it refreshes the attempt time and removes any job that committed first.
create or replace function public.begin_telemetry_account_deletion(
  p_actor_user_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_hash text;
begin
  if p_actor_user_id is null or p_actor_user_id = '' then
    raise exception 'invalid account deletion actor'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_actor_user_id, 20260831)
  );
  v_actor_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_actor_user_id, 'UTF8')),
    'hex'
  );

  insert into public.telemetry_account_deletion_fences (
    actor_hash,
    first_started_at,
    last_attempt_at
  ) values (
    v_actor_hash,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  )
  on conflict (actor_hash) do update
    set last_attempt_at = excluded.last_attempt_at;

  delete from public.telemetry_withdrawal_jobs
  where actor_user_id = p_actor_user_id;
end;
$$;

revoke all on function public.begin_telemetry_account_deletion(text)
  from public, anon, authenticated;
grant execute on function public.begin_telemetry_account_deletion(text)
  to service_role;

-- Finish only after dependent event/session/recording rows are gone. The fence
-- remains permanent, and re-locking plus a second job delete closes every race.
create or replace function public.finish_telemetry_account_deletion(
  p_actor_user_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_hash text;
begin
  if p_actor_user_id is null or p_actor_user_id = '' then
    raise exception 'invalid account deletion actor'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_actor_user_id, 20260831)
  );
  v_actor_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_actor_user_id, 'UTF8')),
    'hex'
  );
  if not exists (
    select 1
    from public.telemetry_account_deletion_fences fence
    where fence.actor_hash = v_actor_hash
  ) then
    raise exception 'account deletion fence was not established'
      using errcode = 'P0001';
  end if;

  delete from public.telemetry_withdrawal_jobs
  where actor_user_id = p_actor_user_id;
  delete from public.telemetry_consents
  where actor_user_id = p_actor_user_id;
end;
$$;

revoke all on function public.finish_telemetry_account_deletion(text)
  from public, anon, authenticated;
grant execute on function public.finish_telemetry_account_deletion(text)
  to service_role;

comment on table public.telemetry_withdrawal_jobs is
  'Private durable obligations that reconcile participant telemetry withdrawal cleanup after authoritative append-only consent changes.';
comment on table public.telemetry_account_deletion_fences is
  'Private SHA-256 account-deletion tombstones retained to block stale in-flight telemetry writes without retaining raw account identifiers.';
