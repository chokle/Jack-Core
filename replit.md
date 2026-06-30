# Jack — AI Trade Intelligence Engine

Jack is a single-page AI Trade Intelligence Engine for skilled trades workers — a searchable, queryable video knowledge library that transcribes training videos, maps them to Red Seal competencies, and answers questions with timestamp citations.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/jack-core run dev` — run the frontend (port 22659)
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

## Architecture decisions

- Single-page React app with conditional rendering (no multi-page routing) — Library → VideoDetail → overlaid AskJack drawer
- Supabase is the single source of truth for all persistence: videos, transcript_segments, chat_messages, competencies tables
- pgvector (1536-dim, text-embedding-3-small) powers both semantic search and related-video discovery
- Transcription and analysis are async (background jobs via setImmediate) — status polling via the `status` field on Video
- Jack always searches the internal library (pgvector RAG) before answering — `usedInternalKnowledge` flag in responses
- Red Seal competency codes are seeded from a canonical list and mapped by GPT-4o during analysis

## Product

- **Video Library** — upload, browse, and filter training videos by trade and status
- **AI Transcription** — Whisper transcribes videos with timestamps; segments are indexed for search
- **AI Analysis** — GPT-4o generates summaries, key points, and Red Seal competency mappings
- **Semantic Search** — RAG over transcript segments with pgvector; falls back to text search if no embeddings
- **Ask Jack** — Conversational AI that searches the internal library first, answers with timestamp citations
- **Related Videos** — Vector similarity to surface related content after watching

## Required Setup — Supabase Schema

**CRITICAL: Run this SQL in Supabase Dashboard → SQL Editor before the app will work:**

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
```

Also create a Storage bucket named **`jack-videos`** (set to Public) in Supabase Dashboard → Storage.

## Gotchas

- Run the Supabase SQL schema before the app will work — tables don't exist until you do
- After any OpenAPI spec change, run `pnpm --filter @workspace/api-spec run codegen` before starting the server
- Transcription/analysis are async background jobs — poll the video `status` field (pending → transcribing → analyzing → ready)
- The `embedding` column stores JSON-serialized float arrays (vector(1536)) — Supabase's pgvector extension must be enabled first
- Jack's RAG always searches internally first; `usedInternalKnowledge: false` in chat responses means no matching segments were found

## User preferences

- No auth, billing, or multi-page navigation in jack-core — single-page AI engine only
- Next.js was requested but this monorepo uses React+Vite; architecture is equivalent
- Supabase is the single source of truth for all persistence

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
