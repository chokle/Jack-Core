-- Jack — AI Trade Intelligence Engine — Supabase schema
-- Canonical source of truth. Applied automatically by scripts/src/setup-supabase.ts
-- (when SUPABASE_DB_URL is set) and also safe to paste manually into
-- Supabase Dashboard → SQL Editor → New query → Run.
-- Every statement is idempotent, so re-running is safe.

-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Videos table
CREATE TABLE IF NOT EXISTS videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  trade TEXT,
  thumbnail_url TEXT,
  video_url TEXT,
  duration FLOAT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','transcribing','analyzing','ready','error')),
  transcript TEXT,
  analysis TEXT,
  key_points TEXT[] DEFAULT '{}',
  competency_codes TEXT[] DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);

-- Transcript segments table
CREATE TABLE IF NOT EXISTS transcript_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_time FLOAT NOT NULL,
  end_time FLOAT NOT NULL,
  text TEXT NOT NULL,
  confidence FLOAT,
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Red Seal competencies table
CREATE TABLE IF NOT EXISTS competencies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  trade TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chat messages table
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  citations JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_trade ON videos(trade);
CREATE INDEX IF NOT EXISTS idx_segments_video_id ON transcript_segments(video_id);
CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id);

-- match_transcript_segments function (for semantic search + Ask Jack)
CREATE OR REPLACE FUNCTION match_transcript_segments(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  filter_trade text DEFAULT NULL
)
RETURNS TABLE (
  id uuid, video_id uuid, video_title text, thumbnail_url text, trade text,
  start_time float, end_time float, text text, similarity float
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT ts.id, ts.video_id, v.title AS video_title, v.thumbnail_url, v.trade,
    ts.start_time, ts.end_time, ts.text,
    1 - (ts.embedding <=> query_embedding) AS similarity
  FROM transcript_segments ts
  JOIN videos v ON v.id = ts.video_id
  WHERE ts.embedding IS NOT NULL
    AND 1 - (ts.embedding <=> query_embedding) > match_threshold
    AND (filter_trade IS NULL OR v.trade = filter_trade)
  ORDER BY ts.embedding <=> query_embedding LIMIT match_count;
END; $$;

-- match_videos function (for related videos)
CREATE OR REPLACE FUNCTION match_videos(
  query_embedding vector(1536), match_threshold float, match_count int, exclude_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid, title text, description text, trade text, thumbnail_url text, video_url text,
  duration float, status text, competency_codes text[], tags text[],
  created_at timestamptz, updated_at timestamptz, similarity float
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT v.id, v.title, v.description, v.trade, v.thumbnail_url, v.video_url,
    v.duration, v.status, v.competency_codes, v.tags, v.created_at, v.updated_at,
    1 - (v.embedding <=> query_embedding) AS similarity
  FROM videos v
  WHERE v.embedding IS NOT NULL
    AND 1 - (v.embedding <=> query_embedding) > match_threshold
    AND (exclude_id IS NULL OR v.id != exclude_id)
    AND v.status = 'ready'
  ORDER BY v.embedding <=> query_embedding LIMIT match_count;
END; $$;

-- Seed Red Seal competencies
INSERT INTO competencies (code, name, trade) VALUES
  ('E-1','Occupational Skills','Electrician'),('E-2','Electrical Theory','Electrician'),
  ('E-3','Wiring Methods and Installation','Electrician'),('E-4','Distribution Equipment','Electrician'),
  ('E-5','Branch Circuits and Feeders','Electrician'),('E-6','Service Entrance Equipment','Electrician'),
  ('E-7','Low-Voltage Systems','Electrician'),('E-8','Motor Controls','Electrician'),
  ('P-1','Occupational Skills','Plumber'),('P-2','Drainage, Waste and Vent Systems','Plumber'),
  ('P-3','Water Supply Systems','Plumber'),('P-4','Sanitation Systems','Plumber'),
  ('P-5','Heating Systems','Plumber'),('P-6','Fuel Gas Piping','Plumber'),
  ('C-1','Occupational Skills','Carpenter'),('C-2','Form Work','Carpenter'),
  ('C-3','Framing','Carpenter'),('C-4','Exterior Finishing','Carpenter'),
  ('C-5','Interior Finishing','Carpenter'),('C-6','Cabinetry','Carpenter'),
  ('W-1','Occupational Skills','Welder'),('W-2','Shielded Metal Arc Welding','Welder'),
  ('W-3','Gas Metal Arc Welding','Welder'),('W-4','Flux Cored Arc Welding','Welder'),
  ('W-5','Gas Tungsten Arc Welding','Welder'),('W-6','Oxy-Fuel Cutting and Welding','Welder'),
  ('HV-1','Occupational Skills','HVAC/R Technician'),('HV-2','Refrigeration Systems','HVAC/R Technician'),
  ('HV-3','Air Conditioning Systems','HVAC/R Technician'),('HV-4','Heating Systems','HVAC/R Technician')
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- Living Memory knowledge graph — persistent nodes & edges
-- ============================================================================
-- A persisted mirror of what Jack knows: a central core, one topic hub per
-- trade, the seeded Red Seal competencies, and one node per ingested video.
-- IDs are deterministic ('__jack__', 'topic:<trade>', 'comp:<code>',
-- 'video:<uuid>') so every write is an idempotent upsert — re-processing or
-- "merging" knowledge collapses onto the same node instead of duplicating it.

CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('core','topic','competency','video')),
  label TEXT NOT NULL,
  trade TEXT,
  ref_id TEXT,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('core','topic','competency','video')),
  weight FLOAT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, target_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_kind ON knowledge_nodes(kind);
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_trade ON knowledge_nodes(trade);
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_source ON knowledge_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_target ON knowledge_edges(target_id);

-- Seed the base graph from the seeded competencies (idempotent). Video nodes
-- and their edges are added at runtime by the API as videos are processed.
INSERT INTO knowledge_nodes (id, kind, label)
VALUES ('__jack__', 'core', 'JACK')
ON CONFLICT (id) DO NOTHING;

INSERT INTO knowledge_nodes (id, kind, label, trade)
SELECT 'topic:' || t.trade, 'topic', t.trade, t.trade
FROM (SELECT DISTINCT trade FROM competencies) t
ON CONFLICT (id) DO NOTHING;

INSERT INTO knowledge_nodes (id, kind, label, trade, ref_id, meta)
SELECT 'comp:' || c.code, 'competency', c.code, c.trade, c.code,
  jsonb_build_object('code', c.code, 'trade', c.trade,
    'description', COALESCE(c.description, c.name))
FROM competencies c
ON CONFLICT (id) DO NOTHING;

INSERT INTO knowledge_edges (id, source_id, target_id, kind)
SELECT 'e:__jack__->topic:' || t.trade, '__jack__', 'topic:' || t.trade, 'topic'
FROM (SELECT DISTINCT trade FROM competencies) t
ON CONFLICT (id) DO NOTHING;

INSERT INTO knowledge_edges (id, source_id, target_id, kind)
SELECT 'e:topic:' || c.trade || '->comp:' || c.code, 'topic:' || c.trade, 'comp:' || c.code, 'competency'
FROM competencies c
ON CONFLICT (id) DO NOTHING;

-- Create the public storage bucket for video uploads
INSERT INTO storage.buckets (id, name, public)
VALUES ('jack-videos', 'jack-videos', true)
ON CONFLICT (id) DO NOTHING;
