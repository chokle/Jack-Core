-- Private, authoritative user-test feedback records.
-- The Jack API writes with SUPABASE_SERVICE_ROLE_KEY; browser roles have no
-- table privileges or RLS policies.
create table public.test_feedback (
  id uuid primary key default gen_random_uuid(),
  tester_user_id text not null,
  tester_email text,
  tester_name text,
  tester_profile_id uuid references public.mentor_profiles(id) on delete set null,
  tester_trade text,
  session_id text not null,
  features_used jsonb not null default '[]'::jsonb,
  device_category text not null
    check (device_category in ('desktop', 'tablet', 'mobile')),
  trigger text not null
    check (trigger in ('logout', 'interview_complete', 'ask_jack_complete', 'desktop_exit')),
  goal text not null,
  useful text not null
    check (useful in ('yes', 'partly', 'no')),
  shortfall text not null,
  adoption_need text not null,
  additional text,
  app_version text,
  status text not null default 'new'
    check (status in ('new', 'reviewed', 'actioned', 'archived')),
  admin_notes text,
  reviewed_by text,
  reviewed_at timestamptz,
  notification_status text not null default 'pending'
    check (notification_status in ('pending', 'sent', 'failed', 'retrying')),
  notification_attempts integer not null default 0,
  notification_last_error text,
  notification_last_attempt_at timestamptz,
  notification_next_attempt_at timestamptz,
  notification_sent_at timestamptz,
  notification_provider_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_test_feedback_created_at
  on public.test_feedback (created_at desc);
create index idx_test_feedback_tester_user_id
  on public.test_feedback (tester_user_id);
create index idx_test_feedback_session_id
  on public.test_feedback (session_id);
create index idx_test_feedback_review_status
  on public.test_feedback (status, created_at desc);
create index idx_test_feedback_notification
  on public.test_feedback (notification_status, notification_next_attempt_at);

alter table public.test_feedback enable row level security;

revoke all on table public.test_feedback from anon, authenticated;
grant all on table public.test_feedback to service_role;

comment on table public.test_feedback is
  'Private operational feedback from explicitly consenting Jack user testers.';
