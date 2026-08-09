-- Torch Labs - Pilot 001: Telemetry, Live Monitoring, Health Alerts, Evidence and Export
-- This migration adds Command Centre tables: knowledge contributions, evidence, health alerts, monitor state

-- 1. Pilot Knowledge Contributions
CREATE TABLE IF NOT EXISTS public.pilot_knowledge_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  pilot_id UUID NOT NULL,
  actor_user_id TEXT NOT NULL,
  session_id UUID,
  contributor_name TEXT,
  contributor_identifier TEXT,
  trade_branch TEXT,
  topic TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  supporting_source TEXT,
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending','accepted','rejected','incorporated')),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  date_incorporated TIMESTAMPTZ,
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','field_note','interview','correction','imported')),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.pilot_knowledge_contributions ADD CONSTRAINT fk_kc_pilot FOREIGN KEY (organization_id, pilot_id) REFERENCES public.pilots(organization_id, id);
ALTER TABLE public.pilot_knowledge_contributions ADD CONSTRAINT fk_kc_session FOREIGN KEY (session_id) REFERENCES public.test_sessions(id) ON DELETE SET NULL;

-- 2. Pilot Evidence Records
CREATE TABLE IF NOT EXISTS public.pilot_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  pilot_id UUID NOT NULL,
  actor_user_id TEXT NOT NULL,
  session_id UUID,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('metric','quote','screenshot','story','correction','knowledge_contribution','safety_quality_evidence','commercial_evidence')),
  title TEXT NOT NULL,
  description TEXT,
  person_identifier TEXT,
  role TEXT,
  trade TEXT,
  exact_quote TEXT,
  metric_supported TEXT,
  consent_status TEXT NOT NULL DEFAULT 'not_applicable' CHECK (consent_status IN ('granted','not_applicable','unknown')),
  supporting_file_url TEXT,
  supporting_url TEXT,
  validation_status TEXT NOT NULL DEFAULT 'unvalidated' CHECK (validation_status IN ('unvalidated','validated','disputed','rejected')),
  validated_by TEXT,
  validated_at TIMESTAMPTZ,
  follow_up_owner TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  event_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.pilot_evidence ADD CONSTRAINT fk_evidence_pilot FOREIGN KEY (organization_id, pilot_id) REFERENCES public.pilots(organization_id, id);
ALTER TABLE public.pilot_evidence ADD CONSTRAINT fk_evidence_session FOREIGN KEY (session_id) REFERENCES public.test_sessions(id) ON DELETE SET NULL;
ALTER TABLE public.pilot_evidence ADD CONSTRAINT fk_evidence_event FOREIGN KEY (event_id) REFERENCES public.test_events(event_id) ON DELETE SET NULL;

-- 3. Pilot Health Alerts
CREATE TABLE IF NOT EXISTS public.pilot_health_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  pilot_id UUID NOT NULL,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('no_activity_48h','activation_below_target','weekly_active_users_below_target','repeated_login_failures','repeated_session_failures','telemetry_ingestion_failure','duplicate_event_spike','low_usefulness_ratings','low_accuracy_ratings','repeated_flagged_answers','low_confidence_safety_answer','repeated_unanswered_plumbing','privacy_scope_integrity_violation','single_active_user','sharp_usage_decline','missing_session_records','custom')),
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  title TEXT NOT NULL,
  description TEXT,
  trigger_event TEXT,
  trigger_details JSONB NOT NULL DEFAULT '{}'::JSONB,
  relevant_evidence JSONB NOT NULL DEFAULT '[]'::JSONB,
  recommended_action TEXT,
  responsible_owner TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','in_progress','resolved','dismissed','escalated')),
  status_history JSONB NOT NULL DEFAULT '[]'::JSONB,
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.pilot_health_alerts ADD CONSTRAINT fk_alerts_pilot FOREIGN KEY (organization_id, pilot_id) REFERENCES public.pilots(organization_id, id);

-- 4. Pilot Monitor State (cached dashboard snapshots)
CREATE TABLE IF NOT EXISTS public.pilot_monitor_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  pilot_id UUID NOT NULL,
  active_users_now INTEGER NOT NULL DEFAULT 0,
  recently_active_users INTEGER NOT NULL DEFAULT 0,
  active_sessions INTEGER NOT NULL DEFAULT 0,
  todays_sessions INTEGER NOT NULL DEFAULT 0,
  total_questions INTEGER NOT NULL DEFAULT 0,
  successful_responses INTEGER NOT NULL DEFAULT 0,
  failed_responses INTEGER NOT NULL DEFAULT 0,
  avg_response_latency_ms NUMERIC NOT NULL DEFAULT 0,
  p95_response_latency_ms NUMERIC NOT NULL DEFAULT 0,
  total_feedback INTEGER NOT NULL DEFAULT 0,
  useful_count INTEGER NOT NULL DEFAULT 0,
  not_useful_count INTEGER NOT NULL DEFAULT 0,
  accuracy_avg NUMERIC NOT NULL DEFAULT 0,
  citation_count INTEGER NOT NULL DEFAULT 0,
  citation_opens INTEGER NOT NULL DEFAULT 0,
  citation_verifications INTEGER NOT NULL DEFAULT 0,
  open_alerts INTEGER NOT NULL DEFAULT 0,
  critical_alerts INTEGER NOT NULL DEFAULT 0,
  ingestion_healthy BOOLEAN NOT NULL DEFAULT true,
  last_ingestion_at TIMESTAMPTZ,
  login_failures_24h INTEGER NOT NULL DEFAULT 0,
  session_failures_24h INTEGER NOT NULL DEFAULT 0,
  duplicate_events_24h INTEGER NOT NULL DEFAULT 0,
  knowledge_contributions_24h INTEGER NOT NULL DEFAULT 0,
  activity_by_site JSONB NOT NULL DEFAULT '{}'::JSONB,
  activity_by_trade JSONB NOT NULL DEFAULT '{}'::JSONB,
  activity_by_role JSONB NOT NULL DEFAULT '{}'::JSONB,
  flagged_low_confidence JSONB NOT NULL DEFAULT '[]'::JSONB,
  recent_questions JSONB NOT NULL DEFAULT '[]'::JSONB,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, pilot_id)
);
ALTER TABLE public.pilot_monitor_state ADD CONSTRAINT fk_monitor_state_pilot FOREIGN KEY (organization_id, pilot_id) REFERENCES public.pilots(organization_id, id);

-- 5. Indexes
CREATE INDEX IF NOT EXISTS idx_kc_org_pilot ON public.pilot_knowledge_contributions (organization_id, pilot_id);
CREATE INDEX IF NOT EXISTS idx_kc_validation ON public.pilot_knowledge_contributions (validation_status);
CREATE INDEX IF NOT EXISTS idx_kc_created ON public.pilot_knowledge_contributions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_org_pilot ON public.pilot_evidence (organization_id, pilot_id);
CREATE INDEX IF NOT EXISTS idx_evidence_type ON public.pilot_evidence (evidence_type);
CREATE INDEX IF NOT EXISTS idx_evidence_validation ON public.pilot_evidence (validation_status);
CREATE INDEX IF NOT EXISTS idx_evidence_created ON public.pilot_evidence (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_org_pilot ON public.pilot_health_alerts (organization_id, pilot_id);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON public.pilot_health_alerts (status);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON public.pilot_health_alerts (severity);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON public.pilot_health_alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_monitor_org_pilot ON public.pilot_monitor_state (organization_id, pilot_id);

-- 6. Enhanced indexes for existing telemetry tables
CREATE INDEX IF NOT EXISTS idx_test_events_org_pilot_occurred ON public.test_events (organization_id, pilot_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_events_type_occurred ON public.test_events (event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_sessions_org_pilot_active ON public.test_sessions (organization_id, pilot_id, status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_feedback_org_pilot ON public.test_feedback (organization_id, pilot_id);

-- 7. RLS: all new tables are server-only
ALTER TABLE public.pilot_knowledge_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pilot_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pilot_health_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pilot_monitor_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pilot_knowledge_contributions FROM anon, authenticated;
REVOKE ALL ON TABLE public.pilot_evidence FROM anon, authenticated;
REVOKE ALL ON TABLE public.pilot_health_alerts FROM anon, authenticated;
REVOKE ALL ON TABLE public.pilot_monitor_state FROM anon, authenticated;
GRANT ALL ON TABLE public.pilot_knowledge_contributions TO service_role;
GRANT ALL ON TABLE public.pilot_evidence TO service_role;
GRANT ALL ON TABLE public.pilot_health_alerts TO service_role;
GRANT ALL ON TABLE public.pilot_monitor_state TO service_role;

NOTIFY pgrst, 'reload schema';
