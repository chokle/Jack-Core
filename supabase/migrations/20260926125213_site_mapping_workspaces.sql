-- Private Radar scan workspaces. A scan is a capture, not a published site map.
-- The API owns every read/write with the service role after checking Clerk identity
-- and site membership. Browser database roles receive no table access.

create table if not exists public.site_workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 160),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

create index if not exists site_workspaces_organization_idx
  on public.site_workspaces (organization_id, status);

create table if not exists public.site_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  site_id uuid not null,
  user_id text not null,
  role text not null check (role in ('manager', 'contributor', 'viewer')),
  active boolean not null default true,
  added_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, user_id),
  foreign key (organization_id, site_id)
    references public.site_workspaces (organization_id, id) on delete cascade
);

create index if not exists site_memberships_user_active_idx
  on public.site_memberships (user_id, active, site_id);

create table if not exists public.site_scans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  site_id uuid not null,
  uploaded_by_user_id text not null,
  object_key text not null unique,
  capture_format text not null check (capture_format = 'radar_ply_points_v1'),
  status text not null default 'pending'
    check (status in ('pending', 'uploaded', 'deleting')),
  byte_size integer check (byte_size between 1 and 26214400),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  point_count integer check (point_count between 1 and 2000000),
  created_at timestamptz not null default now(),
  uploaded_at timestamptz,
  -- Keep metadata until its private R2 object is removed explicitly.
  foreign key (organization_id, site_id)
    references public.site_workspaces (organization_id, id) on delete restrict,
  check (
    (status in ('pending', 'deleting') and uploaded_at is null)
    or (status = 'uploaded' and uploaded_at is not null)
  )
);

create index if not exists site_scans_site_created_idx
  on public.site_scans (site_id, created_at desc);
create index if not exists site_scans_pending_cleanup_idx
  on public.site_scans (created_at)
  where status in ('pending', 'deleting');

-- Account deletion uses the existing permanent write fence, so an in-flight
-- capture or membership invite cannot recreate attribution after cleanup.
-- A stale pending scan can still be marked deleting by the storage reaper.
create trigger site_scans_account_deletion_fence
  before insert or update on public.site_scans
  for each row when (new.status <> 'deleting')
  execute function public.enforce_telemetry_account_deletion_fence('uploaded_by_user_id');
create trigger site_memberships_account_deletion_fence
  before insert or update on public.site_memberships
  for each row execute function public.enforce_telemetry_account_deletion_fence('user_id');
create trigger site_memberships_adder_account_deletion_fence
  before insert or update on public.site_memberships
  for each row execute function public.enforce_telemetry_account_deletion_fence('added_by_user_id');
create trigger site_workspaces_creator_account_deletion_fence
  before insert or update on public.site_workspaces
  for each row execute function public.enforce_telemetry_account_deletion_fence('created_by_user_id');

alter table public.site_workspaces enable row level security;
alter table public.site_memberships enable row level security;
alter table public.site_scans enable row level security;
revoke all on public.site_workspaces, public.site_memberships, public.site_scans from anon, authenticated;
grant all on public.site_workspaces, public.site_memberships, public.site_scans to service_role;

notify pgrst, 'reload schema';
