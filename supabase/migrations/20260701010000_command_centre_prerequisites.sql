-- Historical prerequisites for migrations already recorded on the shared
-- production project. Server-side access only; no browser grants or policies.
create table if not exists public.command_centre_playbook_runs (
  id text primary key,
  playbook_name text not null,
  trigger_source text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null check (status in ('pending', 'running', 'completed', 'failed')),
  owner text,
  inputs jsonb not null default '{}'::jsonb,
  outputs jsonb not null default '{}'::jsonb,
  outcome_score jsonb not null default '{}'::jsonb,
  next_action text,
  linked_item jsonb not null default '{}'::jsonb,
  notes text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.command_centre_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists idx_command_centre_playbook_runs_started
  on public.command_centre_playbook_runs (started_at desc);
create index if not exists idx_command_centre_playbook_runs_status
  on public.command_centre_playbook_runs (status);

alter table public.command_centre_playbook_runs enable row level security;
alter table public.command_centre_state enable row level security;
revoke all on table public.command_centre_playbook_runs from anon, authenticated;
revoke all on table public.command_centre_state from anon, authenticated;
grant all on table public.command_centre_playbook_runs to service_role;
grant all on table public.command_centre_state to service_role;
