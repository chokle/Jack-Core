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

-- Node kinds: the original scaffold kinds (core/topic/competency/video) plus the
-- reusable "atomic knowledge" categories distilled from video transcripts. Each
-- atomic node is one durable, reusable trade concept — never a sentence — with a
-- canonical id (k:<category>:<normalized-name>) so the same concept extracted
-- from many videos collapses onto a single shared node.
CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'core','topic','competency','video',
    'concept','tool','equipment','material','procedure',
    'hazard','slang','certification','standard','regional_term'
  )),
  label TEXT NOT NULL,
  trade TEXT,
  ref_id TEXT,
  description TEXT,
  confidence FLOAT,
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','verified','rejected')),
  -- Embedding of an atomic-knowledge concept (title + description), used by the
  -- Graph Intelligence layer to detect differently-worded duplicates of the same
  -- concept and collapse them onto one canonical node. NULL for scaffold nodes.
  embedding vector(1536),
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Edge kinds mirror the node relationships. 'knowledge' is the video -> atomic
-- knowledge provenance link (many-to-many): one video contributes many concepts,
-- and one concept accumulates many source videos over time. Per-video timestamps
-- and the per-extraction confidence for that link live in the edge `meta`.
CREATE TABLE IF NOT EXISTS knowledge_edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'core','topic','competency','video','knowledge'
  )),
  weight FLOAT NOT NULL DEFAULT 1,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, target_id, kind)
);

-- Idempotent migration for databases created before the atomic-knowledge fields
-- existed. CREATE TABLE IF NOT EXISTS above does not alter an existing table, so
-- add the new columns and broaden the CHECK constraints here. All statements are
-- safe to re-run.
ALTER TABLE knowledge_nodes ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE knowledge_nodes ADD COLUMN IF NOT EXISTS confidence FLOAT;
ALTER TABLE knowledge_nodes ADD COLUMN IF NOT EXISTS verification_status TEXT
  NOT NULL DEFAULT 'unverified';
ALTER TABLE knowledge_nodes ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE knowledge_nodes DROP CONSTRAINT IF EXISTS knowledge_nodes_kind_check;
ALTER TABLE knowledge_nodes ADD CONSTRAINT knowledge_nodes_kind_check CHECK (kind IN (
  'core','topic','competency','video',
  'concept','tool','equipment','material','procedure',
  'hazard','slang','certification','standard','regional_term'
));
ALTER TABLE knowledge_nodes DROP CONSTRAINT IF EXISTS knowledge_nodes_verification_status_check;
ALTER TABLE knowledge_nodes ADD CONSTRAINT knowledge_nodes_verification_status_check
  CHECK (verification_status IN ('unverified','verified','rejected'));

ALTER TABLE knowledge_edges ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}';
ALTER TABLE knowledge_edges DROP CONSTRAINT IF EXISTS knowledge_edges_kind_check;
ALTER TABLE knowledge_edges ADD CONSTRAINT knowledge_edges_kind_check CHECK (kind IN (
  'core','topic','competency','video','knowledge'
));

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_kind ON knowledge_nodes(kind);
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_trade ON knowledge_nodes(trade);
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_source ON knowledge_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_target ON knowledge_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_kind ON knowledge_edges(kind);

-- match_knowledge_nodes — semantic duplicate detection for the Graph Intelligence
-- layer. Given a concept embedding, return the most similar EXISTING atomic
-- knowledge nodes of the SAME category (kind) above a threshold, so a
-- differently-worded extraction of the same concept ("Arc Blow" vs "Arc Blowing")
-- collapses onto the already-persisted canonical node instead of creating a
-- near-duplicate. Only same-category nodes are compared, and the caller's own
-- deterministic id (and any ids already claimed in the current batch) are
-- excluded so a concept never matches itself.
CREATE OR REPLACE FUNCTION match_knowledge_nodes(
  query_embedding vector(1536),
  filter_category text,
  match_threshold float,
  match_count int,
  exclude_ids text[] DEFAULT NULL
)
RETURNS TABLE (
  id text, label text, similarity float
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT kn.id, kn.label,
    1 - (kn.embedding <=> query_embedding) AS similarity
  FROM knowledge_nodes kn
  WHERE kn.embedding IS NOT NULL
    AND kn.kind = filter_category
    AND 1 - (kn.embedding <=> query_embedding) > match_threshold
    AND (exclude_ids IS NULL OR kn.id <> ALL (exclude_ids))
  ORDER BY kn.embedding <=> query_embedding LIMIT match_count;
END; $$;

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
