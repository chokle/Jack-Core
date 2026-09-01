-- Enforcement-only companion for the additive durable privacy migration.
-- Apply immediately before the compatible application candidate. Rollback may
-- drop only these triggers; preserve all additive privacy rows and functions.

drop trigger if exists telemetry_consents_account_deletion_fence
  on public.telemetry_consents;
create trigger telemetry_consents_account_deletion_fence
before insert on public.telemetry_consents
for each row execute function public.enforce_telemetry_account_deletion_fence('actor_user_id');

drop trigger if exists telemetry_withdrawal_jobs_account_deletion_fence
  on public.telemetry_withdrawal_jobs;
create trigger telemetry_withdrawal_jobs_account_deletion_fence
before insert on public.telemetry_withdrawal_jobs
for each row execute function public.enforce_telemetry_account_deletion_fence('actor_user_id');

drop trigger if exists test_sessions_account_deletion_fence on public.test_sessions;
create trigger test_sessions_account_deletion_fence
before insert or update on public.test_sessions
for each row execute function public.enforce_telemetry_account_deletion_fence('actor_user_id');

drop trigger if exists test_events_account_deletion_fence on public.test_events;
create trigger test_events_account_deletion_fence
before insert or update on public.test_events
for each row execute function public.enforce_telemetry_account_deletion_fence('actor_user_id');

drop trigger if exists test_recordings_account_deletion_fence on public.test_recordings;
create trigger test_recordings_account_deletion_fence
before insert or update on public.test_recordings
for each row execute function public.enforce_telemetry_account_deletion_fence('tester_user_id');

drop trigger if exists test_feedback_account_deletion_fence on public.test_feedback;
create trigger test_feedback_account_deletion_fence
before insert or update on public.test_feedback
for each row execute function public.enforce_telemetry_account_deletion_fence('tester_user_id');

drop trigger if exists activity_ingest_failures_account_deletion_fence
  on public.activity_ingest_failures;
create trigger activity_ingest_failures_account_deletion_fence
before insert on public.activity_ingest_failures
for each row execute function public.enforce_telemetry_account_deletion_fence('actor_user_id');

drop trigger if exists videos_account_deletion_fence on public.videos;
create trigger videos_account_deletion_fence
before insert or update on public.videos
for each row execute function public.enforce_telemetry_account_deletion_fence('uploader_user_id');

drop trigger if exists chat_messages_account_deletion_fence on public.chat_messages;
create trigger chat_messages_account_deletion_fence
before insert or update on public.chat_messages
for each row execute function public.enforce_telemetry_account_deletion_fence('user_id');

drop trigger if exists mentor_profiles_account_deletion_fence on public.mentor_profiles;
create trigger mentor_profiles_account_deletion_fence
before insert or update on public.mentor_profiles
for each row execute function public.enforce_telemetry_account_deletion_fence('contributor_user_id');

drop trigger if exists interview_sessions_account_deletion_fence on public.interview_sessions;
create trigger interview_sessions_account_deletion_fence
before insert or update on public.interview_sessions
for each row execute function public.enforce_telemetry_account_deletion_fence('contributor_user_id');

drop trigger if exists parked_thoughts_account_deletion_fence on public.parked_thoughts;
create trigger parked_thoughts_account_deletion_fence
before insert or update on public.parked_thoughts
for each row execute function public.enforce_telemetry_account_deletion_fence('actor_user_id');

drop trigger if exists end_of_shift_closeouts_account_deletion_fence on public.end_of_shift_closeouts;
create trigger end_of_shift_closeouts_account_deletion_fence
before insert or update on public.end_of_shift_closeouts
for each row execute function public.enforce_telemetry_account_deletion_fence('actor_user_id');

drop trigger if exists pilot_access_handoffs_account_deletion_fence on public.pilot_access_handoffs;
create trigger pilot_access_handoffs_account_deletion_fence
before insert or update on public.pilot_access_handoffs
for each row execute function public.enforce_telemetry_account_deletion_fence('user_id');

drop trigger if exists pilot_memberships_user_account_deletion_fence on public.pilot_memberships;
create trigger pilot_memberships_user_account_deletion_fence
before insert or update on public.pilot_memberships
for each row execute function public.enforce_telemetry_account_deletion_fence('user_id');

drop trigger if exists pilot_memberships_creator_account_deletion_fence on public.pilot_memberships;
create trigger pilot_memberships_creator_account_deletion_fence
before insert or update on public.pilot_memberships
for each row execute function public.enforce_telemetry_account_deletion_fence('created_by_user_id');

drop trigger if exists platform_roles_user_account_deletion_fence on public.platform_roles;
create trigger platform_roles_user_account_deletion_fence
before insert or update on public.platform_roles
for each row execute function public.enforce_telemetry_account_deletion_fence('user_id');

drop trigger if exists platform_roles_creator_account_deletion_fence on public.platform_roles;
create trigger platform_roles_creator_account_deletion_fence
before insert or update on public.platform_roles
for each row execute function public.enforce_telemetry_account_deletion_fence('created_by_user_id');

drop trigger if exists activity_report_runs_account_deletion_fence on public.activity_report_runs;
create trigger activity_report_runs_account_deletion_fence
before insert or update on public.activity_report_runs
for each row execute function public.enforce_telemetry_account_deletion_fence('requested_by_user_id');

drop trigger if exists admin_access_audit_actor_account_deletion_fence on public.admin_access_audit;
create trigger admin_access_audit_actor_account_deletion_fence
before insert or update on public.admin_access_audit
for each row execute function public.enforce_telemetry_account_deletion_fence('actor_user_id');

drop trigger if exists admin_access_audit_target_account_deletion_fence on public.admin_access_audit;
create trigger admin_access_audit_target_account_deletion_fence
before insert or update on public.admin_access_audit
for each row execute function public.enforce_telemetry_account_deletion_fence('target_user_id');

drop trigger if exists test_sessions_current_consent_lineage on public.test_sessions;
create trigger test_sessions_current_consent_lineage
before insert or update on public.test_sessions
for each row execute function public.enforce_current_telemetry_lineage();

drop trigger if exists test_events_current_consent_lineage on public.test_events;
create trigger test_events_current_consent_lineage
before insert or update on public.test_events
for each row execute function public.enforce_current_telemetry_lineage();

drop trigger if exists test_recordings_current_consent_lineage on public.test_recordings;
create trigger test_recordings_current_consent_lineage
before insert or update on public.test_recordings
for each row execute function public.enforce_current_telemetry_lineage();

drop trigger if exists test_feedback_current_consent_lineage on public.test_feedback;
create trigger test_feedback_current_consent_lineage
before insert or update on public.test_feedback
for each row execute function public.enforce_current_telemetry_lineage();

drop trigger if exists activity_ingest_failures_current_consent_lineage
  on public.activity_ingest_failures;
create trigger activity_ingest_failures_current_consent_lineage
before insert on public.activity_ingest_failures
for each row execute function public.enforce_current_telemetry_lineage();
