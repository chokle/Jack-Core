alter table public.mentor_profiles
  add column if not exists contributor_user_id text;

alter table public.interview_sessions
  add column if not exists contributor_user_id text;

create index if not exists idx_interview_sessions_contributor
  on public.interview_sessions(contributor_user_id);
