import { supabase } from "./supabase.js";
import { logger } from "./logger.js";

const db = supabase as unknown as {
  from: (table: string) => any;
  storage: { from: (bucket: string) => { remove: (paths: string[]) => Promise<{ error: unknown }> } };
};
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Supabase Storage accepts at most 1,000 paths per remove call. Keep batches
// below that hard limit regardless of the project's Data API max_rows setting.
const RECORDING_DELETE_BATCH_SIZE = 500;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function expiredRows(
  table: string,
  fields: string,
  includeDeletionDue = false,
  limit?: number,
): Promise<Array<Record<string, unknown>>> {
  const now = new Date().toISOString();
  let retainedQuery = db.from(table).select(fields).lt("retained_until", now);
  if (limit !== undefined) retainedQuery = retainedQuery.limit(limit);
  const retained = await retainedQuery;
  if (retained.error) throw retained.error;
  let due = { data: [] as Array<Record<string, unknown>>, error: null as unknown };
  if (includeDeletionDue) {
    let dueQuery = db.from(table).select(fields).lt("deletion_due_at", now);
    if (limit !== undefined) dueQuery = dueQuery.limit(limit);
    due = await dueQuery;
  }
  if (due.error) throw due.error;
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of [...(retained.data ?? []), ...(due.data ?? [])]) {
    byId.set(String(row.id), row);
  }
  return [...byId.values()];
}

async function deleteExpiredRows(table: string, includeDeletionDue = false): Promise<number> {
  const rows = await expiredRows(table, "id", includeDeletionDue);
  const ids = rows.map((row) => row.id).filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return 0;
  const removed = await db.from(table).delete().in("id", ids);
  if (removed.error) throw removed.error;
  return ids.length;
}

async function deleteExpiredEvents(): Promise<number> {
  const now = new Date().toISOString();
  const [retained, due] = await Promise.all([
    db.from("test_events").select("event_id").lt("retained_until", now),
    db.from("test_events").select("event_id").lt("deletion_due_at", now),
  ]);
  if (retained.error) throw retained.error;
  if (due.error) throw due.error;
  const ids = unique(
    [...(retained.data ?? []), ...(due.data ?? [])]
      .map((row: Record<string, unknown>) => row["event_id"])
      .filter((id): id is string => typeof id === "string"),
  );
  if (ids.length === 0) return 0;
  const removed = await db.from("test_events").delete().in("event_id", ids);
  if (removed.error) throw removed.error;
  return ids.length;
}

async function deleteExpiredRecordings(): Promise<number> {
  let total = 0;
  while (true) {
    const rows = (
      await expiredRows(
        "test_recordings",
        "id,storage_path",
        true,
        RECORDING_DELETE_BATCH_SIZE,
      )
      ).slice(0, RECORDING_DELETE_BATCH_SIZE);
    if (rows.length === 0) return total;
    const validRows = rows.filter((row) => typeof row["id"] === "string");
    const ids = validRows.map((row) => row["id"] as string);
    if (ids.length === 0) {
      throw new Error("Recording rows are missing identifiers required for safe deletion.");
    }
    const paths = validRows
      .map((row) => row["storage_path"])
      .filter((path): path is string => typeof path === "string" && path.length > 0);
    if (paths.length > 0) {
      const removedObjects = await db.storage.from("jack-test-recordings").remove(paths);
      if (removedObjects.error) throw removedObjects.error;
    }
    const removedRows = await db.from("test_recordings").delete().in("id", ids);
    if (removedRows.error) throw removedRows.error;
    total += ids.length;
  }
}

async function scheduleCompletedPilotFeedback(): Promise<number> {
  const pilots = await db.from("pilots").select("id,ends_at").eq("status", "completed");
  if (pilots.error) throw pilots.error;
  let scheduled = 0;
  for (const pilot of pilots.data ?? []) {
    const base = pilot.ends_at ? new Date(String(pilot.ends_at)) : new Date();
    if (Number.isNaN(base.getTime())) continue;
    base.setUTCMonth(base.getUTCMonth() + 12);
    const feedback = await db
      .from("test_feedback")
      .select("id,retained_until")
      .eq("pilot_id", pilot.id)
      .lt("retained_until", base.toISOString());
    if (feedback.error) throw feedback.error;
    const missing = await db
      .from("test_feedback")
      .select("id,retained_until")
      .eq("pilot_id", pilot.id)
      .is("retained_until", null);
    if (missing.error) throw missing.error;
    const ids = [...(feedback.data ?? []), ...(missing.data ?? [])]
      .map((row: Record<string, unknown>) => row["id"])
      .filter((id: unknown): id is string => typeof id === "string");
    if (ids.length > 0) {
      const update = await db
        .from("test_feedback")
        .update({ retained_until: base.toISOString() })
        .in("id", ids);
      if (update.error) throw update.error;
      scheduled += ids.length;
    }
  }
  return scheduled;
}

async function scheduleCompletedPilotConsents(): Promise<number> {
  const pilots = await db.from("pilots").select("id,ends_at").eq("status", "completed");
  if (pilots.error) throw pilots.error;
  let scheduled = 0;
  for (const pilot of pilots.data ?? []) {
    const base = pilot.ends_at ? new Date(String(pilot.ends_at)) : new Date();
    if (Number.isNaN(base.getTime())) continue;
    base.setUTCMonth(base.getUTCMonth() + 24);
    const consents = await db
      .from("telemetry_consents")
      .select("id")
      .eq("pilot_id", pilot.id)
      .lt("retained_until", base.toISOString());
    if (consents.error) throw consents.error;
    const ids = (consents.data ?? [])
      .map((row: Record<string, unknown>) => row["id"])
      .filter((id: unknown): id is string => typeof id === "string");
    if (ids.length > 0) {
      const update = await db
        .from("telemetry_consents")
        .update({ retained_until: base.toISOString() })
        .in("id", ids);
      if (update.error) throw update.error;
      scheduled += ids.length;
    }
  }
  return scheduled;
}

export async function runTelemetryRetentionSweep(): Promise<Record<string, number>> {
  const feedbackScheduled = await scheduleCompletedPilotFeedback();
  const consentsScheduled = await scheduleCompletedPilotConsents();
  const [
    events,
    failures,
    reports,
    consents,
    audit,
    feedback,
    recordings,
    sessions,
  ] = await Promise.all([
    deleteExpiredEvents(),
    deleteExpiredRows("activity_ingest_failures"),
    deleteExpiredRows("activity_report_runs"),
    deleteExpiredRows("telemetry_consents"),
    deleteExpiredRows("admin_access_audit"),
    deleteExpiredRows("test_feedback", true),
    deleteExpiredRecordings(),
    deleteExpiredRows("test_sessions", true),
  ]);
  return {
    feedbackScheduled,
    consentsScheduled,
    events,
    failures,
    reports,
    consents,
    audit,
    feedback,
    recordings,
    sessions,
  };
}


export function startTelemetryRetentionWorker(): { stop: () => void } {
  if (process.env["TELEMETRY_RETENTION_ENABLED"] !== "true") {
    logger.info("telemetry retention worker disabled");
    return { stop: () => {} };
  }
  const sweep = () => {
    void runTelemetryRetentionSweep()
      .then((counts) => logger.info({ counts }, "telemetry retention sweep completed"))
      .catch((error) => logger.error({ err: error }, "telemetry retention sweep failed"));
  };
  sweep();
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
