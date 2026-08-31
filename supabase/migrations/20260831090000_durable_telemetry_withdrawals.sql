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
  v_actor_hash text;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.actor_user_id, 20260831)
  );
  v_actor_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(new.actor_user_id, 'UTF8')),
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
for each row execute function public.enforce_telemetry_account_deletion_fence();

drop trigger if exists telemetry_withdrawal_jobs_account_deletion_fence
  on public.telemetry_withdrawal_jobs;
create trigger telemetry_withdrawal_jobs_account_deletion_fence
before insert on public.telemetry_withdrawal_jobs
for each row execute function public.enforce_telemetry_account_deletion_fence();

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

  insert into public.telemetry_withdrawal_jobs (
    id,
    actor_user_id,
    organization_id,
    pilot_id,
    scopes,
    consent_ids,
    epoch_consent_ids,
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

comment on table public.telemetry_withdrawal_jobs is
  'Private durable obligations that reconcile participant telemetry withdrawal cleanup after authoritative append-only consent changes.';
comment on table public.telemetry_account_deletion_fences is
  'Private SHA-256 account-deletion tombstones retained to block stale in-flight telemetry writes without retaining raw account identifiers.';
