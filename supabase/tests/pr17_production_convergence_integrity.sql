-- Run after the complete PR #17 convergence sequence.
-- All synthetic fixtures roll back.

begin;

do $test$
declare
  org_a constant uuid := '81111111-1111-4111-8111-111111111111';
  org_b constant uuid := '81111111-1111-4111-8111-111111111112';
  pilot_a constant uuid := '82222222-2222-4222-8222-222222222221';
  pilot_b constant uuid := '82222222-2222-4222-8222-222222222222';
  video_id constant uuid := '83333333-3333-4333-8333-333333333333';
  report_id constant uuid := '84444444-4444-4444-8444-444444444444';
  cross_scope_blocked boolean := false;
  video_default text;
  ledger_count integer;
  ledger_count_extra integer;
  inserted_video_count integer;
begin
  insert into public.knowledge_nodes (id, kind, label, trade)
  values
    ('pr17:contributor', 'mentor', 'Synthetic mentor', 'Welder'),
    ('pr17:concept', 'concept', 'Synthetic concept', 'Welder');

  insert into public.knowledge_edges (id, source_id, target_id, kind)
  values (
    'pr17:contributor-edge',
    'pr17:contributor',
    'pr17:concept',
    'contributor'
  );

  insert into public.organizations (id, slug, name, status)
  values
    (org_a, 'pr17-convergence-a', 'PR17 Org A', 'active'),
    (org_b, 'pr17-convergence-b', 'PR17 Org B', 'active');

  insert into public.pilots (id, organization_id, name, status)
  values
    (pilot_a, org_a, 'PR17 Pilot A', 'active'),
    (pilot_b, org_b, 'PR17 Pilot B', 'active');

  insert into public.activity_report_runs (
    id,
    organization_id,
    pilot_id,
    requested_by_user_id,
    report_type,
    aggregate_snapshot
  )
  values (
    report_id,
    org_a,
    pilot_a,
    null,
    'pilot_summary',
    '{"participantCount":2}'::jsonb
  );

  insert into public.videos (
    id,
    title,
    trade,
    status
  )
  values (video_id, 'PR17 synthetic retained video', 'Welder', 'completed')
  on conflict (id) do update set
    title = excluded.title,
    trade = excluded.trade,
    status = excluded.status;

  GET DIAGNOSTICS inserted_video_count = ROW_COUNT;

  insert into public.knowledge_nodes (id, kind, label, trade)
  values
    ('pr17:existing-source', 'mentor', 'Synthetic existing source', 'Welder'),
    ('pr17:existing-target', 'concept', 'Synthetic existing target', 'Welder')
  on conflict (id) do update set
    kind = excluded.kind,
    label = excluded.label,
    trade = excluded.trade;

  insert into public.knowledge_edges (id, source_id, target_id, kind)
  values (
    'pr17:existing-edge',
    'pr17:existing-source',
    'pr17:existing-target',
    'knowledge'
  )
  on conflict (id) do update set
    source_id = excluded.source_id,
    target_id = excluded.target_id,
    kind = excluded.kind;

  if inserted_video_count = 0 then
    raise exception 'synthetic retained video seed was not applied';
  end if;

  if not exists (
    select 1
    from public.videos
    where id = video_id
      and title = 'PR17 synthetic retained video'
      and status = 'completed'
      and trade = 'Welder'
  ) then
    raise exception 'existing video did not survive convergence';
  end if;

  if not exists (
    select 1
    from public.knowledge_edges
    where id = 'pr17:existing-edge'
      and source_id = 'pr17:existing-source'
      and target_id = 'pr17:existing-target'
      and kind = 'knowledge'
  ) then
    raise exception 'existing knowledge edge did not survive convergence';
  end if;

  if not exists (
    select 1
    from public.knowledge_edges
    where id = 'pr17:contributor-edge'
      and kind = 'contributor'
  ) then
    raise exception 'contributor knowledge edge was not accepted';
  end if;

  if not exists (
    select 1
    from public.activity_report_runs
    where id = report_id
      and requested_by_user_id is null
      and aggregate_snapshot = '{"participantCount":2}'::jsonb
  ) then
    raise exception 'de-identified report did not survive convergence';
  end if;

  begin
    insert into public.activity_report_runs (
      organization_id,
      pilot_id,
      requested_by_user_id,
      report_type
    )
    values (org_a, pilot_b, 'synthetic-user', 'pilot_summary');
  exception
    when foreign_key_violation then
      cross_scope_blocked := true;
  end;

  if not cross_scope_blocked then
    raise exception 'cross-organization report scope was accepted';
  end if;

  select pg_get_expr(ad.adbin, ad.adrelid)
    into video_default
  from pg_attribute a
  join pg_attrdef ad
    on ad.adrelid = a.attrelid
   and ad.adnum = a.attnum
  where a.attrelid = 'public.videos'::regclass
    and a.attname = 'status';

  if video_default is distinct from '''queued''::text' then
    raise exception 'videos.status default is not queued';
  end if;

  if has_table_privilege('anon', 'public.command_centre_state', 'select')
    or has_table_privilege(
      'authenticated',
      'public.command_centre_state',
      'select'
    )
    or has_table_privilege(
      'anon',
      'public.command_centre_playbook_runs',
      'select'
    )
    or has_table_privilege(
      'authenticated',
      'public.command_centre_playbook_runs',
      'select'
    ) then
    raise exception 'browser Command Centre grants survived reconciliation';
  end if;

  select count(*)
    into ledger_count
  from supabase_migrations.schema_migrations
  where version in (
    '20260701010000',
    '20260708171400',
    '20260717054029',
    '20260717054229',
    '20260724091752',
    '20260724143000',
    '20260727042325',
    '20260727123000',
    '20260801002756'
  );

  if ledger_count <> 9 then
    raise exception 'expected nine PR17 migration ledger entries, found %', ledger_count;
  end if;

  select count(*)
    into ledger_count_extra
  from supabase_migrations.schema_migrations
  where version not in (
    '20260701010000',
    '20260708171400',
    '20260717054029',
    '20260717054229',
    '20260724091752',
    '20260724143000',
    '20260727042325',
    '20260727123000',
    '20260801002756'
  );

  if ledger_count_extra <> 0 then
    raise exception 'unexpected migration versions exist in ledger';
  end if;
end;
$test$;

rollback;
