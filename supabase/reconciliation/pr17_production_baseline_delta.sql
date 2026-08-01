-- PR #17 production baseline convergence.
--
-- Run only after a verified backup and only against the explicitly approved
-- production database. This script is transactional and contains no ledger
-- writes. It converges the material production differences required before
-- 20260701000000 can be recorded as represented.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '5min';

do $preconditions$
declare
  unexpected_statuses text;
begin
  if to_regclass('public.videos') is null
    or to_regclass('public.transcript_segments') is null
    or to_regclass('public.knowledge_edges') is null
    or to_regclass('public.mentor_profiles') is null then
    raise exception 'PR17_BASELINE_PRECONDITION: required baseline tables are missing';
  end if;

  select string_agg(status, ', ' order by status)
    into unexpected_statuses
  from (
    select distinct status
    from public.videos
    where status not in (
      'queued', 'uploading', 'uploaded', 'transcribing', 'analyzing',
      'indexing', 'completed', 'failed', 'retrying'
    )
  ) statuses;

  if unexpected_statuses is not null then
    raise exception
      'PR17_BASELINE_PRECONDITION: unsupported video statuses: %',
      unexpected_statuses;
  end if;

  if exists (
    select 1
    from public.knowledge_edges
    where kind not in (
      'core', 'topic', 'competency', 'video', 'mentor',
      'contributor', 'knowledge'
    )
  ) then
    raise exception 'PR17_BASELINE_PRECONDITION: unsupported knowledge edge kinds exist';
  end if;
end;
$preconditions$;

-- This is intentionally identical to 20260724091752. Running that later
-- remains a no-op and records its independent migration version.
create table if not exists public.test_feedback (
  id uuid primary key default gen_random_uuid(),
  tester_user_id text not null,
  tester_email text,
  tester_name text,
  tester_profile_id uuid references public.mentor_profiles(id) on delete set null,
  tester_trade text,
  session_id text not null,
  features_used jsonb not null default '[]'::jsonb,
  device_category text not null
    check (device_category in ('desktop', 'tablet', 'mobile')),
  trigger text not null
    check (trigger in ('logout', 'interview_complete', 'ask_jack_complete', 'desktop_exit')),
  goal text not null,
  useful text not null
    check (useful in ('yes', 'partly', 'no')),
  shortfall text not null,
  adoption_need text not null,
  additional text,
  app_version text,
  status text not null default 'new'
    check (status in ('new', 'reviewed', 'actioned', 'archived')),
  admin_notes text,
  reviewed_by text,
  reviewed_at timestamptz,
  notification_status text not null default 'pending'
    check (notification_status in ('pending', 'sent', 'failed', 'retrying')),
  notification_attempts integer not null default 0,
  notification_last_error text,
  notification_last_attempt_at timestamptz,
  notification_next_attempt_at timestamptz,
  notification_sent_at timestamptz,
  notification_provider_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_test_feedback_created_at
  on public.test_feedback (created_at desc);
create index if not exists idx_test_feedback_tester_user_id
  on public.test_feedback (tester_user_id);
create index if not exists idx_test_feedback_session_id
  on public.test_feedback (session_id);
create index if not exists idx_test_feedback_review_status
  on public.test_feedback (status, created_at desc);
create index if not exists idx_test_feedback_notification
  on public.test_feedback (notification_status, notification_next_attempt_at);

alter table public.test_feedback enable row level security;
revoke all on table public.test_feedback from public, anon, authenticated;
grant all on table public.test_feedback to service_role;

comment on table public.test_feedback is
  'Private operational feedback from explicitly consenting Jack user testers.';

alter table public.videos alter column status set default 'queued';

do $video_status_constraint$
declare
  expected_definition constant text :=
    'CHECK (status = ANY (ARRAY[''queued''::text, ''uploading''::text, ''uploaded''::text, ''transcribing''::text, ''analyzing''::text, ''indexing''::text, ''completed''::text, ''failed''::text, ''retrying''::text]))';
  actual_definition text;
begin
  select pg_get_constraintdef(oid, true)
    into actual_definition
  from pg_constraint
  where conrelid = 'public.videos'::regclass
    and conname = 'videos_status_check';

  if actual_definition is distinct from expected_definition then
    alter table public.videos drop constraint if exists videos_status_check;
    alter table public.videos
      add constraint videos_status_check check (
        status in (
          'queued', 'uploading', 'uploaded', 'transcribing', 'analyzing',
          'indexing', 'completed', 'failed', 'retrying'
        )
      ) not valid;
    alter table public.videos validate constraint videos_status_check;
  end if;
end;
$video_status_constraint$;

create or replace function public.match_transcript_segments(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  filter_trade text default null
)
returns table (
  id uuid,
  video_id uuid,
  video_title text,
  thumbnail_url text,
  trade text,
  start_time float,
  end_time float,
  text text,
  similarity float
)
language plpgsql
as $function$
begin
  set local hnsw.ef_search = 100;
  return query
  select
    ts.id,
    ts.video_id,
    v.title as video_title,
    v.thumbnail_url,
    v.trade,
    ts.start_time,
    ts.end_time,
    ts.text,
    1 - (ts.embedding <=> query_embedding) as similarity
  from public.transcript_segments ts
  join public.videos v on v.id = ts.video_id
  where ts.embedding is not null
    and 1 - (ts.embedding <=> query_embedding) > match_threshold
    and (filter_trade is null or v.trade = filter_trade)
  order by ts.embedding <=> query_embedding
  limit match_count;
end;
$function$;

create or replace function public.match_videos(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  exclude_id uuid default null
)
returns table (
  id uuid,
  title text,
  description text,
  trade text,
  thumbnail_url text,
  video_url text,
  duration float,
  status text,
  competency_codes text[],
  tags text[],
  created_at timestamptz,
  updated_at timestamptz,
  similarity float
)
language plpgsql
as $function$
begin
  return query
  select
    v.id,
    v.title,
    v.description,
    v.trade,
    v.thumbnail_url,
    v.video_url,
    v.duration,
    v.status,
    v.competency_codes,
    v.tags,
    v.created_at,
    v.updated_at,
    1 - (v.embedding <=> query_embedding) as similarity
  from public.videos v
  where v.embedding is not null
    and 1 - (v.embedding <=> query_embedding) > match_threshold
    and (exclude_id is null or v.id != exclude_id)
    and v.status = 'completed'
  order by v.embedding <=> query_embedding
  limit match_count;
end;
$function$;

do $edge_constraint$
declare
  expected_definition constant text :=
    'CHECK (kind = ANY (ARRAY[''core''::text, ''topic''::text, ''competency''::text, ''video''::text, ''mentor''::text, ''contributor''::text, ''knowledge''::text]))';
  actual_definition text;
begin
  select pg_get_constraintdef(oid, true)
    into actual_definition
  from pg_constraint
  where conrelid = 'public.knowledge_edges'::regclass
    and conname = 'knowledge_edges_kind_check';

  if actual_definition is distinct from expected_definition then
    alter table public.knowledge_edges
      drop constraint if exists knowledge_edges_kind_check;
    alter table public.knowledge_edges
      add constraint knowledge_edges_kind_check check (
        kind in (
          'core', 'topic', 'competency', 'video', 'mentor',
          'contributor', 'knowledge'
        )
      ) not valid;
    alter table public.knowledge_edges
      validate constraint knowledge_edges_kind_check;
  end if;
end;
$edge_constraint$;

do $postconditions$
declare
  video_default text;
  video_function_body text;
  transcript_function_body text;
  edge_constraint_definition text;
begin
  if to_regclass('public.test_feedback') is null then
    raise exception 'PR17_BASELINE_POSTCONDITION: test_feedback was not created';
  end if;

  if not (
    select relrowsecurity
    from pg_class
    where oid = 'public.test_feedback'::regclass
  ) then
    raise exception 'PR17_BASELINE_POSTCONDITION: test_feedback RLS is disabled';
  end if;

  if has_table_privilege('anon', 'public.test_feedback', 'select')
    or has_table_privilege('authenticated', 'public.test_feedback', 'select') then
    raise exception 'PR17_BASELINE_POSTCONDITION: browser test_feedback access remains';
  end if;

  if not has_table_privilege(
    'service_role',
    'public.test_feedback',
    'select, insert, update, delete'
  ) then
    raise exception 'PR17_BASELINE_POSTCONDITION: service role access is incomplete';
  end if;

  select pg_get_expr(ad.adbin, ad.adrelid)
    into video_default
  from pg_attribute a
  join pg_attrdef ad
    on ad.adrelid = a.attrelid
   and ad.adnum = a.attnum
  where a.attrelid = 'public.videos'::regclass
    and a.attname = 'status';

  if video_default is distinct from '''queued''::text' then
    raise exception
      'PR17_BASELINE_POSTCONDITION: videos.status default is %',
      video_default;
  end if;

  if exists (
    select 1
    from public.videos
    where status in ('pending', 'ready', 'error')
  ) then
    raise exception 'PR17_BASELINE_POSTCONDITION: retired video statuses remain';
  end if;

  select prosrc
    into video_function_body
  from pg_proc
  where oid = 'public.match_videos(vector,double precision,integer,uuid)'::regprocedure;

  if position('v.status = ''completed''' in video_function_body) = 0 then
    raise exception 'PR17_BASELINE_POSTCONDITION: match_videos does not use completed';
  end if;

  select prosrc
    into transcript_function_body
  from pg_proc
  where oid =
    'public.match_transcript_segments(vector,double precision,integer,text)'::regprocedure;

  if position('hnsw.ef_search = 100' in transcript_function_body) = 0 then
    raise exception
      'PR17_BASELINE_POSTCONDITION: transcript HNSW search depth is not pinned';
  end if;

  select pg_get_constraintdef(oid, true)
    into edge_constraint_definition
  from pg_constraint
  where conrelid = 'public.knowledge_edges'::regclass
    and conname = 'knowledge_edges_kind_check';

  if position('''contributor''::text' in edge_constraint_definition) = 0 then
    raise exception
      'PR17_BASELINE_POSTCONDITION: contributor edge kind remains unavailable';
  end if;
end;
$postconditions$;

commit;
