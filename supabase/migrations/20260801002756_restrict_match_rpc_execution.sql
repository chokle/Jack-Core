-- Re-apply hard RPC execution boundaries for internal semantic-search functions.
-- This is a forward-only migration that addresses remaining public execute paths.

begin;

do $preconditions$
declare
  function_signatures constant text[] := ARRAY[
    'public.match_knowledge_entries(vector, double precision, integer, text)',
    'public.match_knowledge_nodes(vector, text, double precision, integer, text[])',
    'public.match_transcript_segments(vector, double precision, integer, text)',
    'public.match_videos(vector, double precision, integer, uuid)'
  ];
  signature text;
  proc_oid regprocedure;
  found_functions integer := 0;
  missing_functions text[] := '{}'::text[];
begin
  foreach signature in array function_signatures loop
    proc_oid := to_regprocedure(signature);
    if proc_oid is null then
      missing_functions := array_append(missing_functions, signature);
      continue;
    end if;

    if (pg_get_function_identity_arguments(proc_oid::oid) is null) then
      raise exception 'failed to read function identity for %', signature;
    end if;

    if not (
      proc_oid::oid in (
        select p.oid
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
      )
    ) then
      raise exception 'function % does not exist in public', signature;
    end if;

    found_functions := found_functions + 1;
  end loop;

  if array_length(missing_functions, 1) is not null then
    raise exception
      'missing expected RPC function signature(s): %',
      array_to_string(missing_functions, ', ');
  end if;

  if found_functions <> 4 then
    raise exception 'expected 4 internal match RPCs, found %', found_functions;
  end if;
end;
$preconditions$;

alter function public.match_knowledge_entries(
  vector,
  double precision,
  integer,
  text
) set search_path = public, extensions;

alter function public.match_knowledge_nodes(
  vector,
  text,
  double precision,
  integer,
  text[]
) set search_path = public, extensions;

alter function public.match_transcript_segments(
  vector,
  double precision,
  integer,
  text
) set search_path = public, extensions;

alter function public.match_videos(
  vector,
  double precision,
  integer,
  uuid
) set search_path = public, extensions;

revoke all on function public.match_knowledge_entries(
  vector,
  double precision,
  integer,
  text
) from public, anon, authenticated;

revoke all on function public.match_knowledge_nodes(
  vector,
  text,
  double precision,
  integer,
  text[]
) from public, anon, authenticated;

revoke all on function public.match_transcript_segments(
  vector,
  double precision,
  integer,
  text
) from public, anon, authenticated;

revoke all on function public.match_videos(
  vector,
  double precision,
  integer,
  uuid
) from public, anon, authenticated;

grant execute on function public.match_knowledge_entries(
  vector,
  double precision,
  integer,
  text
) to service_role;

grant execute on function public.match_knowledge_nodes(
  vector,
  text,
  double precision,
  integer,
  text[]
) to service_role;

grant execute on function public.match_transcript_segments(
  vector,
  double precision,
  integer,
  text
) to service_role;

grant execute on function public.match_videos(
  vector,
  double precision,
  integer,
  uuid
) to service_role;

do $postconditions$
declare
  fn_knowledge_entries regprocedure := 'public.match_knowledge_entries(vector, double precision, integer, text)';
  fn_knowledge_nodes regprocedure := 'public.match_knowledge_nodes(vector, text, double precision, integer, text[])';
  fn_transcript_segments regprocedure := 'public.match_transcript_segments(vector, double precision, integer, text)';
  fn_videos regprocedure := 'public.match_videos(vector, double precision, integer, uuid)';
begin
  if fn_knowledge_entries is null or fn_knowledge_nodes is null or fn_transcript_segments is null or fn_videos is null then
    raise exception 'postcondition function registration failed';
  end if;

  if (
    has_function_privilege(0, fn_knowledge_entries::oid, 'execute')
    or has_function_privilege(0, fn_knowledge_nodes::oid, 'execute')
    or has_function_privilege(0, fn_transcript_segments::oid, 'execute')
    or has_function_privilege(0, fn_videos::oid, 'execute')
  ) then
    raise exception 'PUBLIC still has execute on match RPCs';
  end if;

  if (
    has_function_privilege('anon', fn_knowledge_entries::oid, 'execute')
    or has_function_privilege('anon', fn_knowledge_nodes::oid, 'execute')
    or has_function_privilege('anon', fn_transcript_segments::oid, 'execute')
    or has_function_privilege('anon', fn_videos::oid, 'execute')
  ) then
    raise exception 'anon still has execute on match RPCs';
  end if;

  if (
    has_function_privilege('authenticated', fn_knowledge_entries::oid, 'execute')
    or has_function_privilege('authenticated', fn_knowledge_nodes::oid, 'execute')
    or has_function_privilege('authenticated', fn_transcript_segments::oid, 'execute')
    or has_function_privilege('authenticated', fn_videos::oid, 'execute')
  ) then
    raise exception 'authenticated still has execute on match RPCs';
  end if;

  if not (
    has_function_privilege('service_role', fn_knowledge_entries::oid, 'execute')
    and has_function_privilege('service_role', fn_knowledge_nodes::oid, 'execute')
    and has_function_privilege('service_role', fn_transcript_segments::oid, 'execute')
    and has_function_privilege('service_role', fn_videos::oid, 'execute')
  ) then
    raise exception 'service_role execute missing on one or more match RPCs';
  end if;

  if (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.oid::regprocedure = ANY (ARRAY[
        fn_knowledge_entries,
        fn_knowledge_nodes,
        fn_transcript_segments,
        fn_videos
      ])
  ) <> 4 then
    raise exception 'expected exactly four intended RPC OIDs in public';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.oid::regprocedure = ANY (ARRAY[
        fn_knowledge_entries,
        fn_knowledge_nodes,
        fn_transcript_segments,
        fn_videos
      ])
      and not (coalesce(p.proconfig, '{}'::text[]) @> ARRAY['search_path=public, extensions'])
  ) then
    raise exception 'search_path was not hardened to public, extensions on one or more match RPCs';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.oid::regprocedure = ANY (ARRAY[
        fn_knowledge_entries,
        fn_knowledge_nodes,
        fn_transcript_segments,
        fn_videos
      ])
      and prosecdef
  ) then
    raise exception 'one or more match RPCs are SECURITY DEFINER';
  end if;
end;
$postconditions$;

commit;
