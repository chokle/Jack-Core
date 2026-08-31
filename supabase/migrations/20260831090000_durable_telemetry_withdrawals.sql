-- Durable, idempotent privacy cleanup obligations for append-only telemetry
-- withdrawals. The API writes one obligation before it appends the exact
-- authoritative withdrawal consent IDs; the reconciler validates that manifest
-- before changing participant data.
create table if not exists public.telemetry_withdrawal_jobs (
  id uuid primary key,
  actor_user_id text not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pilot_id uuid not null,
  scopes text[] not null,
  consent_ids uuid[] not null,
  withdrawn_at timestamptz not null,
  consent_retained_until timestamptz not null,
  deletion_due_at timestamptz not null,
  status text not null default 'awaiting_consent'
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

comment on table public.telemetry_withdrawal_jobs is
  'Private durable obligations that reconcile participant telemetry withdrawal cleanup after authoritative append-only consent changes.';
