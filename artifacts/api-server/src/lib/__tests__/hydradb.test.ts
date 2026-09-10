import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hydraRecallConfigured,
  recallHydraKnowledge,
} from "../hydradb.js";

const ORIGINAL_ENV = { ...process.env };

describe("HydraDB recall boundary", () => {
  beforeEach(() => {
    process.env["HYDRA_DB_ENABLED"] = "true";
    process.env["HYDRA_DB_API_KEY"] = "test-key";
    process.env["HYDRA_DB_TENANT_ID"] = "torch-jack";
    process.env["HYDRA_DB_TIMEOUT_MS"] = "1000";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stays disabled unless the flag, key, and tenant are all present", () => {
    expect(hydraRecallConfigured()).toBe(true);
    delete process.env["HYDRA_DB_API_KEY"];
    expect(hydraRecallConfigured()).toBe(false);
  });

  it("accepts only Torch-approved, correctly scoped recall results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          chunks: [
            {
              source_id: "general-1",
              source_title: "General verified memory",
              chunk_content: "Keep the work square, level, and plumb.",
              metadata: { torch_approved: true, canonical_id: "node-general" },
            },
            {
              source_id: "pilot-1",
              source_title: "Correct pilot",
              chunk_content: "Pilot-specific field knowledge.",
              metadata: {
                torch_approved: true,
                canonical_id: "node-pilot",
                organization_id: "org-a",
                pilot_id: "pilot-a",
              },
            },
            {
              source_id: "pilot-wrong",
              source_title: "Wrong pilot",
              chunk_content: "Must never cross pilot scope.",
              metadata: {
                torch_approved: true,
                canonical_id: "node-wrong",
                organization_id: "org-b",
                pilot_id: "pilot-b",
              },
            },
            {
              source_id: "unapproved",
              source_title: "Unreviewed",
              chunk_content: "Must never reach Jack.",
              metadata: { torch_approved: false, canonical_id: "node-unapproved" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await recallHydraKnowledge("square plumbing", {
      organizationId: "org-a",
      pilotId: "pilot-a",
    });

    expect(results.map((result) => result.id)).toEqual(["general-1", "pilot-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails back to an empty Hydra result on provider errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 503 })));
    const error = vi.fn();

    await expect(
      recallHydraKnowledge("root pass", null, { error }),
    ).resolves.toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
