-- SRAL (Systemic Reflection and Adaptation Loop) - Phase 1 foundation
-- Adds append-only ledgers and reviewable proposal candidates with no automatic adoption.

CREATE TYPE IF NOT EXISTS public.sral_constitution_gate_result AS ENUM (
  'not_applicable',
  'passed',
  'blocked'
);

CREATE TYPE IF NOT EXISTS public.sral_proposal_status AS ENUM (
  'not_required',
  'draft',
  'awaiting_review',
  'blocked_by_constitution',
  'blocked_by_evidence',
  'rejected'
);

CREATE TYPE IF NOT EXISTS public.sral_rollback_status AS ENUM (
  'none_required',
  'pending',
  'recommended',
  'applied'
);

CREATE TABLE IF NOT EXISTS public.sral_learning_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_reference TEXT NOT NULL,
  -- A single interaction can only produce one reflection row; this enforces idempotent writes
  -- for retried / duplicate requests and allows exact postmortems.
  CONSTRAINT sral_learning_ledger_interaction_reference_not_empty CHECK (char_length(interaction_reference) > 0),
  actor_user_id TEXT NOT NULL,
  session_id UUID,
  subsystem TEXT NOT NULL DEFAULT 'chat' CHECK (subsystem IN ('chat','interview','teach')),
  trigger_interaction_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_message TEXT NOT NULL,
  assistant_answer TEXT NOT NULL,
  learning_status TEXT NOT NULL CHECK (learning_status IN ('verified','discarded','failed')),
  extracted_count INTEGER NOT NULL DEFAULT 0 CHECK (extracted_count >= 0),
  reflection_summary TEXT NOT NULL,
  evaluation_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_failure_class TEXT,
  objective_solved BOOLEAN NOT NULL DEFAULT false,
  assumption_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
  uncertainty_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
  supporting_evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  affected_subsystem TEXT NOT NULL DEFAULT 'ask_jack',
  expected_benefit TEXT NOT NULL DEFAULT 'No change requested in this cycle.',
  possible_risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  constitution_review_result public.sral_constitution_gate_result NOT NULL DEFAULT 'not_applicable',
  proposal_status public.sral_proposal_status NOT NULL DEFAULT 'not_required',
  measured_outcome TEXT,
  rollback_status public.sral_rollback_status NOT NULL DEFAULT 'none_required',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sral_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id UUID NOT NULL REFERENCES public.sral_learning_ledger(id) ON DELETE CASCADE,
  proposed_change_summary TEXT NOT NULL,
  expected_benefit TEXT NOT NULL,
  possible_risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_references JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence_score NUMERIC NOT NULL DEFAULT 0 CHECK (confidence_score >= 0 AND confidence_score <= 1),
  constitution_review_result public.sral_constitution_gate_result NOT NULL DEFAULT 'not_applicable',
  proposal_status public.sral_proposal_status NOT NULL DEFAULT 'draft',
  rollback_status public.sral_rollback_status NOT NULL DEFAULT 'recommended',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sral_ledger_actor_user ON public.sral_learning_ledger (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sral_ledger_session ON public.sral_learning_ledger (session_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sral_ledger_interaction_reference ON public.sral_learning_ledger (interaction_reference);
CREATE INDEX IF NOT EXISTS idx_sral_ledger_proposal_status ON public.sral_learning_ledger (proposal_status);
CREATE INDEX IF NOT EXISTS idx_sral_ledger_constitution ON public.sral_learning_ledger (constitution_review_result);
CREATE INDEX IF NOT EXISTS idx_sral_proposal_ledger ON public.sral_proposals (ledger_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sral_proposal_status ON public.sral_proposals (proposal_status);

ALTER TABLE public.sral_learning_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sral_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sral_learning_ledger FROM anon, authenticated;
REVOKE ALL ON TABLE public.sral_proposals FROM anon, authenticated;
GRANT ALL ON TABLE public.sral_learning_ledger TO service_role;
GRANT ALL ON TABLE public.sral_proposals TO service_role;

NOTIFY pgrst, 'reload schema';
