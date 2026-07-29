-- Local-only structural fixture. Never run against production.
--
-- Apply after the first five migration files have been executed in a
-- disposable database. It recreates the material catalog differences observed
-- in production without copying production content.

\if :{?PR17_LOCAL_REHEARSAL}
  select :'PR17_LOCAL_REHEARSAL' = 'jack-pr17-disposable-only'
    as pr17_fixture_authorized
  \gset
\else
  \quit
\endif

\if :pr17_fixture_authorized
\else
  \quit
\endif

begin;

do $local_only$
begin
  if inet_server_addr() is not null
    and inet_server_addr() not in ('127.0.0.1'::inet, '::1'::inet) then
    raise exception
      'PR17_FIXTURE_SAFETY: database server is not local: %',
      inet_server_addr();
  end if;
end;
$local_only$;

drop table if exists public.test_feedback cascade;

alter table public.videos alter column status set default 'pending';

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
    and v.status = 'ready'
  order by v.embedding <=> query_embedding
  limit match_count;
end;
$function$;

alter table public.knowledge_edges
  drop constraint if exists knowledge_edges_kind_check;
alter table public.knowledge_edges
  add constraint knowledge_edges_kind_check check (
    kind in ('core', 'topic', 'competency', 'video', 'mentor', 'knowledge')
  );

grant all on table public.command_centre_playbook_runs to anon, authenticated;
grant all on table public.command_centre_state to anon, authenticated;

do $server_table_rls$
declare
  table_name text;
begin
  foreach table_name in array array[
    'chat_messages',
    'competencies',
    'interview_answers',
    'interview_sessions',
    'knowledge_candidates',
    'knowledge_edges',
    'knowledge_entries',
    'knowledge_nodes',
    'knowledge_write_log',
    'mentor_profiles',
    'parked_thoughts',
    'transcript_segments',
    'videos'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
  end loop;
end;
$server_table_rls$;

-- Synthetic structural state representing legitimate pre-release records.
insert into public.videos (id, title, status)
values (
  '83333333-3333-4333-8333-333333333333',
  'PR17 synthetic retained video',
  'completed'
);

insert into public.knowledge_nodes (id, kind, label, trade)
values
  ('pr17:existing-source', 'concept', 'Synthetic existing source', 'Welder'),
  ('pr17:existing-target', 'concept', 'Synthetic existing target', 'Welder');

insert into public.knowledge_edges (id, source_id, target_id, kind)
values (
  'pr17:existing-edge',
  'pr17:existing-source',
  'pr17:existing-target',
  'knowledge'
);

commit;
