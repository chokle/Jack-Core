-- Jack first-party pilot telemetry.
-- All tables are server-owned: the API uses SUPABASE_SERVICE_ROLE_KEY and
-- browser roles have no grants or policies. This migration does not schedule
-- cron jobs, seed memberships, or enable weekly reports.

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null check (char_length(name) between 1 and 160),
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pilots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'completed', 'archived')),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at >= starts_at)
);

create index if not exists pilots_organization_status_idx
  on public.pilots (organization_id, status);

create table if not exists public.pilot_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pilot_id uuid references public.pilots(id) on delete cascade,
  user_id text not null,
  role text not null check (role in ('tester', 'pilot_admin', 'organization_admin')),
  active boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  created_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (role = 'organization_admin' and pilot_id is null)
    or (role in ('tester', 'pilot_admin') and pilot_id is not null)
  ),
  check (valid_until is null or valid_until >= valid_from),
  unique (organization_id, pilot_id, user_id, role)
);

create index if not exists pilot_memberships_user_active_idx
  on public.pilot_memberships (user_id, active);
create index if not exists pilot_memberships_scope_active_idx
  on public.pilot_memberships (organization_id, pilot_id, active);
create index if not exists pilot_memberships_pilot_idx
  on public.pilot_memberships (pilot_id);
create unique index if not exists pilot_memberships_organization_admin_unique
  on public.pilot_memberships (organization_id, user_id, role)
  where role = 'organization_admin' and pilot_id is null;

create table if not exists public.platform_roles (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  role text not null check (role = 'platform_superadmin'),
  active boolean not null default true,
  created_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, role)
);

create table if not exists public.telemetry_consents (
  id uuid primary key default gen_random_uuid(),
  actor_user_id text not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pilot_id uuid not null references public.pilots(id) on delete cascade,
  scope text not null check (scope in ('telemetry', 'screen', 'microphone')),
  state text not null check (state in ('granted', 'declined', 'withdrawn')),
  privacy_notice_version text not null,
  consent_version text not null,
  source text not null default 'pilot_consent_dialog'
    check (source in ('pilot_consent_dialog', 'account_privacy', 'recording_dialog')),
  occurred_at timestamptz not null default now(),
  retained_until timestamptz not null default (now() + interval '24 months'),
  created_at timestamptz not null default now()
);

create index if not exists telemetry_consents_actor_scope_idx
  on public.telemetry_consents (actor_user_id, pilot_id, scope, occurred_at desc);
create index if not exists telemetry_consents_organization_idx
  on public.telemetry_consents (organization_id);
create index if not exists telemetry_consents_pilot_idx
  on public.telemetry_consents (pilot_id);
create index if not exists telemetry_consents_retention_idx
  on public.telemetry_consents (retained_until);

create table if not exists public.test_sessions (
  id uuid primary key default gen_random_uuid(),
  actor_user_id text not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pilot_id uuid not null references public.pilots(id) on delete cascade,
  app_session_id uuid not null,
  device_category text not null default 'desktop'
    check (device_category in ('desktop', 'tablet', 'mobile')),
  status text not null default 'active'
    check (status in ('active', 'completed', 'abandoned', 'expired', 'withdrawn')),
  telemetry_status text not null default 'granted'
    check (telemetry_status in ('granted', 'withdrawn')),
  telemetry_consent_id uuid not null references public.telemetry_consents(id),
  screen_consent_id uuid references public.telemetry_consents(id),
  microphone_consent_id uuid references public.telemetry_consents(id),
  screen_consent_state text not null default 'declined'
    check (screen_consent_state in ('granted', 'declined', 'withdrawn')),
  microphone_consent_state text not null default 'declined'
    check (microphone_consent_state in ('granted', 'declined', 'withdrawn')),
  onboarding_status text not null default 'not_started'
    check (onboarding_status in ('not_started', 'in_progress', 'completed', 'skipped')),
  onboarding_step integer not null default 0 check (onboarding_step between 0 and 3),
  recording_status text not null default 'not_requested'
    check (recording_status in (
      'not_requested', 'declined', 'recording', 'paused', 'uploaded',
      'failed', 'stopped', 'unavailable', 'withdrawn'
    )),
  feedback_status text not null default 'not_requested'
    check (feedback_status in ('not_requested', 'pending', 'submitted', 'failed', 'skipped')),
  question_count integer not null default 0 check (question_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  started_at timestamptz not null default now(),
  resumed_at timestamptz,
  last_activity_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  retained_until timestamptz not null default (now() + interval '90 days'),
  deletion_due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists test_sessions_one_active_per_tester_pilot
  on public.test_sessions (actor_user_id, pilot_id) where status = 'active';
create index if not exists test_sessions_scope_activity_idx
  on public.test_sessions (organization_id, pilot_id, last_activity_at desc);
create index if not exists test_sessions_pilot_idx
  on public.test_sessions (pilot_id);
create index if not exists test_sessions_telemetry_consent_idx
  on public.test_sessions (telemetry_consent_id);
create index if not exists test_sessions_screen_consent_idx
  on public.test_sessions (screen_consent_id);
create index if not exists test_sessions_microphone_consent_idx
  on public.test_sessions (microphone_consent_id);
create index if not exists test_sessions_deletion_due_idx
  on public.test_sessions (deletion_due_at) where deletion_due_at is not null;
create index if not exists test_sessions_retention_idx
  on public.test_sessions (retained_until);

create table if not exists public.test_events (
  event_id uuid primary key,
  actor_user_id text not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pilot_id uuid not null references public.pilots(id) on delete cascade,
  test_session_id uuid not null references public.test_sessions(id) on delete cascade,
  app_session_id uuid not null,
  event_type text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  surface text not null,
  route text not null,
  schema_version integer not null check (schema_version > 0),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  consent_state text not null check (consent_state = 'granted'),
  consent_id uuid not null references public.telemetry_consents(id),
  privacy_notice_version text not null,
  consent_version text not null,
  app_version text,
  deploy_version text,
  device_category text not null check (device_category in ('desktop', 'tablet', 'mobile')),
  browser_family text not null check (browser_family in ('Chrome', 'Safari', 'Edge', 'Firefox', 'Other')),
  result text not null check (result in ('success', 'failure', 'cancelled', 'unavailable')),
  correlation_id text,
  request_id text,
  dedupe_key text,
  retention_category text not null default 'raw_activity_90d'
    check (retention_category = 'raw_activity_90d'),
  retained_until timestamptz not null default (now() + interval '90 days'),
  deletion_due_at timestamptz,
  redacted_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists test_events_session_dedupe
  on public.test_events (test_session_id, dedupe_key) where dedupe_key is not null;
create index if not exists test_events_timeline_idx
  on public.test_events (organization_id, pilot_id, actor_user_id, occurred_at);
create index if not exists test_events_pilot_idx
  on public.test_events (pilot_id);
create index if not exists test_events_consent_idx
  on public.test_events (consent_id);
create index if not exists test_events_retention_idx
  on public.test_events (retained_until);
create index if not exists test_events_deletion_due_idx
  on public.test_events (deletion_due_at) where deletion_due_at is not null;

create table if not exists public.activity_ingest_failures (
  id uuid primary key default gen_random_uuid(),
  actor_user_id text,
  organization_id uuid references public.organizations(id) on delete cascade,
  pilot_id uuid references public.pilots(id) on delete cascade,
  test_session_id uuid references public.test_sessions(id) on delete cascade,
  reason_code text not null check (reason_code ~ '^[a-z0-9_]{1,64}$'),
  outcome text not null check (outcome in ('rejected', 'dropped')),
  event_count integer not null default 1 check (event_count between 1 and 1000),
  retained_until timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now()
);

create index if not exists activity_ingest_failures_scope_idx
  on public.activity_ingest_failures (organization_id, pilot_id, created_at desc);
create index if not exists activity_ingest_failures_pilot_idx
  on public.activity_ingest_failures (pilot_id);
create index if not exists activity_ingest_failures_session_idx
  on public.activity_ingest_failures (test_session_id);
create index if not exists activity_ingest_failures_retention_idx
  on public.activity_ingest_failures (retained_until);

create table if not exists public.activity_report_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pilot_id uuid not null references public.pilots(id) on delete cascade,
  requested_by_user_id text not null,
  report_type text not null check (report_type in ('pilot_summary', 'user_timeline_export')),
  status text not null default 'completed'
    check (status in ('completed', 'failed')),
  parameters jsonb not null default '{}'::jsonb
    check (jsonb_typeof(parameters) = 'object'),
  aggregate_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(aggregate_snapshot) = 'object'),
  generated_at timestamptz not null default now(),
  retained_until timestamptz not null default (now() + interval '12 months'),
  created_at timestamptz not null default now()
);

create index if not exists activity_report_runs_scope_idx
  on public.activity_report_runs (organization_id, pilot_id, generated_at desc);
create index if not exists activity_report_runs_pilot_idx
  on public.activity_report_runs (pilot_id);
create index if not exists activity_report_runs_retention_idx
  on public.activity_report_runs (retained_until);

create table if not exists public.admin_access_audit (
  id uuid primary key default gen_random_uuid(),
  actor_user_id text not null,
  target_user_id text,
  organization_id uuid references public.organizations(id) on delete set null,
  pilot_id uuid references public.pilots(id) on delete set null,
  action text not null check (action ~ '^[a-z0-9_]{1,80}$'),
  decision text not null check (decision in ('allowed', 'denied')),
  authority text check (authority in ('organization_admin', 'pilot_admin', 'platform_superadmin')),
  request_id text,
  retained_until timestamptz not null default (now() + interval '24 months'),
  created_at timestamptz not null default now()
);

create index if not exists admin_access_audit_actor_idx
  on public.admin_access_audit (actor_user_id, created_at desc);
create index if not exists admin_access_audit_organization_idx
  on public.admin_access_audit (organization_id);
create index if not exists admin_access_audit_pilot_idx
  on public.admin_access_audit (pilot_id);
create index if not exists admin_access_audit_retention_idx
  on public.admin_access_audit (retained_until);

alter table public.test_recordings
  add column if not exists organization_id uuid references public.organizations(id) on delete set null,
  add column if not exists pilot_id uuid references public.pilots(id) on delete set null,
  add column if not exists test_session_id uuid references public.test_sessions(id) on delete set null,
  add column if not exists screen_consent_id uuid references public.telemetry_consents(id) on delete set null,
  add column if not exists microphone_consent_id uuid references public.telemetry_consents(id) on delete set null,
  add column if not exists retained_until timestamptz not null default (now() + interval '30 days'),
  add column if not exists deletion_due_at timestamptz;

create index if not exists test_recordings_retention_idx
  on public.test_recordings (retained_until);
create index if not exists test_recordings_organization_idx
  on public.test_recordings (organization_id);
create index if not exists test_recordings_pilot_idx
  on public.test_recordings (pilot_id);
create index if not exists test_recordings_test_session_idx
  on public.test_recordings (test_session_id);
create index if not exists test_recordings_screen_consent_idx
  on public.test_recordings (screen_consent_id);
create index if not exists test_recordings_microphone_consent_idx
  on public.test_recordings (microphone_consent_id);
create index if not exists test_recordings_deletion_due_idx
  on public.test_recordings (deletion_due_at) where deletion_due_at is not null;

alter table public.test_feedback
  add column if not exists organization_id uuid references public.organizations(id) on delete set null,
  add column if not exists pilot_id uuid references public.pilots(id) on delete set null,
  add column if not exists test_session_id uuid references public.test_sessions(id) on delete set null,
  add column if not exists resolved_at timestamptz,
  add column if not exists retained_until timestamptz,
  add column if not exists deletion_due_at timestamptz;

create index if not exists test_feedback_scope_idx
  on public.test_feedback (organization_id, pilot_id, created_at desc);
create index if not exists test_feedback_pilot_idx
  on public.test_feedback (pilot_id);
create index if not exists test_feedback_test_session_idx
  on public.test_feedback (test_session_id);
create index if not exists test_feedback_tester_profile_idx
  on public.test_feedback (tester_profile_id);
create index if not exists test_feedback_retention_idx
  on public.test_feedback (retained_until) where retained_until is not null;

alter table public.organizations enable row level security;
alter table public.pilots enable row level security;
alter table public.pilot_memberships enable row level security;
alter table public.platform_roles enable row level security;
alter table public.telemetry_consents enable row level security;
alter table public.test_sessions enable row level security;
alter table public.test_events enable row level security;
alter table public.activity_ingest_failures enable row level security;
alter table public.activity_report_runs enable row level security;
alter table public.admin_access_audit enable row level security;

revoke all on table public.organizations from anon, authenticated;
revoke all on table public.pilots from anon, authenticated;
revoke all on table public.pilot_memberships from anon, authenticated;
revoke all on table public.platform_roles from anon, authenticated;
revoke all on table public.telemetry_consents from anon, authenticated;
revoke all on table public.test_sessions from anon, authenticated;
revoke all on table public.test_events from anon, authenticated;
revoke all on table public.activity_ingest_failures from anon, authenticated;
revoke all on table public.activity_report_runs from anon, authenticated;
revoke all on table public.admin_access_audit from anon, authenticated;

grant all on table public.organizations to service_role;
grant all on table public.pilots to service_role;
grant all on table public.pilot_memberships to service_role;
grant all on table public.platform_roles to service_role;
grant all on table public.telemetry_consents to service_role;
grant all on table public.test_sessions to service_role;
grant all on table public.test_events to service_role;
grant all on table public.activity_ingest_failures to service_role;
grant all on table public.activity_report_runs to service_role;
grant all on table public.admin_access_audit to service_role;

comment on table public.test_events is
  'Private append-only pilot activity events. Metadata is event-specific and excludes product content.';
comment on table public.telemetry_consents is
  'Append-only, versioned pilot telemetry, screen, and microphone consent audit.';
comment on table public.pilot_memberships is
  'Server-authoritative organization and pilot membership; never inferred from email domains.';
