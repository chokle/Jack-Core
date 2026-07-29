begin;

do $test$
declare
  org_id uuid := '11111111-1111-4111-8111-111111111111';
  pilot_id uuid := '22222222-2222-4222-8222-222222222222';
  report_id uuid := '33333333-3333-4333-8333-333333333333';
  snapshot jsonb := '{"participantCount":2,"feedbackCount":1}'::jsonb;
  persisted_snapshot jsonb;
  persisted_requester text;
begin
  insert into public.organizations (id, name, status)
  values (org_id, 'Org', 'active');

  insert into public.pilots (id, organization_id, name, status)
  values (pilot_id, org_id, 'Pilot', 'active');

  insert into public.activity_report_runs (
    id,
    organization_id,
    pilot_id,
    requested_by_user_id,
    report_type,
    status,
    parameters,
    aggregate_snapshot,
    generated_at,
    retained_until
  )
  values (
    report_id,
    org_id,
    pilot_id,
    'report-admin',
    'pilot_summary',
    'completed',
    '{}'::jsonb,
    snapshot,
    '2026-07-27T00:00:00.000Z',
    '2027-07-27T00:00:00.000Z'
  );

  update public.activity_report_runs
    set requested_by_user_id = null
    where requested_by_user_id = 'report-admin';

  select aggregate_snapshot, requested_by_user_id
    into persisted_snapshot, persisted_requester
    from public.activity_report_runs
    where id = report_id;

  if persisted_snapshot is distinct from snapshot then
    raise exception 'expected pilot summary snapshot to remain unchanged after attribution removal';
  end if;

  if persisted_requester is not null then
    raise exception 'expected requester attribution to be removable without deleting the snapshot';
  end if;
end;
$test$;

rollback;
