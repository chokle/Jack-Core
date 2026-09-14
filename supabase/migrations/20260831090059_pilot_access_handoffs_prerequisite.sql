-- Historical prerequisite for the account-deletion fence migration at 090100.
-- Columns, constraints and index match the existing pilot handoff table, whose
-- creation was missing from the repository chain. Preserve existing rows.
create table if not exists public.pilot_access_handoffs (
  id uuid primary key default gen_random_uuid(),
  pilot_id uuid not null references public.pilots(id) on delete cascade,
  user_id text not null,
  participant_label text not null,
  access_url text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists pilot_access_handoffs_pilot_idx
  on public.pilot_access_handoffs (pilot_id, created_at desc);

-- Unlike the historical table's broad grants, use the repository's server-only
-- access model. Browser roles receive no grants or policies; service_role owns
-- API access. The following migration installs the deletion fence unchanged.
alter table public.pilot_access_handoffs enable row level security;
revoke all on table public.pilot_access_handoffs from public, anon, authenticated;
grant all on table public.pilot_access_handoffs to service_role;
