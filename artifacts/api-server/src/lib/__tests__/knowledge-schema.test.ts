import { describe, it, expect } from "vitest";
import {
  readKnowledgeMeta,
  KNOWLEDGE_OBJECT_FIELDS,
  type KnowledgeObjectMeta,
} from "../knowledge-schema.js";

describe("Knowledge Object richer metadata schema (Phase 1)", () => {
  it("is backward compatible: existing bookkeeping-only metadata stays valid and untouched", () => {
    const legacy = { origin: "manual-seed", entryNumber: 1 };
    const meta = readKnowledgeMeta(legacy);
    // Nothing added, nothing dropped — the existing object is unchanged.
    expect(meta).toEqual(legacy);
    expect(meta["origin"]).toBe("manual-seed");
  });

  it("treats every richer field as optional — missing fields are simply undefined", () => {
    const meta = readKnowledgeMeta({});
    for (const field of KNOWLEDGE_OBJECT_FIELDS) {
      expect(meta[field]).toBeUndefined();
    }
  });

  it("understands the richer fields when present (scalars and lists), preserving unknown keys", () => {
    const rich: KnowledgeObjectMeta = {
      origin: "manual-seed",
      discipline: "structural",
      skillLevel: "journeyperson",
      environment: "confined space",
      scenario: "vertical-up on a 3G joint",
      problem: "cold lap at the toes",
      symptoms: ["ropey bead", "slag inclusions"],
      rootCause: "stick-out too short",
      solution: "lengthen ESO to 3/4-1 in",
      fieldTip: "let the shelf freeze below you",
      commonMistake: "pushing self-shielded wire",
      safetyNote: "stay out of the breeze",
      whenNotToUse: "in high wind without a shield",
      alternatives: ["gas-shielded FCAW"],
      confidence: 0.9,
      evidenceCount: 3,
      conflictingAdvice: "some shops push instead of drag",
      verifiedBy: ["Red Seal welder"],
      sourceQuality: "high",
      yearsExperience: 20,
      failureCost: "weld rejection / rework",
      apprenticeStage: "second year",
      relatedKnowledge: ["e1e1e1e1-0001-4001-8001-000000000001"],
      originalSource: "shop training note",
      supportingQuote: "drag it, never push",
    };
    const meta = readKnowledgeMeta(rich);
    expect(meta).toEqual(rich);
    expect(meta.symptoms).toEqual(["ropey bead", "slag inclusions"]);
    expect(meta.confidence).toBe(0.9);
    // Unknown/bookkeeping keys are preserved, not stripped.
    expect(meta["origin"]).toBe("manual-seed");
  });

  it("handles missing / invalid input gracefully (never throws, yields an empty bag)", () => {
    expect(readKnowledgeMeta(undefined)).toEqual({});
    expect(readKnowledgeMeta(null)).toEqual({});
    expect(readKnowledgeMeta("nope")).toEqual({});
    expect(readKnowledgeMeta(42)).toEqual({});
    expect(readKnowledgeMeta(["a"])).toEqual({});
  });
});
