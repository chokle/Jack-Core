import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  OperationalBus,
  type OperationalJournal,
  type OperationalContext,
} from "../operational-bus.js";
import {
  OperationalEventSchema,
  projectFieldState,
  projectCommandCentre,
  type OperationalEvent,
} from "@workspace/api-zod";

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../../supabase/migrations/20260906205400_jack_operational_events.sql",
  ),
  "utf8",
);
const existing = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../../supabase/migrations/20260831090000_durable_telemetry_withdrawals.sql",
  ),
  "utf8",
);
const rollback = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../../supabase/rollback/jack_operational_events.sql",
  ),
  "utf8",
);
function existingFunction(name: string) {
  const start = existing.indexOf(`create or replace function public.${name}(`);
  return existing.slice(start, existing.indexOf("$$;", start) + 3);
}
const org = "11111111-1111-4111-8111-111111111111";
const pilot = "22222222-2222-4222-8222-222222222222";
const session = "33333333-3333-4333-8333-333333333333";
const consent = "44444444-4444-4444-8444-444444444444";
const context: OperationalContext = {
  scope: { userId: "u", organizationId: org, siteId: null },
  sessionId: session,
  pilotId: pilot,
  consent: {
    id: consent,
    state: "granted",
    privacyNoticeVersion: "v1",
    consentVersion: "v1",
  },
};
const directory = mkdtempSync(resolve(tmpdir(), "jack-operational-journal-"));
let pg: PGlite;
const journal: OperationalJournal = {
  async append(c, event) {
    await pg.query(
      `insert into jack_operational_events(event_id,actor_user_id,organization_id,pilot_id,test_session_id,consent_id,event) values($1,$2,$3,$4,$5,$6,$7)`,
      [
        event.id,
        c.scope.userId,
        c.scope.organizationId,
        c.pilotId,
        c.sessionId,
        c.consent!.id,
        JSON.stringify(event),
      ],
    );
  },
  async load(c) {
    const result = await pg.query<{ event: OperationalEvent }>(
      `select event from jack_operational_events where actor_user_id=$1 and organization_id=$2 and pilot_id=$3 and test_session_id=$4 and consent_id=$5 order by sequence`,
      [
        c.scope.userId,
        c.scope.organizationId,
        c.pilotId,
        c.sessionId,
        c.consent!.id,
      ],
    );
    return result.rows.map((row) => OperationalEventSchema.parse(row.event));
  },
};
beforeAll(async () => {
  pg = new PGlite(directory);
  await pg.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table organizations(id uuid primary key);
    create table pilots(id uuid primary key, organization_id uuid, unique(organization_id,id));
    create table telemetry_consents(id uuid primary key, actor_user_id text, organization_id uuid, pilot_id uuid, scope text, state text, occurred_at timestamptz default now(),created_at timestamptz default now(),consent_sequence bigint generated always as identity);
    create table test_sessions(id uuid primary key,actor_user_id text,organization_id uuid,pilot_id uuid,telemetry_consent_id uuid,telemetry_status text,status text);
    create table pilot_memberships(user_id text,organization_id uuid,pilot_id uuid,role text,active boolean,valid_from timestamptz,valid_until timestamptz);
    create table telemetry_account_deletion_fences(actor_hash text primary key);
    grant select on all tables in schema public to service_role;
  `);
  await pg.exec(existingFunction("telemetry_consent_is_current"));
  await pg.exec(existingFunction("enforce_telemetry_account_deletion_fence"));
  await pg.exec(migration);
  await pg.exec(`insert into organizations values('${org}'); insert into pilots values('${pilot}','${org}');
    insert into telemetry_consents(id,actor_user_id,organization_id,pilot_id,scope,state) values('${consent}','u','${org}','${pilot}','telemetry','granted');
    insert into test_sessions values('${session}','u','${org}','${pilot}','${consent}','granted','active');
    insert into pilot_memberships values('u','${org}','${pilot}','tester',true,now()-interval '1 day',null);`);
}, 30000);
afterAll(async () => {
  await pg?.close();
  rmSync(directory, { recursive: true, force: true });
});

describe.sequential("durable operational journal and database fences", () => {
  it("rolls back atomically and reapplies the real migration without changing existing telemetry data", async () => {
    const existingData = () =>
      pg.query(`select
        (select jsonb_agg(t) from telemetry_consents t) as consents,
        (select jsonb_agg(t) from test_sessions t) as sessions,
        (select jsonb_agg(t) from pilot_memberships t) as memberships,
        (select jsonb_agg(t) from organizations t) as organizations,
        (select jsonb_agg(t) from pilots t) as pilots`);
    const before = (await existingData()).rows;
    await new OperationalBus(journal).publish(context, {
      type: "voice.listening.started",
      audience: "field",
      payload: {},
    });
    await pg.exec(
      "create view operational_rollback_dependency as select event_id from jack_operational_events",
    );
    await expect(pg.exec(rollback)).rejects.toThrow(/depend/);
    await pg.exec("rollback");
    expect(await journal.load(context)).toHaveLength(1);
    expect(
      (
        await pg.query(`select tgname from pg_trigger where tgname in
        ('jack_operational_consent_purge','jack_operational_account_purge')`)
      ).rows,
    ).toHaveLength(2);
    await pg.exec("drop view operational_rollback_dependency");
    await pg.exec(rollback);
    expect(
      (
        await pg.query(`select to_regclass('public.jack_operational_events') as journal,
        to_regclass('public.jack_operational_event_sequence') as sequence,
        to_regprocedure('public.validate_jack_operational_event()') as validation,
        to_regprocedure('public.purge_jack_operational_consent()') as consent_purge,
        to_regprocedure('public.purge_jack_operational_account()') as account_purge`)
      ).rows,
    ).toEqual([
      {
        journal: null,
        sequence: null,
        validation: null,
        consent_purge: null,
        account_purge: null,
      },
    ]);
    expect((await existingData()).rows).toEqual(before);
    expect(
      (
        await pg.query(`select proname from pg_proc where proname in
        ('telemetry_consent_is_current','enforce_telemetry_account_deletion_fence')`)
      ).rows,
    ).toHaveLength(2);
    await pg.exec(migration);
    expect(await journal.load(context)).toEqual([]);
    expect((await existingData()).rows).toEqual(before);
  });
  it("persists one transition stream and reconstructs HUD/admin state after process restart", async () => {
    const bus = new OperationalBus(journal);
    await bus.publish(context, {
      type: "task.dispatched",
      taskId: "t",
      audience: "field",
      payload: {},
    });
    await bus.publish(context, {
      type: "crew.otg.entered",
      audience: "field",
      payload: {},
      source: "crew_adapter",
    });
    await bus.publish(context, {
      type: "agent.task.changed",
      taskId: "internal",
      audience: "internal",
      payload: {
        agentId: "Dex",
        ownerId: "Foreman",
        status: "blocked",
        handoffTo: null,
        modelRoute: "approved-model",
      },
    });
    const before = await bus.read(context);
    await pg.close();
    pg = new PGlite(directory);
    const after = await new OperationalBus(journal).read(context);
    expect(after).toEqual(before);
    expect(after.history).toHaveLength(3);
    expect(after.state.connectivity).toBe("OTG");
    expect(after.state.internalTasks.internal.status).toBe("blocked");
    expect(JSON.stringify(projectFieldState(after.state))).not.toMatch(
      /Dex|Foreman|internal|modelRoute/,
    );
    expect(
      projectCommandCentre(after.state, after.history).history,
    ).toHaveLength(3);
  });
  it("enforces session, org, site and actor provenance before append", async () => {
    const event = OperationalEventSchema.parse({
      version: 1,
      id: randomUUID(),
      sequence: 1,
      scope: context.scope,
      sessionId: session,
      type: "safety.alert",
      audience: "field",
      payload: {},
    });
    for (const corrupt of [
      { ...event, scope: { ...event.scope, userId: "other" } },
      { ...event, scope: { ...event.scope, organizationId: randomUUID() } },
      { ...event, scope: { ...event.scope, siteId: "foreign-site" } },
      { ...event, sessionId: randomUUID() },
    ]) {
      await expect(journal.append(context, corrupt)).rejects.toThrow(
        /provenance/,
      );
    }
    expect(
      await journal.load({
        ...context,
        scope: { ...context.scope, userId: "other" },
      }),
    ).toEqual([]);
  });
  it("rejects a duplicate event ID without changing replayed state or history", async () => {
    const before = await new OperationalBus(journal).read(context);
    await expect(journal.append(context, before.history[0])).rejects.toThrow(
      /duplicate key/,
    );
    expect(await new OperationalBus(journal).read(context)).toEqual(before);
    expect(new Set(before.history.map((event) => event.id)).size).toBe(
      before.history.length,
    );
  });
  it("denies direct client reads and writes and prevents service-role updates", async () => {
    for (const role of ["anon", "authenticated"]) {
      await pg.exec(`set role ${role}`);
      await expect(
        pg.query("select * from jack_operational_events"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        pg.query(
          `insert into jack_operational_events(event_id) values('${randomUUID()}')`,
        ),
      ).rejects.toThrow(/permission denied/);
      await pg.exec("reset role");
    }
    await pg.exec("set role service_role");
    await expect(
      pg.query(`update jack_operational_events set event='{}'`),
    ).rejects.toThrow(/permission denied/);
    await new OperationalBus(journal).publish(context, {
      type: "voice.listening.started",
      audience: "field",
      payload: {},
    });
    expect(await journal.load(context)).toHaveLength(4);
    await pg.exec("reset role");
  });
  it("removes history on withdrawal and rejects delayed old-consent writes", async () => {
    await pg.exec(
      `insert into telemetry_consents(id,actor_user_id,organization_id,pilot_id,scope,state,occurred_at) values('${randomUUID()}','u','${org}','${pilot}','telemetry','withdrawn',clock_timestamp()+interval '1 second')`,
    );
    expect(await journal.load(context)).toEqual([]);
    await expect(
      new OperationalBus(journal).publish(context, {
        type: "voice.listening.started",
        audience: "field",
        payload: {},
      }),
    ).rejects.toThrow(/consent/);
  });
  it("purges history on account deletion and fences subsequent inserts", async () => {
    const nextConsent = randomUUID();
    await pg.exec(`insert into telemetry_consents(id,actor_user_id,organization_id,pilot_id,scope,state,occurred_at) values('${nextConsent}','u','${org}','${pilot}','telemetry','granted',clock_timestamp()+interval '2 seconds');
      update test_sessions set telemetry_consent_id='${nextConsent}' where id='${session}';`);
    const nextContext = {
      ...context,
      consent: { ...context.consent!, id: nextConsent },
    };
    await new OperationalBus(journal).publish(nextContext, {
      type: "voice.listening.started",
      audience: "field",
      payload: {},
    });
    expect(await journal.load(nextContext)).toHaveLength(1);
    await pg.exec(
      `insert into telemetry_account_deletion_fences values(encode(sha256(convert_to('u','UTF8')),'hex'))`,
    );
    expect(await journal.load(nextContext)).toEqual([]);
    await expect(
      new OperationalBus(journal).publish(nextContext, {
        type: "voice.listening.started",
        audience: "field",
        payload: {},
      }),
    ).rejects.toThrow(/account deletion/);
  });
});
