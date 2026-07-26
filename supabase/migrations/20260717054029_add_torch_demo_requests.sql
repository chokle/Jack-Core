-- Historical migration fetched from the verified production migration ledger.
-- Run after 20260701010000_command_centre_prerequisites.sql.
create table if not exists public.demo_requests (
  id uuid primary key default gen_random_uuid(),
  submitted_at timestamptz not null default now(),
  cta_source text not null check (cta_source in ('nav', 'hero', 'midpage', 'footer', 'direct')),
  full_name text not null,
  work_email text not null,
  normalized_email text not null,
  company text not null,
  company_key text not null,
  role_title text not null,
  trade_type text not null,
  team_size text,
  knowledge_challenge text,
  preferred_format text check (
    preferred_format is null
    or preferred_format in ('live_video_call', 'on_site_discussion', 'recorded_walkthrough')
  ),
  additional_context text,
  lead_status text not null default 'New' check (lead_status in (
    'New',
    'Contacted',
    'Demo scheduled',
    'Demo completed',
    'Pilot discussion',
    'Pilot proposed',
    'Closed',
    'Not currently qualified'
  )),
  dedupe_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_demo_requests_submitted_at
  on public.demo_requests (submitted_at desc);
create index if not exists idx_demo_requests_email_submitted
  on public.demo_requests (normalized_email, submitted_at desc);
create index if not exists idx_demo_requests_status
  on public.demo_requests (lead_status, submitted_at desc);

alter table public.demo_requests enable row level security;
revoke all on table public.demo_requests from anon, authenticated;
grant select, insert, update on table public.demo_requests to service_role;
grant select, insert, update on table public.command_centre_state to service_role;

create schema if not exists private;
revoke all on schema private from public;

create or replace function private.sync_demo_request_to_command_centre()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  lead_payload jsonb;
begin
  lead_payload := jsonb_build_object(
    'id', 'demo-' || new.id::text,
    'companyName', new.company,
    'domain', '',
    'tradeCategory', new.trade_type,
    'province', '',
    'city', '',
    'companySize', coalesce(new.team_size, ''),
    'unionStatus', '',
    'website', '',
    'contactPerson', new.full_name,
    'roleTitle', new.role_title,
    'email', new.work_email,
    'phone', '',
    'linkedin', '',
    'icpFitScore', 0,
    'source', 'Website demo request (' || new.cta_source || ')',
    'status', new.lead_status,
    'notes', concat_ws(E'\n',
      case when new.knowledge_challenge is not null then 'Challenge: ' || new.knowledge_challenge end,
      case when new.additional_context is not null then 'Context: ' || new.additional_context end
    ),
    'lastContacted', '',
    'nextFollowUp', '',
    'linkedPlaybookRun', '',
    'inboundType', 'demo_request',
    'demoRequestId', new.id::text,
    'preferredDemoFormat', coalesce(new.preferred_format, ''),
    'submittedAt', new.submitted_at
  );

  insert into public.command_centre_state (key, value, updated_at)
  values (
    'operational_state',
    jsonb_build_object('leads', jsonb_build_array(lead_payload)),
    now()
  )
  on conflict (key) do update
  set value = jsonb_set(
        case
          when jsonb_typeof(public.command_centre_state.value) = 'object'
            then public.command_centre_state.value
          else '{}'::jsonb
        end,
        '{leads}',
        jsonb_build_array(lead_payload) || case
          when jsonb_typeof(public.command_centre_state.value -> 'leads') = 'array'
            then public.command_centre_state.value -> 'leads'
          else '[]'::jsonb
        end,
        true
      ),
      updated_at = now();

  return new;
end;
$function$;

drop trigger if exists demo_requests_sync_command_centre on public.demo_requests;
create trigger demo_requests_sync_command_centre
after insert on public.demo_requests
for each row execute function private.sync_demo_request_to_command_centre();
