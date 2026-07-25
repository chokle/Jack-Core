import { beforeEach, describe, expect, it, vi } from "vitest";

const remove = vi.hoisted(() => vi.fn(async () => ({ error: null })));

vi.mock("../../lib/supabase.js", async () => {
  const mocks = await import("./mocks.js");
  return {
    supabase: {
      from: mocks.fake.from.bind(mocks.fake),
      storage: { from: () => ({ remove }) },
    },
  };
});

import { fake, resetMocks } from "./mocks.js";
import { runTelemetryRetentionSweep } from "../telemetry-retention.js";

beforeEach(() => {
  resetMocks();
  remove.mockClear();
  fake.tables.pilots = [];
  for (const table of [
    "test_events",
    "activity_ingest_failures",
    "activity_report_runs",
    "telemetry_consents",
    "admin_access_audit",
    "test_feedback",
    "test_recordings",
    "test_sessions",
  ]) {
    fake.tables[table] = [];
  }
});

describe("telemetry retention sweep", () => {
  it("deletes expired categories and private recording objects but preserves future rows", async () => {
    const past = "2020-01-01T00:00:00.000Z";
    const future = "2099-01-01T00:00:00.000Z";
    fake.tables.test_events = [
      { event_id: "event-expired", retained_until: past },
      { event_id: "event-future", retained_until: future },
    ];
    fake.tables.activity_ingest_failures = [
      { id: "failure-expired", retained_until: past },
      { id: "failure-future", retained_until: future },
    ];
    fake.tables.test_recordings = [
      { id: "recording-expired", storage_path: "recordings/expired.webm", retained_until: past },
      { id: "recording-future", storage_path: "recordings/future.webm", retained_until: future },
    ];
    fake.tables.test_sessions = [
      { id: "session-due", deletion_due_at: past },
      { id: "session-future", deletion_due_at: future },
    ];

    const counts = await runTelemetryRetentionSweep();
    expect(counts).toMatchObject({ events: 1, failures: 1, recordings: 1, sessions: 1 });
    expect(remove).toHaveBeenCalledWith(["recordings/expired.webm"]);
    expect(fake.tables.test_events).toEqual([
      expect.objectContaining({ event_id: "event-future" }),
    ]);
    expect(fake.tables.test_recordings).toEqual([
      expect.objectContaining({ id: "recording-future" }),
    ]);
  });
});
