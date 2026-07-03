import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Guard tests for knowledge-write verification resilience: a transient
 * PostgREST schema-cache error (code PGRST205 / "…schema cache") — which
 * appears right after a DDL change or on a fresh connection — must NOT flip a
 * knowledge write that actually landed to 'failed'. Verification and the audit
 * log-write both retry through the brief reload window; a genuine missing
 * node/edge is still a real 'failed'/'partial' verdict.
 */

import { fake } from "./mocks.js";

/** table -> number of upcoming `.from(table)` calls that should hard-fail with a
 * transient schema-cache error before the real fake takes over again. */
const transientFailsLeft = new Map<string, number>();

function schemaCacheError() {
  return {
    code: "PGRST205",
    message: "Could not find the table 'public.knowledge_write_log' in the schema cache",
  };
}

/** A chainable builder stand-in whose terminal await resolves to a schema-cache
 * error, mimicking a PostgREST call during cache staleness. */
function failingBuilder(): unknown {
  const err = schemaCacheError();
  const builder: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (onf: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: err }).then(onf);
        }
        return () => builder;
      },
    },
  );
  return builder;
}

vi.mock("../supabase.js", () => ({
  supabase: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "from") {
          return (table: string) => {
            const left = transientFailsLeft.get(table) ?? 0;
            if (left > 0) {
              transientFailsLeft.set(table, left - 1);
              return failingBuilder();
            }
            return fake.from(table);
          };
        }
        const val = (fake as unknown as Record<string, unknown>)[prop as string];
        return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(fake) : val;
      },
    },
  ),
}));

vi.mock("../openai.js", async () => {
  const m = await import("./mocks.js");
  return {
    createEmbedding: m.createEmbedding,
    createEmbeddings: async (texts: string[]) =>
      Promise.all(texts.map((t) => m.createEmbedding(t))),
    MODELS: m.MODELS,
    openai: m.openai,
  };
});

import {
  buildMentorAnswerManifest,
  verifyAndRecordGraphWrite,
  isTransientSchemaCacheError,
  type MentorKnowledgeOutcome,
} from "../memory-graph.js";
import { resetMocks } from "./mocks.js";

const ANSWER_ID = "answer-abc";
const MENTOR_ID = "mentor-xyz";
const CONCEPT_ID = "concept:test-node";

function reinforcedOutcome(): MentorKnowledgeOutcome {
  return {
    itemId: "k:concept:test-node",
    canonicalId: CONCEPT_ID,
    title: "Test Concept",
    category: "concept",
    outcome: "reinforced",
    matchedLabel: "Test Concept",
  };
}

/** Seed a landed mentor write: one concept node + its provenance edge carrying
 * this answer id, exactly what verifyGraphWrite reads back. */
function seedLandedWrite(sourceNodeId: string, edgeId: string) {
  fake.tables["knowledge_nodes"] = [{ id: CONCEPT_ID, confidence: 0.9 }];
  fake.tables["knowledge_edges"] = [
    {
      id: edgeId,
      source_id: sourceNodeId,
      target_id: CONCEPT_ID,
      meta: { answerIds: [ANSWER_ID] },
    },
  ];
}

describe("isTransientSchemaCacheError", () => {
  it("flags PostgREST schema-cache codes and messages", () => {
    expect(isTransientSchemaCacheError({ code: "PGRST205", message: "x" })).toBe(true);
    expect(isTransientSchemaCacheError({ code: "PGRST204" })).toBe(true);
    expect(isTransientSchemaCacheError({ code: "PGRST202" })).toBe(true);
    expect(
      isTransientSchemaCacheError({ message: "Could not find the table in the schema cache" }),
    ).toBe(true);
  });

  it("does not flag genuine errors", () => {
    expect(isTransientSchemaCacheError({ code: "23505", message: "duplicate key" })).toBe(false);
    expect(isTransientSchemaCacheError(new Error("network down"))).toBe(false);
    expect(isTransientSchemaCacheError(null)).toBe(false);
    expect(isTransientSchemaCacheError("nope")).toBe(false);
  });
});

describe("verifyAndRecordGraphWrite schema-cache resilience", () => {
  beforeEach(() => {
    resetMocks();
    transientFailsLeft.clear();
  });

  it("reports verified when a landed write is fully present", async () => {
    const manifest = buildMentorAnswerManifest(MENTOR_ID, ANSWER_ID, [reinforcedOutcome()]);
    seedLandedWrite(manifest.sourceNodeId, manifest.expectedEdgeIds[0]!);

    const result = await verifyAndRecordGraphWrite(manifest);

    expect(result.status).toBe("verified");
    const logRow = fake.tables["knowledge_write_log"]?.[0];
    expect(logRow?.["status"]).toBe("verified");
  });

  it("does not flip a landed write to failed when a verification read hits a stale cache", async () => {
    const manifest = buildMentorAnswerManifest(MENTOR_ID, ANSWER_ID, [reinforcedOutcome()]);
    seedLandedWrite(manifest.sourceNodeId, manifest.expectedEdgeIds[0]!);
    // First read of knowledge_nodes fails transiently; the retry recovers.
    transientFailsLeft.set("knowledge_nodes", 1);

    const result = await verifyAndRecordGraphWrite(manifest);

    expect(result.status).toBe("verified");
  });

  it("still records the audit row when the log write first hits a stale cache", async () => {
    const manifest = buildMentorAnswerManifest(MENTOR_ID, ANSWER_ID, [reinforcedOutcome()]);
    seedLandedWrite(manifest.sourceNodeId, manifest.expectedEdgeIds[0]!);
    transientFailsLeft.set("knowledge_write_log", 1);

    const result = await verifyAndRecordGraphWrite(manifest);

    expect(result.status).toBe("verified");
    expect(fake.tables["knowledge_write_log"]?.[0]?.["status"]).toBe("verified");
  });

  it("still reports failed for a genuinely missing node (not a false positive)", async () => {
    const manifest = buildMentorAnswerManifest(MENTOR_ID, ANSWER_ID, [reinforcedOutcome()]);
    // No seeding: the node/edge never landed — a real failure, not transient.
    const result = await verifyAndRecordGraphWrite(manifest);

    expect(result.status).toBe("failed");
    expect(fake.tables["knowledge_write_log"]?.[0]?.["status"]).toBe("failed");
  });
});
