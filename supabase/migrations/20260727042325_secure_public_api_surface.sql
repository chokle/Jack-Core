-- Historical Jack product tables are accessed only by the server-side
-- service-role client. Keep them out of the public Data API just like the
-- telemetry tables; application authorization remains at the API boundary.
DO $$
DECLARE
  table_name text;
  server_only_tables constant text[] := ARRAY[
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
  ];
BEGIN
  FOREACH table_name IN ARRAY server_only_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',
      table_name
    );
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', table_name);
  END LOOP;
END;
$$;

-- These semantic-search RPCs are server-internal. Pin their resolution path
-- and remove the default PUBLIC execute privilege so browser roles cannot use
-- them as an alternate product-data query surface.
ALTER FUNCTION public.match_knowledge_entries(
  vector,
  double precision,
  integer,
  text
) SET search_path = public, extensions;
ALTER FUNCTION public.match_knowledge_nodes(
  vector,
  text,
  double precision,
  integer,
  text[]
) SET search_path = public, extensions;
ALTER FUNCTION public.match_transcript_segments(
  vector,
  double precision,
  integer,
  text
) SET search_path = public, extensions;
ALTER FUNCTION public.match_videos(
  vector,
  double precision,
  integer,
  uuid
) SET search_path = public, extensions;

REVOKE ALL ON FUNCTION public.match_knowledge_entries(
  vector,
  double precision,
  integer,
  text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.match_knowledge_nodes(
  vector,
  text,
  double precision,
  integer,
  text[]
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.match_transcript_segments(
  vector,
  double precision,
  integer,
  text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.match_videos(
  vector,
  double precision,
  integer,
  uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.match_knowledge_entries(
  vector,
  double precision,
  integer,
  text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_knowledge_nodes(
  vector,
  text,
  double precision,
  integer,
  text[]
) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_transcript_segments(
  vector,
  double precision,
  integer,
  text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_videos(
  vector,
  double precision,
  integer,
  uuid
) TO service_role;

CREATE INDEX IF NOT EXISTS idx_parked_thoughts_interview_session
  ON public.parked_thoughts(interview_session_id);

NOTIFY pgrst, 'reload schema';
