-- End-of-shift closeout responses captured by participants on the same security
-- posture as pilot telemetry: server-only writes and authenticated reads through
-- service-role routes.

create table if not exists public.end_of_shift_closeouts (
  id uuid primary key default gen_random_uuid(),
  actor_user_id text not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pilot_id uuid not null,
  work_date date not null,
  shift text not null default 'day'
    check (shift in ('day', 'swing', 'night')),
  crew text,
  trade text,
  answers jsonb not null default '{}'::jsonb
    check (jsonb_typeof(answers) = 'object'),
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retained_until timestamptz not null default (now() + interval '12 months'),
  check (
    status = 'submitted'
    or (status = 'draft' and submitted_at is null)
  ),
  unique (actor_user_id, organization_id, pilot_id, work_date, shift),
  foreign key (organization_id, pilot_id)
    references public.pilots(organization_id, id) on delete cascade
);

create index if not exists end_of_shift_closeouts_scope_idx
  on public.end_of_shift_closeouts (organization_id, pilot_id, work_date desc, shift, status);
create index if not exists end_of_shift_closeouts_actor_idx
  on public.end_of_shift_closeouts (actor_user_id, work_date desc);
create index if not exists end_of_shift_closeouts_shift_idx
  on public.end_of_shift_closeouts (shift, work_date desc);
create index if not exists end_of_shift_closeouts_retention_idx
  on public.end_of_shift_closeouts (retained_until);

alter table public.end_of_shift_closeouts enable row level security;
revoke all on table public.end_of_shift_closeouts from anon, authenticated;
grant all on table public.end_of_shift_closeouts to service_role;

comment on table public.end_of_shift_closeouts
  is 'Pilot closeout submissions for participant shift end-of-shift evidence.';