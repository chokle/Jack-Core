/**
 * Guard tests for restoring ARCHIVED (mentor-withdrawn) knowledge. Restoring
 * re-mints a source-free `curated` node that is DELIBERATELY exempt from both
 * orphan-pruning and aggregate-recompute. Because such a node has no provenance
 * edge, a regression in either exemption would silently delete it or zero its
 * confidence on the next video re-process or self-heal rebuild — the exact
 * "forgotten knowledge" this feature exists to prevent. These tests drive a real
 * restore, then run pruneOrphanKnowledge and rebuildGraph and assert the curated
 * node and its topic/competency hub edges survive with intact confidence; plus
 * restore's replay-safety and its refusal of a non-archived candidate.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../supabase.js", async () => {
  const m = await import("./mocks.js");
  return { supabase: m.fake };
});

vi.mock("../openai.js", async () => {
  const m = await import("./mocks.js");
  return { createEmbedding: m.createEmbedding, MODELS: m.MODELS, openai: m.openai };
});

import { fake, resetMocks } from "./mocks.js";
import {
  ensureBaseGraph,
  syncVideoGraph,
  syncVideoKnowledge,
  syncMentorAnswerKnowledge,
  removeMentorGraph,
  resolveKnowledgeCandidate,
  pruneOrphanKnowledge,
  rebuildGraph,
  knowledgeNodeId,
} from "../memory-graph.js";
import type { AtomicKnowledge, KnowledgeCategory } from "../distillation.js";

const TRADE = "Welder";
const MENTOR = "cccccccc-0000-0000-0000-000000000001";
const ANSWER_1 = "33333333-0000-0000-0000-000000000001";

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

async function seedVideo(id: string, trade: string = TRADE): Promise<void> {
  fake.tables["videos"].push({
    id,
    title: `Video ${id}`,
    trade,
    status: "ready",
    description: null,
    competency_codes: [],
    created_at: new Date().toISOString(),
    updated_at: null,
  });
  await syncVideoGraph(id);
}

function seedBaseTables(): void {
  fake.tables["competencies"].push(
    { code: "W-2", name: "Shielded Metal Arc Welding", trade: "Welder", description: null },
    { code: "W-3", name: "Gas Metal Arc Welding", trade: "Welder", description: null },
  );
}

const nodes = () => fake.tables["knowledge_nodes"];
const edges = () => fake.tables["knowledge_edges"];
const candidates = () => fake.tables["knowledge_candidates"] ?? [];
const nodeById = (id: string) => nodes().find((n) => n["id"] === id);
const hubEdge = (source: string, target: string) =>
  edges().find((e) => e["source_id"] === source && e["target_id"] === target);
const topicId = (trade: string) => `topic:${trade}`;
const compId = (code: string) => `comp:${code}`;

beforeEach(async () => {
  resetMocks();
  seedBaseTables();
  await ensureBaseGraph();
});

/**
 * Teach a mentor-ONLY concept (no video corroborates it) with a trade and a
 * mapped competency, then withdraw the mentor so the concept is demoted OUT of
 * the live graph into an attribution-free `arch:<nodeId>` candidate. Returns the
 * concept's deterministic node id and the archived candidate's row id.
 */
async function seedArchivedConcept(
  title: string,
  confidence: number,
  competencyCode: string,
): Promise<{ conceptId: string; archiveId: string }> {
  const conceptId = knowledgeNodeId("concept", title);
  await syncMentorAnswerKnowledge(
    MENTOR,
    "Alice",
    [makeItem("concept", title, { confidence, competencyCode, description: `About ${title}.` })],
    { answerId: ANSWER_1, trade: TRADE },
  );
  expect(nodeById(conceptId)).toBeDefined();

  const removal = await removeMentorGraph(MENTOR);
  expect(removal.archivedConceptIds).toEqual([conceptId]);
  // The concept is gone from the live graph; only the archived snapshot remains.
  expect(nodeById(conceptId)).toBeUndefined();
  const archiveId = `arch:${conceptId}`;
  expect(candidates().find((c) => c["id"] === archiveId)?.["status"]).toBe("archived");
  return { conceptId, archiveId };
}

describe("restore archived knowledge — survives prune + rebuild", () => {
  it("restored curated node survives pruneOrphanKnowledge and rebuildGraph with hub edges and confidence intact", async () => {
    // An unrelated video keeps the graph non-trivial so rebuildGraph has real
    // work to do (re-mint video node, prune, recompute) around the curated node.
    const v = "vid-unrelated-1";
    await seedVideo(v);
    await syncVideoKnowledge(v, [
      makeItem("concept", "Bead Overlap", { confidence: 0.6, timestamps: [12], competencyCode: "W-3" }),
    ]);

    const { conceptId, archiveId } = await seedArchivedConcept("Reading Heat by Color", 0.8, "W-2");

    // Restore: re-mint the concept as attribution-free unverified curated knowledge.
    const restored = await resolveKnowledgeCandidate(archiveId, "restore");
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error("unreachable");
    expect(restored.replayed).toBe(false);

    // The re-minted node is sourceless-but-curated, wired to its trade + comp hubs.
    const afterRestore = nodeById(conceptId)!;
    expect(afterRestore).toBeDefined();
    expect((afterRestore["meta"] as Record<string, unknown>)["curated"]).toBe(true);
    expect(afterRestore["verification_status"]).toBe("unverified");
    expect(afterRestore["confidence"] as number).toBeCloseTo(0.8, 10);
    expect(hubEdge(conceptId, topicId(TRADE))).toBeDefined();
    expect(hubEdge(conceptId, compId("W-2"))).toBeDefined();
    // No provenance edge — the reviewer, not a video/mentor, vouches for it.
    expect(edges().filter((e) => e["target_id"] === conceptId && e["kind"] === "knowledge")).toHaveLength(0);

    // 1) A standalone orphan sweep must NOT delete the sourceless curated node.
    await pruneOrphanKnowledge();
    expect(nodeById(conceptId)).toBeDefined();
    expect((nodeById(conceptId)!["meta"] as Record<string, unknown>)["curated"]).toBe(true);

    // 2) A full self-heal rebuild (prune + recompute every knowledge node) must
    //    leave the curated node AND its hub edges AND its confidence untouched.
    await rebuildGraph();
    const afterRebuild = nodeById(conceptId);
    expect(afterRebuild).toBeDefined();
    expect((afterRebuild!["meta"] as Record<string, unknown>)["curated"]).toBe(true);
    expect(afterRebuild!["confidence"] as number).toBeCloseTo(0.8, 10);
    expect(hubEdge(conceptId, topicId(TRADE))).toBeDefined();
    expect(hubEdge(conceptId, compId("W-2"))).toBeDefined();
    // The unrelated video-sourced concept is still present (rebuild is a no-op for it).
    expect(nodeById(knowledgeNodeId("concept", "Bead Overlap"))).toBeDefined();
  });

  it("restore is replay-safe (second restore is a no-op success)", async () => {
    const { conceptId, archiveId } = await seedArchivedConcept("Puddle Reading", 0.7, "W-3");

    const first = await resolveKnowledgeCandidate(archiveId, "restore");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.replayed).toBe(false);

    const second = await resolveKnowledgeCandidate(archiveId, "restore");
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.replayed).toBe(true);
    expect(second.candidate.status).toBe("restored");

    // Exactly one node, one candidate row — the replay minted nothing new.
    expect(nodes().filter((n) => n["id"] === conceptId)).toHaveLength(1);
    expect(candidates().filter((c) => c["id"] === archiveId)).toHaveLength(1);
  });

  it("re-archive undoes a restore: sourceless curated node is removed and the row returns to archived", async () => {
    const { conceptId, archiveId } = await seedArchivedConcept("Kerf Compensation", 0.75, "W-2");

    const restored = await resolveKnowledgeCandidate(archiveId, "restore");
    expect(restored.ok).toBe(true);
    expect(nodeById(conceptId)).toBeDefined();

    // Undo the restore: the sourceless curated node leaves the live graph and the
    // candidate row goes back to `archived` (its content snapshot is preserved).
    const rearchived = await resolveKnowledgeCandidate(archiveId, "rearchive");
    expect(rearchived.ok).toBe(true);
    if (!rearchived.ok) throw new Error("unreachable");
    expect(rearchived.replayed).toBe(false);
    expect(rearchived.candidate.status).toBe("archived");

    expect(nodeById(conceptId)).toBeUndefined();
    expect(hubEdge(conceptId, topicId(TRADE))).toBeUndefined();
    expect(hubEdge(conceptId, compId("W-2"))).toBeUndefined();
    // The archived snapshot still carries the concept content for future review.
    const row = candidates().find((c) => c["id"] === archiveId)!;
    expect(row["status"]).toBe("archived");
    expect(row["title"]).toBe("Kerf Compensation");

    // The archive→restore→archive cycle is a toggle: a fresh restore works again.
    const restoredAgain = await resolveKnowledgeCandidate(archiveId, "restore");
    expect(restoredAgain.ok).toBe(true);
    if (!restoredAgain.ok) throw new Error("unreachable");
    expect(restoredAgain.replayed).toBe(false);
    expect(nodeById(conceptId)).toBeDefined();
  });

  it("re-archive KEEPS a concept re-taught by a video after restore, dropping only the curated vouch", async () => {
    const { conceptId, archiveId } = await seedArchivedConcept("Root Pass Control", 0.7, "W-3");

    const restored = await resolveKnowledgeCandidate(archiveId, "restore");
    expect(restored.ok).toBe(true);
    expect((nodeById(conceptId)!["meta"] as Record<string, unknown>)["curated"]).toBe(true);

    // A video now teaches the SAME concept — it collapses onto the curated node,
    // adding a real provenance edge.
    const v = "vid-reteach-1";
    await seedVideo(v);
    await syncVideoKnowledge(v, [
      makeItem("concept", "Root Pass Control", { confidence: 0.65, timestamps: [7], competencyCode: "W-3" }),
    ]);
    expect(
      edges().filter((e) => e["target_id"] === conceptId && e["kind"] === "knowledge").length,
    ).toBeGreaterThan(0);

    // Re-archiving must NOT delete the node — a video now vouches for it. Only the
    // reviewer's curated flag is dropped; the row still flips back to archived.
    const rearchived = await resolveKnowledgeCandidate(archiveId, "rearchive");
    expect(rearchived.ok).toBe(true);
    if (!rearchived.ok) throw new Error("unreachable");
    expect(rearchived.candidate.status).toBe("archived");

    const node = nodeById(conceptId);
    expect(node).toBeDefined();
    expect((node!["meta"] as Record<string, unknown>)["curated"]).toBeUndefined();
    expect(hubEdge(conceptId, topicId(TRADE))).toBeDefined();
  });

  it("re-archive is replay-safe (second re-archive is a no-op success)", async () => {
    const { conceptId, archiveId } = await seedArchivedConcept("Travel Angle", 0.7, "W-2");
    await resolveKnowledgeCandidate(archiveId, "restore");

    const first = await resolveKnowledgeCandidate(archiveId, "rearchive");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.replayed).toBe(false);

    const second = await resolveKnowledgeCandidate(archiveId, "rearchive");
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.replayed).toBe(true);
    expect(second.candidate.status).toBe("archived");

    expect(nodeById(conceptId)).toBeUndefined();
    expect(candidates().filter((c) => c["id"] === archiveId)).toHaveLength(1);
  });

  it("re-archiving an already-archived candidate is a no-op success (idempotent terminal state)", async () => {
    // Archived IS re-archive's terminal state, so a re-archive on a withdrawn-
    // but-never-restored candidate simply reports the end state already holds.
    const { conceptId, archiveId } = await seedArchivedConcept("Undercut Avoidance", 0.7, "W-3");

    const result = await resolveKnowledgeCandidate(archiveId, "rearchive");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.replayed).toBe(true);
    expect(result.candidate.status).toBe("archived");
    // Nothing was minted or removed — the node stays out of the live graph.
    expect(nodeById(conceptId)).toBeUndefined();
  });

  it("refuses to re-archive a pending candidate with a conflict (HTTP 409)", async () => {
    fake.tables["knowledge_candidates"] ??= [];
    const pendingId = `cand:${ANSWER_1}:${knowledgeNodeId("concept", "Still Unsure")}`;
    fake.tables["knowledge_candidates"]!.push({
      id: pendingId,
      status: "pending",
      title: "Still Unsure",
      category: "concept",
      trade: TRADE,
      best_matches: [],
    });

    const result = await resolveKnowledgeCandidate(pendingId, "rearchive");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("conflict");
    expect(candidates().find((c) => c["id"] === pendingId)?.["status"]).toBe("pending");
  });

  it("refuses to restore a non-archived candidate with a conflict (HTTP 409)", async () => {
    // A pending mentor candidate is NOT archived knowledge — restore must refuse.
    fake.tables["knowledge_candidates"] ??= [];
    const pendingId = `cand:${ANSWER_1}:${knowledgeNodeId("concept", "Uncertain Wording")}`;
    fake.tables["knowledge_candidates"]!.push({
      id: pendingId,
      status: "pending",
      title: "Uncertain Wording",
      category: "concept",
      trade: TRADE,
      best_matches: [],
    });

    const result = await resolveKnowledgeCandidate(pendingId, "restore");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // The route maps `conflict` → HTTP 409.
    expect(result.code).toBe("conflict");
    // The pending candidate is untouched and no node was minted.
    expect(candidates().find((c) => c["id"] === pendingId)?.["status"]).toBe("pending");
  });
});
