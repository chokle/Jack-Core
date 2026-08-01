-- Run after all migrations. Every fixture is rolled back.
begin;

do $test$
declare
  org_a constant uuid := '11111111-1111-4111-8111-111111111111';
  org_b constant uuid := '11111111-1111-4111-8111-111111111112';
  pilot_a constant uuid := '22222222-2222-4222-8222-222222222221';
  pilot_b constant uuid := '22222222-2222-4222-8222-222222222222';
  deleting_user constant text := 'report-admin';
  other_user constant text := 'other-admin';
  report_a constant uuid := '33333333-3333-4333-8333-333333333331';
  report_b constant uuid := '33333333-3333-4333-8333-333333333332';
  other_report constant uuid := '33333333-3333-4333-8333-333333333333';
  consent_a constant uuid := '44444444-4444-4444-8444-444444444441';
  consent_b constant uuid := '44444444-4444-4444-8444-444444444442';
  other_consent constant uuid := '44444444-4444-4444-8444-444444444443';
  session_a constant uuid := '55555555-5555-4555-8555-555555555551';
  session_b constant uuid := '55555555-5555-4555-8555-555555555552';
  other_session constant uuid := '55555555-5555-4555-8555-555555555553';
  app_session_a constant uuid := '66666666-6666-4666-8666-666666666661';
  app_session_b constant uuid := '66666666-6666-4666-8666-666666666662';
  other_app_session constant uuid := '66666666-6666-4666-8666-666666666663';
  snapshot_a constant jsonb := '{"participantCount":2,"feedbackCount":1}'::jsonb;
  snapshot_b constant jsonb := '{"participantCount":3,"feedbackCount":2}'::jsonb;
  mismatch_blocked boolean := false;
begin
  insert into public.organizations (id, slug, name, status)
  values
    (org_a, 'pr17-report-integrity-a', 'Org A', 'active'),
    (org_b, 'pr17-report-integrity-b', 'Org B', 'active');

  insert into public.pilots (id, organization_id, name, status)
  values
    (pilot_a, org_a, 'Pilot A', 'active'),
    (pilot_b, org_b, 'Pilot B', 'active');

  insert into public.activity_report_runs (
    id,
    organization_id,
    pilot_id,
    requested_by_user_id,
    report_type,
    aggregate_snapshot
  )
  values
    (report_a, org_a, pilot_a, deleting_user, 'pilot_summary', snapshot_a),
    (report_b, org_b, pilot_b, deleting_user, 'pilot_summary', snapshot_b),
    (
      other_report,
      org_a,
      pilot_a,
      other_user,
      'pilot_summary',
      '{"participantCount":1}'::jsonb
    );

  insert into public.telemetry_consents (
    id,
    actor_user_id,
    organization_id,
    pilot_id,
    scope,
    state,
    privacy_notice_version,
    consent_version
  )
  values
    (
      consent_a,
      deleting_user,
      org_a,
      pilot_a,
      'telemetry',
      'granted',
      'pr17-integrity',
      'pr17-integrity'
    ),
    (
      consent_b,
      deleting_user,
      org_b,
      pilot_b,
      'telemetry',
      'granted',
      'pr17-integrity',
      'pr17-integrity'
    ),
    (
      other_consent,
      other_user,
      org_a,
      pilot_a,
      'telemetry',
      'granted',
      'pr17-integrity',
      'pr17-integrity'
    );

  insert into public.test_sessions (
    id,
    actor_user_id,
    organization_id,
    pilot_id,
    app_session_id,
    telemetry_consent_id
  )
  values
    (session_a, deleting_user, org_a, pilot_a, app_session_a, consent_a),
    (session_b, deleting_user, org_b, pilot_b, app_session_b, consent_b),
    (
      other_session,
      other_user,
      org_a,
      pilot_a,
      other_app_session,
      other_consent
    );

  insert into public.test_events (
    event_id,
    actor_user_id,
    organization_id,
    pilot_id,
    test_session_id,
    app_session_id,
    event_type,
    occurred_at,
    surface,
    route,
    schema_version,
    consent_state,
    consent_id,
    privacy_notice_version,
    consent_version,
    device_category,
    browser_family,
    result
  )
  values
    (
      '77777777-7777-4777-8777-777777777771',
      deleting_user,
      org_a,
      pilot_a,
      session_a,
      app_session_a,
      'feature_viewed',
      now(),
      'library',
      '/library',
      1,
      'granted',
      consent_a,
      'pr17-integrity',
      'pr17-integrity',
      'desktop',
      'Other',
      'success'
    ),
    (
      '77777777-7777-4777-8777-777777777772',
      deleting_user,
      org_b,
      pilot_b,
      session_b,
      app_session_b,
      'feature_viewed',
      now(),
      'library',
      '/library',
      1,
      'granted',
      consent_b,
      'pr17-integrity',
      'pr17-integrity',
      'desktop',
      'Other',
      'success'
    ),
    (
      '77777777-7777-4777-8777-777777777773',
      other_user,
      org_a,
      pilot_a,
      other_session,
      other_app_session,
      'feature_viewed',
      now(),
      'library',
      '/library',
      1,
      'granted',
      other_consent,
      'pr17-integrity',
      'pr17-integrity',
      'desktop',
      'Other',
      'success'
    );

  update public.activity_report_runs
  set requested_by_user_id = null
  where requested_by_user_id = deleting_user;

  delete from public.test_events where actor_user_id = deleting_user;
  delete from public.test_sessions where actor_user_id = deleting_user;
  delete from public.telemetry_consents where actor_user_id = deleting_user;

  if (
    select count(*)
    from public.activity_report_runs
    where id in (report_a, report_b)
  ) <> 2 then
    raise exception 'expected both shared report snapshots to remain';
  end if;

  if exists (
    select 1
    from public.activity_report_runs
    where id in (report_a, report_b)
      and requested_by_user_id is not null
  ) then
    raise exception 'expected deleting requester attribution to be null';
  end if;

  if not exists (
    select 1
    from public.activity_report_runs
    where id = report_a
      and aggregate_snapshot = snapshot_a
  ) or not exists (
    select 1
    from public.activity_report_runs
    where id = report_b
      and aggregate_snapshot = snapshot_b
  ) then
    raise exception 'expected de-identified report aggregates to remain unchanged';
  end if;

  if not exists (
    select 1
    from public.activity_report_runs
    where id = other_report
      and requested_by_user_id = other_user
  ) then
    raise exception 'expected another requester report to remain unchanged';
  end if;

  if exists (
    select 1 from public.test_events where actor_user_id = deleting_user
  ) or exists (
    select 1 from public.test_sessions where actor_user_id = deleting_user
  ) or exists (
    select 1 from public.telemetry_consents where actor_user_id = deleting_user
  ) then
    raise exception 'expected genuinely attributable telemetry to be deleted';
  end if;

  if (
    select count(*) from public.test_events where actor_user_id = other_user
  ) <> 1 or (
    select count(*) from public.test_sessions where actor_user_id = other_user
  ) <> 1 or (
    select count(*) from public.telemetry_consents where actor_user_id = other_user
  ) <> 1 then
    raise exception 'expected another user telemetry to remain intact';
  end if;

  if (
    select count(*) from public.organizations where id in (org_a, org_b)
  ) <> 2 or (
    select count(*) from public.pilots where id in (pilot_a, pilot_b)
  ) <> 2 then
    raise exception 'expected organizations and pilots to remain intact';
  end if;

  begin
    insert into public.activity_report_runs (
      organization_id,
      pilot_id,
      requested_by_user_id,
      report_type
    )
    values (org_a, pilot_b, deleting_user, 'pilot_summary');
  exception
    when foreign_key_violation then
      mismatch_blocked := true;
  end;

  if not mismatch_blocked then
    raise exception 'cross-organization report scope was accepted';
  end if;

  mismatch_blocked := false;
  begin
    insert into public.telemetry_consents (
      actor_user_id,
      organization_id,
      pilot_id,
      scope,
      state,
      privacy_notice_version,
      consent_version
    )
    values (
      deleting_user,
      org_a,
      pilot_b,
      'telemetry',
      'granted',
      'pr17-integrity',
      'pr17-integrity'
    );
  exception
    when foreign_key_violation then
      mismatch_blocked := true;
  end;

  if not mismatch_blocked then
    raise exception 'cross-organization telemetry scope was accepted';
  end if;
end;
$test$;

rollback;
