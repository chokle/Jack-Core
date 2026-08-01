import { beforeEach, describe, expect, it, vi } from "vitest";

const remove = vi.hoisted(() =>
  vi.fn<(paths: string[]) => Promise<{ error: unknown }>>(async () => ({ error: null })),
);

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
import {
  runTelemetryRetentionSweep,
  startTelemetryRetentionWorker,
} from "../telemetry-retention.js";

beforeEach(() => {
  resetMocks();
  remove.mockClear();
  remove.mockResolvedValue({ error: null });
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
  it("returns zero recording deletions when no recordings are due", async () => {
    const counts = await runTelemetryRetentionSweep();
    expect(counts.recordings).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes all valid recording rows in the batch and advances state", async () => {
    const past = "2020-01-01T00:00:00.000Z";
    fake.tables.test_recordings = [
      { id: "recording-valid-1", storage_path: "recordings/one.webm", retained_until: past },
      { id: "recording-valid-2", storage_path: "recordings/two.webm", deletion_due_at: past },
    ];
    const counts = await runTelemetryRetentionSweep();
    expect(counts.recordings).toBe(2);
    expect(fake.tables.test_recordings).toHaveLength(0);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(["recordings/one.webm", "recordings/two.webm"]);
  });

  it("fails fast when a batch has no usable recording IDs", async () => {
    fake.tables.test_recordings = [
      {
        storage_path: "recordings/missing-id.webm",
        retained_until: "2020-01-01T00:00:00.000Z",
      },
    ];

    await expect(runTelemetryRetentionSweep()).rejects.toMatchObject({
      message: "Recording rows are missing identifiers required for safe deletion.",
    });
    expect(fake.tables.test_recordings).toHaveLength(1);
  });

  it("deletes valid recording IDs from mixed-id batches before surfacing unusable-row failure", async () => {
    fake.tables.test_recordings = [
      { id: "recording-valid", storage_path: "recordings/valid.webm", retained_until: "2020-01-01T00:00:00.000Z" },
      { storage_path: "recordings/invalid.webm", retained_until: "2020-01-01T00:00:00.000Z", id: null },
      { id: 1, storage_path: "recordings/invalid-number.webm", retained_until: "2020-01-01T00:00:00.000Z" },
    ];

    await expect(runTelemetryRetentionSweep()).rejects.toMatchObject({
      message: "Recording rows are missing identifiers required for safe deletion.",
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(["recordings/valid.webm"]);
    expect(fake.tables.test_recordings).toHaveLength(2);
    expect(fake.tables.test_recordings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ storage_path: "recordings/invalid.webm", id: null }),
        expect.objectContaining({ storage_path: "recordings/invalid-number.webm", id: 1 }),
      ]),
    );
  });

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

  it("starts and returns no-op retention worker when disabled", () => {
    const previous = process.env["TELEMETRY_RETENTION_ENABLED"];
    process.env["TELEMETRY_RETENTION_ENABLED"] = "false";
    const worker = startTelemetryRetentionWorker();
    expect(worker.stop).toBeTypeOf("function");
    expect(() => worker.stop()).not.toThrow();
    if (previous === undefined) {
      delete process.env["TELEMETRY_RETENTION_ENABLED"];
    } else {
      process.env["TELEMETRY_RETENTION_ENABLED"] = previous;
    }
  });

  it("keeps recording rows due after a storage failure and succeeds on retry", async () => {
    fake.tables.test_recordings = [{
      id: "recording-retry",
      storage_path: "recordings/retry.webm",
      retained_until: "2020-01-01T00:00:00.000Z",
    }];
    remove.mockResolvedValueOnce({ error: { name: "StorageError", message: "provider unavailable" } });

    await expect(runTelemetryRetentionSweep()).rejects.toEqual(
      expect.objectContaining({ name: "StorageError" }),
    );
    expect(fake.tables.test_recordings).toHaveLength(1);

    const counts = await runTelemetryRetentionSweep();
    expect(counts.recordings).toBe(1);
    expect(fake.tables.test_recordings).toHaveLength(0);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("removes large due cohorts in explicit storage-safe batches", async () => {
    fake.tables.test_recordings = Array.from({ length: 1_001 }, (_, index) => ({
      id: `recording-${index}`,
      storage_path: `recordings/${index}.webm`,
      retained_until: "2020-01-01T00:00:00.000Z",
    }));

    const counts = await runTelemetryRetentionSweep();

    expect(counts.recordings).toBe(1_001);
    expect(fake.tables.test_recordings).toHaveLength(0);
    expect(remove.mock.calls.map(([paths]) => paths.length)).toEqual([500, 500, 1]);
  });
});
