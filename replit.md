# Jack — AI Trade Intelligence Engine

Jack is a single-page AI Trade Intelligence Engine for skilled trades workers — a searchable, queryable video knowledge library that transcribes training videos, maps them to Red Seal competencies, and answers questions with timestamp citations.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/jack-core run dev` — run the frontend (port 22659)
- `pnpm --filter @workspace/scripts run setup:supabase` — apply the Supabase schema (tables, functions, seed data, storage bucket)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite (single-page, `artifacts/jack-core/`)
- API: Express 5 (`artifacts/api-server/`)
- Database: Supabase (PostgreSQL + pgvector for embeddings)
- Storage: Supabase Storage (`jack-videos` bucket)
- AI: OpenAI Whisper (transcription) + GPT-4o (analysis + Ask Jack) + text-embedding-3-small (RAG)
- Validation: Zod (`zod/v4`), Orval codegen

## Where things live

- `lib/api-spec/openapi.yaml` — single source of truth for all API contracts
- `lib/api-client-react/src/generated/` — generated React Query hooks (don't edit)
- `lib/api-zod/src/generated/` — generated Zod schemas (don't edit)
- `artifacts/jack-core/src/` — React frontend (Library, VideoDetail, AskJack, UploadModal)
- `artifacts/api-server/src/routes/` — Express route handlers (videos, search, chat, competencies)
- `artifacts/api-server/src/lib/supabase.ts` — Supabase client
- `artifacts/api-server/src/lib/openai.ts` — OpenAI client
- `scripts/src/setup-supabase.ts` — Supabase schema setup script/reference
- `artifacts/api-server/src/lib/memory-graph.ts` — knowledge-graph persistence (node/edge sync, self-heal, rebuild)
- `artifacts/api-server/src/routes/graph.ts` — `GET /graph` (persisted Living Memory graph)
- `artifacts/api-server/src/routes/interview.ts` — Interview Mode endpoints (start session, get, submit/skip answer, finish)
- `artifacts/api-server/src/lib/interview.ts` — interview trades/categories + next-question engine (GPT-4o with deterministic fallback)
- `artifacts/jack-core/src/components/InterviewMode.tsx` — Interview Mode UI (intake → conversation → completion)
- `artifacts/jack-core/src/lib/memory-graph.ts` — client graph model (`buildGraphModelFromServer` + client-derived fallback)

## Architecture decisions

- Single-page React app with conditional rendering (no multi-page routing) — Library → VideoDetail → overlaid AskJack drawer
- Supabase is the single source of truth for all persistence: videos, transcript_segments, chat_messages, competencies tables
- pgvector (1536-dim, text-embedding-3-small) powers both semantic search and related-video discovery
- Transcription and analysis are async (background jobs via setImmediate) — status polling via the `status` field on Video
- Jack always searches the internal library (pgvector RAG) before answering — `usedInternalKnowledge` flag in responses
- Red Seal competency codes are seeded from a canonical list and mapped by GPT-4o during analysis
- Interview Mode reuses the video distillation + graph pipeline: mentor answers are distilled into the SAME canonical concept nodes (provenance is edge-owned via `mentor:<uuid>` → concept edges, deduped by answer id) with `verification_status="mentor_supplied"`, so mentor input corroborates rather than fragments the graph. Interview trade labels are normalized to the seeded Red Seal trades (e.g. "Welding" → "Welder") so mentor concepts hang off existing topic hubs
- The knowledge graph is persisted in Supabase (`knowledge_nodes`/`knowledge_edges`) as a deterministic-ID mirror (core `__jack__`, `topic:<trade>`, `comp:<code>`, `video:<uuid>`) synced through the video pipeline, so re-processing/merging collapses onto the same node instead of duplicating. `GET /graph` self-heals when empty; there is **no** public rebuild endpoint (the API uses the service-role key and has no auth), and the frontend falls back to deriving the graph client-side if the persisted graph is unavailable

## Product

- **Video Library** — upload, browse, and filter training videos by trade and status
- **AI Transcription** — Whisper transcribes videos with timestamps; segments are indexed for search
- **AI Analysis** — GPT-4o generates summaries, key points, and Red Seal competency mappings
- **Semantic Search** — RAG over transcript segments with pgvector; falls back to text search if no embeddings
- **Ask Jack** — Conversational AI that searches the internal library first, answers with timestamp citations
- **Related Videos** — Vector similarity to surface related content after watching
- **Interview Mode** — Jack conversationally interviews experienced tradespeople one plainspoken question at a time (skippable); answers are saved verbatim, distilled with the same engine as videos, and reinforce the SAME shared knowledge graph as `mentor_supplied` corroboration

## Required Setup — Supabase Schema

The schema (tables, pgvector functions, seed data, and the `jack-videos` storage bucket) lives in one canonical file: `scripts/src/supabase-schema.sql`.

**Recommended — apply it automatically:**

1. Add a `SUPABASE_DB_URL` secret: the Supabase Postgres connection string from Dashboard → Project Settings → Database → Connection string. Use the **Session pooler** (or direct) URI, **not** the transaction pooler — DDL needs a session connection. Remember to fill in your database password.
2. Run `pnpm --filter @workspace/scripts run setup:supabase`.

The script is idempotent, so it is safe to re-run. If `SUPABASE_DB_URL` is not set (or the connection fails), the script prints the SQL with instructions instead of crashing.

**Manual fallback — run this SQL in Supabase Dashboard → SQL Editor:**

```sql
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

-- Living Memory knowledge graph — persistent nodes & edges
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
```

The SQL above also creates the public **`jack-videos`** storage bucket. (If you prefer, you can instead create it manually in Supabase Dashboard → Storage and set it to Public.)

## Gotchas

- Apply the Supabase schema before the app will work — run `pnpm --filter @workspace/scripts run setup:supabase` (with `SUPABASE_DB_URL` set) or paste the SQL manually; tables don't exist until you do
- The Supabase JS/REST client cannot run DDL — schema setup needs a direct Postgres connection (`SUPABASE_DB_URL`). `DATABASE_URL`/`PG*` point at Replit's built-in Postgres, not Supabase
- Replit is IPv4-only but Supabase's **direct** host (`db.<ref>.supabase.co`) is IPv6-only, so it fails with a cryptic `ENOTFOUND`/`EAFNOSUPPORT`. Always use the **Session pooler** URL (`postgresql://postgres.<ref>:<password>@aws-<N>-<region>.pooler.supabase.com:5432/postgres`), not the direct host or the *transaction* pooler. `setup:supabase` detects this and prints the fix
- Don't paste Supabase's `[YOUR-PASSWORD]` placeholder with the literal square brackets — strip them. `setup:supabase` warns when the password is still bracket-wrapped, and an auth failure (`28P01`) means reset the password in Dashboard → Project Settings → Database
- After any OpenAPI spec change, run `pnpm --filter @workspace/api-spec run codegen` before starting the server
- Transcription/analysis are async background jobs — poll the video `status` field (pending → transcribing → analyzing → ready)
- The `embedding` column stores JSON-serialized float arrays (vector(1536)) — Supabase's pgvector extension must be enabled first
- Jack's RAG always searches internally first; `usedInternalKnowledge: false` in chat responses means no matching segments were found
- The knowledge graph needs the `knowledge_nodes`/`knowledge_edges` tables applied too (they are part of the canonical schema) — until then `GET /graph` returns 500 and the frontend silently falls back to a client-derived graph

## User preferences

- No auth, billing, or multi-page navigation in jack-core — single-page AI engine only
- Next.js was requested but this monorepo uses React+Vite; architecture is equivalent
- Supabase is the single source of truth for all persistence

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
