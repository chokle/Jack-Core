-- Crash-safe Living Memory identity writes.
--
-- This additive migration is ordered after the durable account/source tombstone
-- schema and before trigger enforcement. Apply it before deploying the compatible
-- API: the application no longer writes video/contributor identity directly.

create or replace function public.apply_fenced_video_graph_identity(
  p_video_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_video public.videos%rowtype;
  v_actor_user_id text;
  v_actor_hash text;
  v_trade text;
  v_video_node_id text := 'video:' || p_video_id::text;
  v_contributor_node_id text;
  v_parent_node_id text;
  v_old_contributor_ids text[] := '{}'::text[];
  v_now timestamptz;
begin
  if p_video_id is null then
    raise exception 'video id is required for graph sync'
      using errcode = '22023';
  end if;

  -- Serialize duplicate/retry work for one source even when the source row has
  -- already disappeared.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('video:' || p_video_id::text, 20260831)
  );

  select video.*
  into v_video
  from public.videos video
  where video.id = p_video_id
  for update;

  -- A delayed job after an ordinary video deletion may only remove stale graph
  -- identity; it must never recreate it. Capture contributor links before the
  -- video-node cascade, then prune only contributors with no other video source.
  if not found then
    select coalesce(
      pg_catalog.array_agg(distinct edge.source_id),
      '{}'::text[]
    )
    into v_old_contributor_ids
    from public.knowledge_edges edge
    join public.knowledge_nodes node on node.id = edge.source_id
    where edge.target_id = v_video_node_id
      and edge.kind = 'video'
      and node.kind = 'contributor';

    delete from public.knowledge_nodes node
    where node.id = v_video_node_id
      and node.kind = 'video';

    delete from public.knowledge_nodes node
    where node.id = any(v_old_contributor_ids)
      and node.kind = 'contributor'
      and not exists (
        select 1
        from public.knowledge_edges edge
        where edge.source_id = node.id
          and edge.kind = 'video'
      );
    return false;
  end if;

  v_actor_user_id := nullif(
    pg_catalog.btrim(v_video.uploader_user_id),
    ''
  );

  -- Whole-account deletion uses this exact raw-actor lock. The video row is
  -- already row-locked, so its owner cannot change while authority is checked.
  if v_actor_user_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_actor_user_id, 20260831)
    );
    v_actor_hash := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(v_actor_user_id, 'UTF8')),
      'hex'
    );
  end if;

  -- Both checks happen after the actor lock and therefore observe a deletion
  -- transaction that won the lock before this writer. Source tombstones remain
  -- authoritative after the videos row itself has been removed.
  if exists (
    select 1
    from private.account_deletion_source_fences fence
    where fence.source_type = 'video'
      and fence.source_id = p_video_id::text
  ) then
    raise exception 'video graph source is fenced by account deletion'
      using errcode = 'P0001';
  end if;

  if v_actor_hash is not null and exists (
    select 1
    from public.telemetry_account_deletion_fences fence
    where fence.actor_hash = v_actor_hash
  ) then
    raise exception 'video graph actor is fenced by account deletion'
      using errcode = 'P0001';
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_trade := nullif(pg_catalog.btrim(v_video.trade), '');
  v_parent_node_id := case
    when v_trade is null then '__jack__'
    else 'topic:' || v_trade
  end;
  v_contributor_node_id := case
    when v_actor_user_id is null then null
    else 'contributor:' || v_actor_user_id
  end;

  -- Capture prior attribution before reconciling incident structural edges.
  -- This also handles an uploader change without retaining the old contributor.
  select coalesce(
    pg_catalog.array_agg(distinct edge.source_id),
    '{}'::text[]
  )
  into v_old_contributor_ids
  from public.knowledge_edges edge
  join public.knowledge_nodes node on node.id = edge.source_id
  where edge.target_id = v_video_node_id
    and edge.kind = 'video'
    and node.kind = 'contributor';

  insert into public.knowledge_nodes (
    id, kind, label, updated_at
  ) values (
    '__jack__', 'core', 'JACK', v_now
  )
  on conflict (id) do update
    set kind = excluded.kind,
        label = excluded.label,
        updated_at = excluded.updated_at;

  if v_trade is not null then
    insert into public.knowledge_nodes (
      id, kind, label, trade, updated_at
    ) values (
      'topic:' || v_trade, 'topic', v_trade, v_trade, v_now
    )
    on conflict (id) do update
      set kind = excluded.kind,
          label = excluded.label,
          trade = excluded.trade,
          updated_at = excluded.updated_at;
  end if;

  -- Minimal competency scaffolding never overwrites richer seeded rows.
  insert into public.knowledge_nodes (
    id, kind, label, ref_id, meta, updated_at
  )
  select
    'comp:' || code,
    'competency',
    code,
    code,
    pg_catalog.jsonb_build_object('code', code),
    v_now
  from (
    select distinct pg_catalog.btrim(raw_code) as code
    from pg_catalog.unnest(
      coalesce(v_video.competency_codes, '{}'::text[])
    ) raw_code
    where pg_catalog.btrim(raw_code) <> ''
  ) codes
  on conflict (id) do nothing;

  insert into public.knowledge_nodes (
    id,
    kind,
    label,
    trade,
    ref_id,
    meta,
    updated_at
  ) values (
    v_video_node_id,
    'video',
    v_video.title,
    v_trade,
    p_video_id::text,
    pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'status', v_video.status,
        'trade', v_trade,
        'description', v_video.description,
        'competencyCodes', coalesce(v_video.competency_codes, '{}'::text[]),
        -- Legacy rows without an attributable actor are scrubbed rather than
        -- minting un-fenceable email/name metadata.
        'uploaderUserId', v_actor_user_id,
        'uploaderEmail', case
          when v_actor_user_id is null then null
          else nullif(pg_catalog.btrim(v_video.uploader_email), '')
        end,
        'uploaderName', case
          when v_actor_user_id is null then null
          else nullif(pg_catalog.btrim(v_video.uploader_name), '')
        end,
        'createdAt', v_video.created_at,
        'updatedAt', coalesce(v_video.updated_at, v_video.created_at)
      )
    ),
    v_now
  )
  on conflict (id) do update
    set kind = excluded.kind,
        label = excluded.label,
        trade = excluded.trade,
        ref_id = excluded.ref_id,
        meta = excluded.meta,
        updated_at = excluded.updated_at;

  if v_contributor_node_id is not null then
    insert into public.knowledge_nodes (
      id,
      kind,
      label,
      trade,
      ref_id,
      meta,
      updated_at
    ) values (
      v_contributor_node_id,
      'contributor',
      coalesce(
        nullif(pg_catalog.btrim(v_video.uploader_name), ''),
        nullif(pg_catalog.btrim(v_video.uploader_email), ''),
        'Contributor'
      ),
      v_trade,
      v_actor_user_id,
      pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'userId', v_actor_user_id,
          'email', nullif(pg_catalog.btrim(v_video.uploader_email), ''),
          'name', nullif(pg_catalog.btrim(v_video.uploader_name), ''),
          'trade', v_trade
        )
      ),
      v_now
    )
    on conflict (id) do update
      set kind = excluded.kind,
          label = excluded.label,
          trade = excluded.trade,
          ref_id = excluded.ref_id,
          meta = excluded.meta,
          updated_at = excluded.updated_at;
  end if;

  -- Preserve video-to-knowledge provenance, which belongs to distillation.
  -- Every other edge touching the video is reconciled in this transaction.
  delete from public.knowledge_edges edge
  where edge.source_id = v_video_node_id
    and edge.kind <> 'knowledge';
  delete from public.knowledge_edges edge
  where edge.target_id = v_video_node_id;

  if v_trade is not null then
    insert into public.knowledge_edges (
      id, source_id, target_id, kind, weight, meta
    ) values (
      'e:__jack__->topic:' || v_trade,
      '__jack__',
      'topic:' || v_trade,
      'topic',
      1,
      '{}'::jsonb
    )
    on conflict (id) do update
      set source_id = excluded.source_id,
          target_id = excluded.target_id,
          kind = excluded.kind,
          weight = excluded.weight,
          meta = excluded.meta;
  end if;

  if v_contributor_node_id is null then
    insert into public.knowledge_edges (
      id, source_id, target_id, kind, weight, meta
    ) values (
      'e:' || v_parent_node_id || '->' || v_video_node_id,
      v_parent_node_id,
      v_video_node_id,
      'video',
      1,
      '{}'::jsonb
    )
    on conflict (id) do update
      set source_id = excluded.source_id,
          target_id = excluded.target_id,
          kind = excluded.kind,
          weight = excluded.weight,
          meta = excluded.meta;
  else
    insert into public.knowledge_edges (
      id, source_id, target_id, kind, weight, meta
    ) values (
      'e:' || v_parent_node_id || '->' || v_contributor_node_id,
      v_parent_node_id,
      v_contributor_node_id,
      'contributor',
      1,
      '{}'::jsonb
    )
    on conflict (id) do update
      set source_id = excluded.source_id,
          target_id = excluded.target_id,
          kind = excluded.kind,
          weight = excluded.weight,
          meta = excluded.meta;

    insert into public.knowledge_edges (
      id, source_id, target_id, kind, weight, meta
    ) values (
      'e:' || v_contributor_node_id || '->' || v_video_node_id,
      v_contributor_node_id,
      v_video_node_id,
      'video',
      1,
      pg_catalog.jsonb_build_object(
        'role', 'uploader',
        'userId', v_actor_user_id
      )
    )
    on conflict (id) do update
      set source_id = excluded.source_id,
          target_id = excluded.target_id,
          kind = excluded.kind,
          weight = excluded.weight,
          meta = excluded.meta;
  end if;

  insert into public.knowledge_edges (
    id, source_id, target_id, kind, weight, meta
  )
  select
    'e:' || v_video_node_id || '->comp:' || code,
    v_video_node_id,
    'comp:' || code,
    'competency',
    1,
    '{}'::jsonb
  from (
    select distinct pg_catalog.btrim(raw_code) as code
    from pg_catalog.unnest(
      coalesce(v_video.competency_codes, '{}'::text[])
    ) raw_code
    where pg_catalog.btrim(raw_code) <> ''
  ) codes
  on conflict (id) do update
    set source_id = excluded.source_id,
        target_id = excluded.target_id,
        kind = excluded.kind,
        weight = excluded.weight,
        meta = excluded.meta;

  -- Delete only now-orphaned old contributor identities. Shared concept/topic/
  -- competency nodes are deliberately untouched.
  delete from public.knowledge_nodes node
  where node.id = any(v_old_contributor_ids)
    and node.kind = 'contributor'
    and not exists (
      select 1
      from public.knowledge_edges edge
      where edge.source_id = node.id
        and edge.kind = 'video'
    );

  return true;
end;
$$;

revoke all on function public.apply_fenced_video_graph_identity(uuid)
  from public, anon, authenticated;
grant execute on function public.apply_fenced_video_graph_identity(uuid)
  to service_role;

comment on function public.apply_fenced_video_graph_identity(uuid) is
  'Service-role-only atomic video/contributor graph sync serialized with durable whole-account deletion fences.';
