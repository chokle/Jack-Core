-- DESTRUCTIVE: removes all Jack operational history. Stop operational writers and
-- restore the previous application revision before running this rollback.
-- Preserve an approved backup first if history must be recoverable. This script
-- does not restore deleted history, and must never be run automatically in prod.
-- Existing telemetry consent/session records and privacy functions are retained.
-- No CASCADE: an unexpected dependency aborts the entire transaction.
begin;

drop trigger if exists jack_operational_consent_purge on public.telemetry_consents;
drop trigger if exists jack_operational_account_purge on public.telemetry_account_deletion_fences;
-- Drops its two local triggers, indexes, and owned sequence with the table.
drop table if exists public.jack_operational_events;
drop function if exists public.validate_jack_operational_event();
drop function if exists public.purge_jack_operational_consent();
drop function if exists public.purge_jack_operational_account();

commit;
