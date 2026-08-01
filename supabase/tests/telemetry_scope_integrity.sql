-- Run after all migrations. Every fixture is rolled back.
begin;

do $security$
declare
  server_only_tables constant text[] := ARRAY[
    'chat_messages',
    'competencies',
    'interview_answers',
    'interview_sessions',
    'knowledge_candidates',
    'knowledge_edges',
    'knowledge_entries',
    'knowledge_nodes',
    'knowledge_write_log',
    'mentor_profiles',
    'parked_thoughts',
    'transcript_segments',
    'videos'
  ];
  disabled_rls_count integer;
  browser_grant_count integer;
  browser_rpc_count integer;
  mutable_rpc_count integer;
begin
  select count(*)
  into disabled_rls_count
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = any(server_only_tables)
    and not relation.relrowsecurity;

  if disabled_rls_count <> 0 then
    raise exception 'expected RLS on every server-only product table, found % disabled',
      disabled_rls_count;
  end if;

  select count(*)
  into browser_grant_count
  from information_schema.role_table_grants
  where grantee in ('anon', 'authenticated')
    and table_schema = 'public'
    and table_name = any(server_only_tables);

  if browser_grant_count <> 0 then
    raise exception 'expected no browser grants on server-only product tables, found %',
      browser_grant_count;
  end if;

  select count(*)
  into browser_rpc_count
  from pg_proc function_row
  join pg_namespace namespace on namespace.oid = function_row.pronamespace
  where namespace.nspname = 'public'
    and function_row.proname in (
      'match_knowledge_entries',
      'match_knowledge_nodes',
      'match_transcript_segments',
      'match_videos'
    )
    and (
      has_function_privilege('anon', function_row.oid, 'EXECUTE')
      or has_function_privilege('authenticated', function_row.oid, 'EXECUTE')
    );

  if browser_rpc_count <> 0 then
    raise exception 'expected no browser execution on internal match RPCs, found %',
      browser_rpc_count;
  end if;

  select count(*)
  into mutable_rpc_count
  from pg_proc function_row
  join pg_namespace namespace on namespace.oid = function_row.pronamespace
  where namespace.nspname = 'public'
    and function_row.proname in (
      'match_knowledge_entries',
      'match_knowledge_nodes',
      'match_transcript_segments',
      'match_videos'
    )
    and not coalesce(function_row.proconfig, '{}'::text[])
      @> ARRAY['search_path=public, extensions'];

  if mutable_rpc_count <> 0 then
    raise exception 'expected fixed search paths on internal match RPCs, found % mutable',
      mutable_rpc_count;
  end if;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'parked_thoughts'
      and indexdef like '%(interview_session_id)%'
  ) then
    raise exception 'expected an index for parked_thoughts(interview_session_id)';
  end if;
end;
$security$;

do $test$
declare
  org_a constant uuid := '10000000-0000-4000-8000-000000000001';
  org_b constant uuid := '10000000-0000-4000-8000-000000000002';
  pilot_a constant uuid := '20000000-0000-4000-8000-000000000001';
  pilot_b constant uuid := '20000000-0000-4000-8000-000000000002';
  mismatch_blocked boolean := false;
  scope_fk_count integer;
  unindexed_fk_count integer;
  browser_grant_count integer;
  service_role_table_count integer;
begin
  select count(*)
  into scope_fk_count
  from pg_constraint
  where contype = 'f'
    and array_length(conkey, 1) = 2
    and conrelid::regclass::text in (
      'pilot_memberships',
      'telemetry_consents',
      'test_sessions',
      'test_events',
      'activity_ingest_failures',
      'activity_report_runs',
      'admin_access_audit',
      'test_recordings',
      'test_feedback'
    );

  if scope_fk_count <> 9 then
    raise exception 'expected 9 organization/pilot foreign keys, found %', scope_fk_count;
  end if;

  select count(*)
  into unindexed_fk_count
  from pg_constraint constraint_row
  where constraint_row.contype = 'f'
    and constraint_row.connamespace = 'public'::regnamespace
    and constraint_row.conrelid::regclass::text in (
      'pilot_memberships',
      'telemetry_consents',
      'test_sessions',
      'test_events',
      'activity_ingest_failures',
      'activity_report_runs',
      'admin_access_audit',
      'test_recordings',
      'test_feedback'
    )
    and not exists (
      select 1
      from pg_index index_row
      where index_row.indrelid = constraint_row.conrelid
        and index_row.indisvalid
        and (index_row.indkey::smallint[])[0:cardinality(constraint_row.conkey) - 1]
          = constraint_row.conkey
    );

  if unindexed_fk_count <> 0 then
    raise exception 'expected every telemetry foreign key to have a covering index, found % missing', unindexed_fk_count;
  end if;

  select count(*)
  into browser_grant_count
  from information_schema.role_table_grants
  where grantee in ('anon', 'authenticated')
    and table_schema = 'public'
    and table_name in (
      'organizations',
      'pilots',
      'pilot_memberships',
      'platform_roles',
      'telemetry_consents',
      'test_sessions',
      'test_events',
      'activity_ingest_failures',
      'activity_report_runs',
      'admin_access_audit',
      'test_recordings',
      'test_feedback'
    );

  if browser_grant_count <> 0 then
    raise exception 'expected no browser grants on private telemetry tables, found %', browser_grant_count;
  end if;

  select count(distinct table_name)
  into service_role_table_count
  from information_schema.role_table_grants
  where grantee = 'service_role'
    and table_schema = 'public'
    and table_name in (
      'organizations',
      'pilots',
      'pilot_memberships',
      'platform_roles',
      'telemetry_consents',
      'test_sessions',
      'test_events',
      'activity_ingest_failures',
      'activity_report_runs',
      'admin_access_audit',
      'test_recordings',
      'test_feedback'
    );

  if service_role_table_count <> 12 then
    raise exception 'expected service-role grants on 12 private telemetry tables, found %', service_role_table_count;
  end if;

  insert into public.organizations (id, slug, name)
  values
    (org_a, 'scope-test-a', 'Scope Test A'),
    (org_b, 'scope-test-b', 'Scope Test B');

  insert into public.pilots (id, organization_id, name, status)
  values
    (pilot_a, org_a, 'Pilot A', 'active'),
    (pilot_b, org_b, 'Pilot B', 'active');

  insert into public.pilot_memberships (
    organization_id,
    pilot_id,
    user_id,
    role
  )
  values (org_a, pilot_a, 'valid-tester', 'tester');

  begin
    insert into public.pilot_memberships (
      organization_id,
      pilot_id,
      user_id,
      role
    )
    values (org_a, pilot_b, 'cross-org-tester', 'tester');
  exception
    when foreign_key_violation then
      mismatch_blocked := true;
  end;

  if not mismatch_blocked then
    raise exception 'cross-organization pilot membership was accepted';
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
      'cross-org-tester',
      org_a,
      pilot_b,
      'telemetry',
      'granted',
      'scope-test',
      'scope-test'
    );
  exception
    when foreign_key_violation then
      mismatch_blocked := true;
  end;

  if not mismatch_blocked then
    raise exception 'cross-organization telemetry consent was accepted';
  end if;

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
      '30000000-0000-4000-8000-000000000001',
      'valid-tester',
      org_a,
      pilot_a,
      'telemetry',
      'granted',
      'scope-test',
      'scope-test'
    ),
    (
      '30000000-0000-4000-8000-000000000002',
      'other-tester',
      org_a,
      pilot_a,
      'telemetry',
      'granted',
      'scope-test',
      'scope-test'
    ),
    (
      '30000000-0000-4000-8000-000000000003',
      'valid-tester',
      org_a,
      pilot_a,
      'screen',
      'granted',
      'scope-test',
      'scope-test'
    ),
    (
      '30000000-0000-4000-8000-000000000004',
      'other-tester',
      org_a,
      pilot_a,
      'screen',
      'granted',
      'scope-test',
      'scope-test'
    );

  mismatch_blocked := false;
  begin
    insert into public.test_sessions (
      id,
      actor_user_id,
      organization_id,
      pilot_id,
      app_session_id,
      telemetry_consent_id
    )
    values (
      '40000000-0000-4000-8000-000000000001',
      'valid-tester',
      org_a,
      pilot_a,
      '50000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002'
    );
  exception
    when check_violation then
      mismatch_blocked := true;
  end;

  if not mismatch_blocked then
    raise exception 'another actor consent was accepted by a test session';
  end if;

  mismatch_blocked := false;
  begin
    insert into public.test_sessions (
      id,
      actor_user_id,
      organization_id,
      pilot_id,
      app_session_id,
      telemetry_consent_id
    )
    values (
      '40000000-0000-4000-8000-000000000002',
      'valid-tester',
      org_a,
      pilot_a,
      '50000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000003'
    );
  exception
    when check_violation then
      mismatch_blocked := true;
  end;

  if not mismatch_blocked then
    raise exception 'wrong-scope consent was accepted as telemetry consent';
  end if;

  insert into public.test_sessions (
    id,
    actor_user_id,
    organization_id,
    pilot_id,
    app_session_id,
    telemetry_consent_id
  )
  values (
    '40000000-0000-4000-8000-000000000003',
    'valid-tester',
    org_a,
    pilot_a,
    '50000000-0000-4000-8000-000000000003',
    '30000000-0000-4000-8000-000000000001'
  );

  mismatch_blocked := false;
  begin
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
    values (
      '60000000-0000-4000-8000-000000000001',
      'valid-tester',
      org_a,
      pilot_a,
      '40000000-0000-4000-8000-000000000003',
      '50000000-0000-4000-8000-000000000003',
      'feature_viewed',
      now(),
      'library',
      '/library',
      1,
      'granted',
      '30000000-0000-4000-8000-000000000002',
      'scope-test',
      'scope-test',
      'desktop',
      'Other',
      'success'
    );
  exception
    when check_violation then
      mismatch_blocked := true;
  end;

  if not mismatch_blocked then
    raise exception 'another actor consent was accepted by a telemetry event';
  end if;

  mismatch_blocked := false;
  begin
    insert into public.test_recordings (
      tester_user_id,
      session_id,
      storage_path,
      organization_id,
      pilot_id,
      test_session_id,
      screen_consent_id
    )
    values (
      'valid-tester',
      'scoped-session',
      'scoped/mismatch.webm',
      org_a,
      pilot_a,
      '40000000-0000-4000-8000-000000000003',
      '30000000-0000-4000-8000-000000000004'
    );
  exception
    when check_violation then
      mismatch_blocked := true;
  end;

  if not mismatch_blocked then
    raise exception 'another actor screen consent was accepted by a recording';
  end if;

  mismatch_blocked := false;
  begin
    insert into public.activity_report_runs (
      organization_id,
      pilot_id,
      requested_by_user_id,
      report_type
    )
    values (org_a, pilot_b, 'cross-org-admin', 'pilot_summary');
  exception
    when foreign_key_violation then
      mismatch_blocked := true;
  end;

  if not mismatch_blocked then
    raise exception 'cross-organization report scope was accepted';
  end if;

  insert into public.test_recordings (
    tester_user_id,
    session_id,
    storage_path
  )
  values ('legacy-user', 'legacy-session', 'legacy/path.webm');

  begin
    insert into public.test_recordings (
      tester_user_id,
      session_id,
      storage_path,
      organization_id
    )
    values ('partial-user', 'partial-session', 'partial/path.webm', org_a);
    raise exception 'partially scoped recording was accepted';
  exception
    when check_violation then
      null;
  end;
end;
$test$;

rollback;
