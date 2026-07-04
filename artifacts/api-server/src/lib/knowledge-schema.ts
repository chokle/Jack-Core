/**
 * Jack Knowledge Object — richer optional metadata schema (Phase 1).
 *
 * A "Knowledge Object" is a row in the `knowledge_entries` table: a generic,
 * NON-video knowledge asset (a written field note, sketch, or photo) that Ask
 * Jack retrieves semantically alongside video transcripts.
 *
 * Phase 1 ONLY expands the SCHEMA. It deliberately does NOT touch ingestion,
 * retrieval, the database shape, or any object that already exists:
 *
 *  - Backward compatible — every field below is OPTIONAL. An object carrying
 *    none of them (e.g. the seeded entries, whose metadata is just
 *    `{ origin, entryNumber }`) stays perfectly valid.
 *  - No migration — these fields live INSIDE the existing `metadata JSONB`
 *    column on `knowledge_entries`. Nothing in the database changes.
 *  - Graceful — a missing field is simply `undefined`; unknown / bookkeeping
 *    keys (like `origin`) are preserved untouched via the index signature.
 *  - No invented values — this file defines the SHAPE only; it never fabricates
 *    data for a field.
 *
 * `trade` and `tags` are intentionally NOT redefined here: they are already
 * first-class columns on `knowledge_entries`, so a Knowledge Object already
 * understands them. The fields below enrich the object's `metadata` bag.
 *
 * Retrieval is unchanged in Phase 1: `match_knowledge_entries` does not return
 * these fields and `chat.ts` is untouched. Surfacing this richer context at
 * retrieval time is a later phase.
 */

/** A field that may hold a single value or a list of them. */
export type OneOrMany<T> = T | T[];

/** The richer, fully-optional fields a Knowledge Object may carry. */
export interface KnowledgeObjectFields {
  // — Classification —
  /** Sub-area within the trade (a specialization or division of work). */
  discipline?: string;
  /** Who this is pitched at (e.g. apprentice / journeyperson / master). */
  skillLevel?: string;
  /** Where the work happens (e.g. indoor, outdoor, confined space, shop). */
  environment?: string;

  // — Scenario / troubleshooting content —
  /** The situation this knowledge applies to. */
  scenario?: string;
  /** The problem being solved. */
  problem?: string;
  /** Observable signs the problem is present. */
  symptoms?: OneOrMany<string>;
  /** The underlying cause behind the symptoms. */
  rootCause?: string;
  /** How to resolve it. */
  solution?: string;
  /** Hard-won, practical advice from the field. */
  fieldTip?: OneOrMany<string>;
  /** A common way people get this wrong. */
  commonMistake?: OneOrMany<string>;
  /** A safety-critical caution. */
  safetyNote?: OneOrMany<string>;
  /** Situations where this approach should NOT be used. */
  whenNotToUse?: string;
  /** Other valid approaches. */
  alternatives?: OneOrMany<string>;

  // — Trust / confidence —
  /** How confident this knowledge is (numeric score or a plain descriptor). */
  confidence?: number | string;
  /** How many independent pieces of evidence back it. */
  evidenceCount?: number;
  /** Any conflicting guidance that exists on this topic. */
  conflictingAdvice?: OneOrMany<string>;
  /** Who or what verified it. */
  verifiedBy?: OneOrMany<string>;
  /** Quality of the source (a rating or a plain descriptor). */
  sourceQuality?: number | string;
  /** Years of experience behind the knowledge. */
  yearsExperience?: number | string;

  // — Learning context —
  /** What it costs to get this wrong. */
  failureCost?: string;
  /** The apprenticeship stage this is most relevant to. */
  apprenticeStage?: string;

  // — Linking / provenance —
  /** References to related Knowledge Objects (ids or descriptions). */
  relatedKnowledge?: OneOrMany<string>;
  /** Where the knowledge originally came from. */
  originalSource?: string;
  /** A verbatim quote that supports it. */
  supportingQuote?: OneOrMany<string>;
}

/**
 * A Knowledge Object's `metadata` bag: the richer optional fields above PLUS
 * whatever other keys the object already carries (e.g. `origin`, `entryNumber`).
 * The index signature is what keeps this fully backward compatible — existing
 * metadata stays valid and is never dropped.
 */
export type KnowledgeObjectMeta = KnowledgeObjectFields & {
  [key: string]: unknown;
};

/** Canonical list of the richer field keys (handy for docs, tooling, tests). */
export const KNOWLEDGE_OBJECT_FIELDS = [
  "discipline",
  "skillLevel",
  "environment",
  "scenario",
  "problem",
  "symptoms",
  "rootCause",
  "solution",
  "fieldTip",
  "commonMistake",
  "safetyNote",
  "whenNotToUse",
  "alternatives",
  "confidence",
  "evidenceCount",
  "conflictingAdvice",
  "verifiedBy",
  "sourceQuality",
  "yearsExperience",
  "failureCost",
  "apprenticeStage",
  "relatedKnowledge",
  "originalSource",
  "supportingQuote",
] as const satisfies readonly (keyof KnowledgeObjectFields)[];

export type KnowledgeObjectField = (typeof KNOWLEDGE_OBJECT_FIELDS)[number];

/**
 * Read a Knowledge Object's metadata as the richer, typed schema WITHOUT losing
 * or inventing anything. Non-object input (null, undefined, a scalar, an array)
 * yields an empty bag; a plain object is returned as-is — unknown keys
 * preserved, missing fields simply absent. This is how Jack "understands" the
 * richer schema while staying fully backward compatible.
 */
export function readKnowledgeMeta(raw: unknown): KnowledgeObjectMeta {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as KnowledgeObjectMeta;
  }
  return {};
}
