/**
 * Regression guard for the silent knowledge-graph write failure uncovered while
 * building Mentor Withdrawal: `upsertEdges` batches weighted provenance edges
 * (mentor→concept) together with weightless hub edges (concept→topic /
 * concept→competency) in a SINGLE Supabase upsert. PostgREST unifies the column
 * set across a mixed-key batch, so the hub edges were written with an explicit
 * NULL weight/meta — violating `knowledge_edges.weight NOT NULL DEFAULT 1` and
 * `meta NOT NULL DEFAULT '{}'` — and the whole batch failed. The failure was
 * swallowed (caught + logged), so mentor concepts never entered the graph.
 *
 * The fix is to ALWAYS set weight/meta explicitly for every row in the batch
 * (see `.agents/memory/postgrest-bulk-upsert-nulls.md`). These tests would fail
 * if someone reverts to conditionally omitting either column:
 *   1. the fake models PostgREST's mixed-batch NULL injection (so the guard is
 *      itself trustworthy), and
 *   2. the mentor ingestion path persists every edge with a non-null weight+meta.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AtomicKnowledge, KnowledgeCategory } from "../distillation.js";

vi.mock("../supabase.js", async () => {
  const m = await import("./mocks.js");
  return { supabase: m.fake };
});

vi.mock("../openai.js", async () => {
  const m = await import("./mocks.js");
  return { createEmbedding: m.createEmbedding, MODELS: m.MODELS, openai: m.openai };
});

import { fake, resetMocks } from "./mocks.js";
import { ensureBaseGraph, syncMentorAnswerKnowledge, knowledgeNodeId } from "../memory-graph.js";

const TRADE = "Welder";
const MENTOR = "aaaaaaaa-0000-0000-0000-000000000001";
const ANSWER = "11111111-0000-0000-0000-000000000001";

function makeItem(
  category: KnowledgeCategory,
  title: string,
  extra: Partial<Omit<AtomicKnowledge, "id" | "title" | "category">> = {},
): AtomicKnowledge {
  return {
    id: knowledgeNodeId(category, title),
    title,
    category,
    description: extra.description ?? "",
    timestamps: extra.timestamps ?? [],
    confidence: extra.confidence ?? 0.6,
    competencyCode: extra.competencyCode ?? null,
  };
}

const edges = () => fake.tables["knowledge_edges"];

beforeEach(async () => {
  resetMocks();
  fake.tables["competencies"].push(
    { code: "W-2", name: "Shielded Metal Arc Welding", trade: "Welder", description: null },
    { code: "W-3", name: "Gas Metal Arc Welding", trade: "Welder", description: null },
  );
  await ensureBaseGraph();
});

describe("knowledge_edges NOT NULL / mixed-batch upsert modeling", () => {
  it("the fake rejects a mixed batch where one row omits a NOT NULL column another provides", async () => {
    // A weighted provenance row + a weightless hub row: the union column set
    // includes weight/meta, so the hub row is inserted with an explicit NULL —
    // exactly the PostgREST behavior that failed silently in production.
    const { error } = await fake.from("knowledge_edges").upsert(
      [
        { id: "e:mixed-a", source_id: "s", target_id: "t", kind: "knowledge", weight: 3, meta: { a: 1 } },
        { id: "e:mixed-b", source_id: "s", target_id: "u", kind: "topic" },
      ],
      { onConflict: "id" },
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not-null constraint/);
    // The whole batch failed — no rows landed.
    expect(edges().some((e) => e["id"] === "e:mixed-a")).toBe(false);
    expect(edges().some((e) => e["id"] === "e:mixed-b")).toBe(false);
  });

  it("the fake accepts a batch where every row sets the NOT NULL columns explicitly", async () => {
    const { error } = await fake.from("knowledge_edges").upsert(
      [
        { id: "e:ok-a", source_id: "s", target_id: "t", kind: "knowledge", weight: 3, meta: { a: 1 } },
        { id: "e:ok-b", source_id: "s", target_id: "u", kind: "topic", weight: 1, meta: {} },
      ],
      { onConflict: "id" },
    );
    expect(error).toBeNull();
    expect(edges().find((e) => e["id"] === "e:ok-b")!["weight"]).toBe(1);
    expect(edges().find((e) => e["id"] === "e:ok-b")!["meta"]).toEqual({});
  });

  it("the fake accepts a uniformly-weightless batch (DB default applies, no mixed NULL)", async () => {
    // No row provides weight/meta, so PostgREST leaves them out of the INSERT and
    // the DB default fills them — this must NOT be flagged as a violation.
    const { error } = await fake.from("knowledge_edges").upsert(
      [
        { id: "e:hub-a", source_id: "s", target_id: "t", kind: "topic" },
        { id: "e:hub-b", source_id: "s", target_id: "u", kind: "competency" },
      ],
      { onConflict: "id" },
    );
    expect(error).toBeNull();
  });
});

describe("mentor ingestion — no silent knowledge-write loss on mixed edge batches", () => {
  it("persists every edge with a non-null weight and meta (weighted provenance + weightless hubs)", async () => {
    // This concept produces BOTH a weighted provenance edge (mentor→concept) and
    // weightless hub edges (concept→topic, concept→competency) in a SINGLE
    // upsertEdges batch — the exact mix that regressed. If upsertEdges reverted
    // to omitting weight/meta on the hub edges, the batch would throw here and
    // the mentor knowledge would never reach the graph.
    const outcomes = await syncMentorAnswerKnowledge(
      MENTOR,
      "Alice",
      [makeItem("concept", "Travel Speed", { competencyCode: "W-2", confidence: 0.8 })],
      { answerId: ANSWER, trade: TRADE },
    );

    // The write succeeded end-to-end (no swallowed batch failure).
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.outcome).toBe("created");

    const conceptId = knowledgeNodeId("concept", "Travel Speed");
    const provEdge = edges().find(
      (e) => e["source_id"] === `mentor:${MENTOR}` && e["target_id"] === conceptId,
    );
    const topicEdge = edges().find(
      (e) => e["source_id"] === conceptId && e["target_id"] === `topic:${TRADE}`,
    );
    const compEdge = edges().find(
      (e) => e["source_id"] === conceptId && e["target_id"] === "comp:W-2",
    );

    // All three edges from this mixed batch persisted.
    for (const e of [provEdge, topicEdge, compEdge]) {
      expect(e).toBeDefined();
      // Every row carries a non-null weight and meta — the weightless hub edges
      // must have been backfilled with the default (1 / {}), not left NULL.
      expect(e!["weight"]).not.toBeNull();
      expect(e!["weight"]).not.toBeUndefined();
      expect(typeof e!["weight"]).toBe("number");
      expect(e!["meta"]).not.toBeNull();
      expect(e!["meta"]).not.toBeUndefined();
    }
  });

  it("every knowledge_edges row in the graph has a non-null weight and meta after ingestion", async () => {
    await syncMentorAnswerKnowledge(
      MENTOR,
      "Bob",
      [
        makeItem("concept", "Arc Length", { competencyCode: "W-2" }),
        makeItem("hazard", "Arc Blow", { competencyCode: "W-3" }),
        makeItem("procedure", "Whip and Pause"),
      ],
      { answerId: ANSWER, trade: TRADE },
    );

    // Every edge in the whole graph (base scaffold + mentor writes) must satisfy
    // the NOT NULL invariant — a single missing weight/meta would prove a row
    // slipped through with a DB-default-that-never-applied.
    const all = edges();
    expect(all.length).toBeGreaterThan(0);
    for (const e of all) {
      expect(e["weight"], `edge ${e["id"]} weight`).not.toBeNull();
      expect(e["weight"], `edge ${e["id"]} weight`).not.toBeUndefined();
      expect(e["meta"], `edge ${e["id"]} meta`).not.toBeNull();
      expect(e["meta"], `edge ${e["id"]} meta`).not.toBeUndefined();
    }
  });
});
