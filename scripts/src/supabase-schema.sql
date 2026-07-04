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
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','uploading','uploaded','transcribing','analyzing','indexing','completed','failed','retrying')),
  transcript TEXT,
  analysis TEXT,
  key_points TEXT[] DEFAULT '{}',
  competency_codes TEXT[] DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  embedding vector(1536),
  -- Durable job state (resilient processing pipeline)
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  heartbeat_at TIMESTAMPTZ,
  claimed_by TEXT,
  next_attempt_at TIMESTAMPTZ,
  processing_stage TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Migration: resilient job system (idempotent).
-- Adds the durable job columns to pre-existing installs and migrates the
-- legacy status enum: pending→queued, ready→completed, error→failed.
-- The CHECK constraint is dropped BEFORE the legacy mapping runs (old rows
-- would otherwise violate the new list), then re-added.
-- ---------------------------------------------------------------------------
ALTER TABLE videos ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS processing_stage TEXT;

ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_status_check;
UPDATE videos SET status = 'queued'    WHERE status = 'pending';
UPDATE videos SET status = 'completed' WHERE status = 'ready';
UPDATE videos SET status = 'failed'    WHERE status = 'error';
ALTER TABLE videos ADD CONSTRAINT videos_status_check CHECK (status IN
  ('queued','uploading','uploaded','transcribing','analyzing','indexing','completed','failed','retrying'));

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

-- ANN index for fast semantic retrieval at scale (thousands of videos /
-- 100k+ transcript segments). HNSW builds fine on an empty or growing table
-- (unlike IVFFlat, which needs representative data and list tuning at build
-- time). match_transcript_segments' `ORDER BY ts.embedding <=> query_embedding`
-- uses this cosine index automatically.
CREATE INDEX IF NOT EXISTS idx_segments_embedding_hnsw
  ON transcript_segments USING hnsw (embedding vector_cosine_ops);

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
  -- Raise the HNSW candidate list so a match_count up to the search route's
  -- maximum (50) stays accurate (default hnsw.ef_search is 40). SET LOCAL keeps
  -- it scoped to this function's transaction.
  SET LOCAL hnsw.ef_search = 100;
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
    AND v.status = 'completed'
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
    'core','topic','competency','video','mentor',
    'concept','tool','equipment','material','procedure',
    'hazard','slang','certification','standard','regional_term'
  )),
  label TEXT NOT NULL,
  trade TEXT,
  ref_id TEXT,
  description TEXT,
  confidence FLOAT,
  -- 'mentor_supplied' marks a concept corroborated by an interviewed mentor
  -- (Interview Mode). It is a system-set trust level above raw 'unverified' but
  -- below a human 'verified'/'rejected' decision, which always win.
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','verified','rejected','mentor_supplied')),
  -- Embedding of an atomic-knowledge concept (title + description), used by the
  -- Graph Intelligence layer to detect differently-worded duplicates of the same
  -- concept and collapse them onto one canonical node. NULL for scaffold nodes.
  embedding vector(1536),
  -- meta (atomic-knowledge nodes) is the Knowledge Provenance ledger — every field
  -- is DERIVED from the node's provenance edges on each sync/rebuild (so it is
  -- fully idempotent), except the human-owned verificationHistory. It answers WHY
  -- a concept exists:
  --   category            the atomic-knowledge kind (mirrors `kind`)
  --   sourceVideoIds/[]   the distinct videos corroborating this concept
  --   sourceCount         count of the above
  --   timestamps[]        de-duplicated union of every source video's timestamps
  --   sources[]           per-video record: {videoId, timestamps, confidence,
  --                       model, extractedAt} — model/extractedAt are null for
  --                       edges written before the provenance feature existed
  --   models[]            distinct extracting models seen across sources
  --   firstExtractedAt /  earliest / latest extraction date across sources (null
  --   lastExtractedAt     when no source carries an extraction date)
  --   confidenceHistory[] append-on-change log {confidence, sourceCount, at}
  --   mergedFrom[]        other concept identities that collapsed onto this node
  --                       {id, label, category, at} (first-seen wins)
  --   rejectedEvidence[]  videos that USED to corroborate this concept but no
  --                       longer do {videoId, at, reason} — reconciled away if the
  --                       video re-teaches the concept
  --   verificationHistory[] human decision transitions {from, to, at} — NO
  --                       reviewer identity (that is a separate signed-in feature);
  --                       this is the one meta field NOT derived from edges
  -- All history arrays are tail-capped (last 50) so churn cannot bloat meta.
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Edge kinds mirror the node relationships. 'knowledge' is the video -> atomic
-- knowledge provenance link (many-to-many): one video contributes many concepts,
-- and one concept accumulates many source videos over time. The edge `meta` is the
-- single source of truth the node aggregates are derived from — it holds this
-- link's {timestamps, confidence, trade, competencyCode, model, extractedAt}
-- (model/extractedAt = the model + date that distilled this contribution; null on
-- pre-provenance-feature edges).
CREATE TABLE IF NOT EXISTS knowledge_edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'core','topic','competency','video','mentor','knowledge'
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
  'core','topic','competency','video','mentor',
  'concept','tool','equipment','material','procedure',
  'hazard','slang','certification','standard','regional_term'
));
ALTER TABLE knowledge_nodes DROP CONSTRAINT IF EXISTS knowledge_nodes_verification_status_check;
ALTER TABLE knowledge_nodes ADD CONSTRAINT knowledge_nodes_verification_status_check
  CHECK (verification_status IN ('unverified','verified','rejected','mentor_supplied'));

ALTER TABLE knowledge_edges ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}';
ALTER TABLE knowledge_edges DROP CONSTRAINT IF EXISTS knowledge_edges_kind_check;
ALTER TABLE knowledge_edges ADD CONSTRAINT knowledge_edges_kind_check CHECK (kind IN (
  'core','topic','competency','video','mentor','knowledge'
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

-- ============================================================================
-- Knowledge Entries — generic, NON-video knowledge assets (written field notes,
-- sketches, photos, etc.). This proves Jack can retrieve knowledge that did not
-- originate from a video: Ask Jack embeds each entry and surfaces it as a
-- citation (with its image) alongside video transcript matches. Entries are
-- created out-of-band for now (seed script / direct insert) — there is no
-- ingestion UI yet. The retrieval path is generic/table-driven, not hardcoded
-- to any specific entry.
-- ============================================================================
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  trade TEXT,
  category TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  body TEXT NOT NULL DEFAULT '',
  -- images: [{ "url": "...", "caption": "..." }]; the first image is surfaced
  -- as the citation thumbnail in Ask Jack.
  images JSONB NOT NULL DEFAULT '[]',
  -- optional links back into the video library
  related_video_ids UUID[] NOT NULL DEFAULT '{}',
  -- related_timestamps: [{ "videoId": "...", "time": 0, "label": "..." }]
  related_timestamps JSONB NOT NULL DEFAULT '[]',
  -- attachments (future): [{ "url": "...", "kind": "...", "name": "..." }]
  attachments JSONB NOT NULL DEFAULT '[]',
  metadata JSONB NOT NULL DEFAULT '{}',
  -- JSON-serialized text-embedding-3-small vector of (title + description +
  -- body), stored like videos.embedding / transcript_segments.embedding.
  -- Nullable so a row can be inserted first and embedded later, but semantic
  -- retrieval requires it.
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_entries_trade ON knowledge_entries(trade);
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_embedding_hnsw
  ON knowledge_entries USING hnsw (embedding vector_cosine_ops);

-- match_knowledge_entries — semantic retrieval of non-video knowledge for Ask
-- Jack. Mirrors match_transcript_segments (same threshold/count/filter_trade
-- contract) so the chat route can call both with one query embedding.
CREATE OR REPLACE FUNCTION match_knowledge_entries(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  filter_trade text DEFAULT NULL
)
RETURNS TABLE (
  id uuid, title text, description text, trade text, category text,
  tags text[], body text, images jsonb, similarity float
)
LANGUAGE plpgsql AS $$
BEGIN
  SET LOCAL hnsw.ef_search = 100;
  RETURN QUERY
  SELECT ke.id, ke.title, ke.description, ke.trade, ke.category, ke.tags, ke.body, ke.images,
    1 - (ke.embedding <=> query_embedding) AS similarity
  FROM knowledge_entries ke
  WHERE ke.embedding IS NOT NULL
    AND 1 - (ke.embedding <=> query_embedding) > match_threshold
    AND (filter_trade IS NULL OR ke.trade = filter_trade)
  ORDER BY ke.embedding <=> query_embedding LIMIT match_count;
END; $$;

-- ============================================================================
-- Interview Mode — mentor profiles, interview sessions, and verbatim answers.
--
-- An experienced tradesperson ("mentor") is interviewed conversationally by
-- Jack (one plainspoken question at a time). Every answer is stored VERBATIM,
-- distilled into candidate atomic knowledge (reusing the video distillation
-- engine), and mirrored into the SAME shared knowledge graph as a `mentor:<id>`
-- source node whose provenance edges reinforce canonical concept nodes with
-- verification_status = 'mentor_supplied'.
-- ============================================================================

-- One interviewed mentor. `trade` is the normalized (Red Seal-aligned) trade
-- used across the graph; `trade_input` preserves whatever the mentor typed
-- (esp. for the "Other" free-text trade).
CREATE TABLE IF NOT EXISTS mentor_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  trade TEXT,
  trade_input TEXT,
  years_experience INT,
  specialties TEXT[] DEFAULT '{}',
  region TEXT,
  background TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A single interview conversation. The server is authoritative for the pending
-- question: `current_question`/`current_category`/`current_topic` hold the
-- question the mentor is answering next (null once the interview is complete).
CREATE TABLE IF NOT EXISTS interview_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mentor_profile_id UUID NOT NULL REFERENCES mentor_profiles(id) ON DELETE CASCADE,
  trade TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  current_question TEXT,
  current_category TEXT,
  current_topic TEXT,
  asked_categories TEXT[] DEFAULT '{}',
  question_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Every question put to the mentor and their verbatim answer. `skipped` answers
-- carry no text and no distilled knowledge. The nullable media_ref +
-- media_start_time/media_end_time columns are reserved for a future audio/video
-- answer mode (this build stores typed answers only). `extracted_knowledge` is a
-- convenience snapshot of what this answer distilled into (the graph remains the
-- source of truth).
CREATE TABLE IF NOT EXISTS interview_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  mentor_profile_id UUID NOT NULL REFERENCES mentor_profiles(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  category TEXT,
  topic TEXT,
  answer_text TEXT,
  skipped BOOLEAN NOT NULL DEFAULT false,
  media_ref TEXT,
  media_start_time FLOAT,
  media_end_time FLOAT,
  extracted_knowledge JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_interview_sessions_mentor ON interview_sessions(mentor_profile_id);
CREATE INDEX IF NOT EXISTS idx_interview_answers_session ON interview_answers(session_id);
CREATE INDEX IF NOT EXISTS idx_interview_answers_mentor ON interview_answers(mentor_profile_id);

-- Knowledge candidates — mentor-distilled concepts held OUTSIDE the live graph.
-- When a mentor concept is a plausible-but-uncertain match against existing
-- knowledge (the ambiguous middle band of the reinforcement-first policy), it is
-- queued here as a pending candidate instead of becoming a live node, capturing
-- the extracted concept, its best-match nodes/scores, and mentor/answer/session
-- provenance so it can be reviewed later and nothing is lost. The id is
-- deterministic per (answer, item) so replaying an answer never duplicates a
-- candidate or resets a reviewed status.
CREATE TABLE IF NOT EXISTS knowledge_candidates (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','merged','archived','restored')),
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  trade TEXT,
  confidence FLOAT,
  competency_code TEXT,
  mentor_profile_id UUID,
  mentor_name TEXT,
  answer_id UUID,
  session_id UUID,
  best_matches JSONB NOT NULL DEFAULT '[]',
  aliases JSONB NOT NULL DEFAULT '[]',
  resolved_target_id TEXT,
  resolution_reason TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_status ON knowledge_candidates(status);
CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_answer ON knowledge_candidates(answer_id);

-- Knowledge Review migration (idempotent) — resolution record columns for
-- databases created before the review surface existed, plus the rename of the
-- legacy 'approved' status to 'accepted' (the review language is
-- Accept / Merge / Reject). Drop-then-add keeps the CHECK swap re-runnable.
ALTER TABLE knowledge_candidates ADD COLUMN IF NOT EXISTS resolved_target_id TEXT;
ALTER TABLE knowledge_candidates ADD COLUMN IF NOT EXISTS resolution_reason TEXT;
ALTER TABLE knowledge_candidates ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE knowledge_candidates DROP CONSTRAINT IF EXISTS knowledge_candidates_status_check;
UPDATE knowledge_candidates SET status = 'accepted' WHERE status = 'approved';
-- 'archived' (Mentor Withdrawal): a mentor-only concept demoted OUT of the live
-- graph when its sole mentor withdrew — an attribution-free content snapshot
-- (with an `aliases` list) preserved for potential future review.
-- 'restored' (Knowledge Review): an 'archived' concept a reviewer brought back
-- into the live graph as attribution-free unverified curated knowledge; the row
-- keeps its content as an audit record and is never actioned again.
ALTER TABLE knowledge_candidates
  ADD CONSTRAINT knowledge_candidates_status_check
  CHECK (status IN ('pending','accepted','rejected','merged','archived','restored'));
ALTER TABLE knowledge_candidates ADD COLUMN IF NOT EXISTS aliases JSONB NOT NULL DEFAULT '[]';

-- Resilient Knowledge Review (idempotent): the graph legitimately moves while
-- a candidate sits in review, so a resolution records BOTH the target the
-- reviewer asked for and why the recorded target differs (merged away /
-- re-matched by content), keeping redirected resolutions auditable and
-- replay-safe.
ALTER TABLE knowledge_candidates ADD COLUMN IF NOT EXISTS requested_target_id TEXT;
ALTER TABLE knowledge_candidates ADD COLUMN IF NOT EXISTS redirect_reason TEXT;

-- Knowledge Write Verification — one durable audit row per knowledge write (a
-- video distillation OR a mentor interview answer). A successful upload/answer
-- MUST verify that its knowledge actually entered the graph: canonical nodes
-- exist, provenance edges were created, confidence was recomputed, and the search
-- index was updated. The pipeline NEVER reports success on a failed/partial write
-- — a failed video re-enters the retry/backoff ladder, and a failed answer is
-- flagged for admin redistill. This table is the admin Graph Health dashboard's
-- source of truth. The id is deterministic (wl:video:<id> / wl:answer:<id>) so a
-- retry/replay converges onto the same row instead of piling up duplicates.
CREATE TABLE IF NOT EXISTS knowledge_write_log (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('video','mentor_answer')),
  ref_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('verified','partial','failed','pending')),
  -- Per-check results ({nodesExist, edgesExist, provenanceStored,
  -- confidenceUpdated, searchIndexUpdated}) surfaced on the dashboard.
  checks JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  duration_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_write_log_status ON knowledge_write_log(status);
CREATE INDEX IF NOT EXISTS idx_knowledge_write_log_scope ON knowledge_write_log(scope);
CREATE INDEX IF NOT EXISTS idx_knowledge_write_log_updated ON knowledge_write_log(updated_at DESC);

-- interview_answers distillation verification status (idempotent) — mirrors the
-- write-log verdict onto the answer row so the interview UI can flag an answer
-- whose knowledge failed to enter the graph and the admin redistill action can
-- find failed answers. Skipped/pre-feature answers keep the 'pending' default.
ALTER TABLE interview_answers
  ADD COLUMN IF NOT EXISTS distillation_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE interview_answers ADD COLUMN IF NOT EXISTS distillation_error TEXT;
ALTER TABLE interview_answers DROP CONSTRAINT IF EXISTS interview_answers_distillation_status_check;
ALTER TABLE interview_answers
  ADD CONSTRAINT interview_answers_distillation_status_check
  CHECK (distillation_status IN ('pending','verified','failed'));

-- Parking Lot — lightweight bookmarks for an interrupted thought during an Ask
-- Jack chat conversation or a mentor interview. No AI-generated titles or
-- summaries (deterministic truncation only) — this is a bookmark, not a new
-- distillation surface. `chat_session_id` ties a chat-sourced row to the SAME
-- HttpOnly jack_session cookie used for chat privacy (routes/chat.ts) so it is
-- only ever listed/resumed/archived by its owner; `interview_session_id` /
-- `mentor_profile_id` are set for interview-sourced rows and, unlike chat, are
-- public — consistent with the rest of the app's interview/mentor data having
-- no privacy boundary. `context_snapshot` holds up to 5 recent turns
-- ([{role, text, at}]) captured at park time.
CREATE TABLE IF NOT EXISTS parked_thoughts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('chat','interview')),
  chat_session_id TEXT,
  interview_session_id UUID REFERENCES interview_sessions(id) ON DELETE CASCADE,
  mentor_profile_id UUID REFERENCES mentor_profiles(id) ON DELETE CASCADE,
  mentor_name TEXT,
  trade TEXT,
  category TEXT,
  topic TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  unfinished_thought TEXT,
  reason TEXT,
  context_snapshot JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'parked' CHECK (status IN ('parked','resumed','resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_parked_thoughts_status ON parked_thoughts(status);
CREATE INDEX IF NOT EXISTS idx_parked_thoughts_chat_session ON parked_thoughts(chat_session_id);
CREATE INDEX IF NOT EXISTS idx_parked_thoughts_mentor ON parked_thoughts(mentor_profile_id);
-- Idempotent migration for databases where parked_thoughts was created before
-- mentor_name was denormalized onto the row (mirrors knowledge_candidates).
ALTER TABLE parked_thoughts ADD COLUMN IF NOT EXISTS mentor_name TEXT;

-- Force PostgREST to reload its schema cache now that the DDL above has run.
-- Right after a (re)apply, PostgREST serves against a stale cache until it
-- reloads on its own, so a knowledge write in that window can be mislabelled
-- "failed" (code PGRST205 / "…schema cache"). Notifying here closes the window
-- at the source. Works both via setup:supabase and a manual SQL Editor paste.
NOTIFY pgrst, 'reload schema';
