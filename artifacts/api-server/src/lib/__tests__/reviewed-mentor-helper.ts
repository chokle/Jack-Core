import type { AtomicKnowledge } from "../distillation.js";
import {
  knowledgeNodeId,
  resolveKnowledgeCandidate,
  syncMentorAnswerKnowledge,
  type MentorKnowledgeOutcome,
} from "../memory-graph.js";
import { fake } from "./mocks.js";

/** Build graph fixtures that begin after an explicit human accept decision. */
export async function syncReviewedMentorAnswerKnowledge(
  mentorProfileId: string,
  mentorName: string,
  items: AtomicKnowledge[],
  opts: {
    answerId: string;
    trade?: string | null;
    model?: string | null;
    extractedAt?: string;
    sessionId?: string | null;
  },
): Promise<MentorKnowledgeOutcome[]> {
  fake.tables["mentor_profiles"] ??= [];
  fake.tables["interview_sessions"] ??= [];
  fake.tables["interview_answers"] ??= [];
  fake.tables["knowledge_candidates"] ??= [];
  const existingAnswer = fake.tables["interview_answers"].find(
    (row) => row["id"] === opts.answerId,
  );
  const sessionId =
    opts.sessionId ??
    (typeof existingAnswer?.["session_id"] === "string"
      ? existingAnswer["session_id"]
      : null) ??
    `review-session:${opts.answerId}`;
  if (
    !fake.tables["mentor_profiles"].some((row) => row["id"] === mentorProfileId)
  ) {
    fake.tables["mentor_profiles"].push({
      id: mentorProfileId,
      name: mentorName,
      trade: opts.trade ?? null,
    });
  }
  if (
    !fake.tables["interview_sessions"].some((row) => row["id"] === sessionId)
  ) {
    fake.tables["interview_sessions"].push({
      id: sessionId,
      mentor_profile_id: mentorProfileId,
      trade: opts.trade ?? null,
      status: "completed",
    });
  }
  if (
    !fake.tables["interview_answers"].some((row) => row["id"] === opts.answerId)
  ) {
    fake.tables["interview_answers"].push({
      id: opts.answerId,
      session_id: sessionId,
      mentor_profile_id: mentorProfileId,
      question: "Reviewed mentor fixture",
      answer_text: "Traceable mentor evidence for a reviewed graph fixture.",
      skipped: false,
    });
  }

  const queued = await syncMentorAnswerKnowledge(
    mentorProfileId,
    mentorName,
    items,
    {
      ...opts,
      sessionId,
    },
  );
  const results: MentorKnowledgeOutcome[] = [];
  for (const [index, item] of items.entries()) {
    const candidateId = `cand:${opts.answerId}:${knowledgeNodeId(item.category, item.title)}`;
    const candidateRow = fake.tables["knowledge_candidates"].find(
      (row) => row["id"] === candidateId,
    );
    const hadMatch =
      Array.isArray(candidateRow?.["best_matches"]) &&
      candidateRow["best_matches"].length > 0;
    const resolution = await resolveKnowledgeCandidate(candidateId, "accept");
    if (!resolution.ok)
      throw new Error(
        `Reviewed mentor fixture could not be accepted: ${resolution.message}`,
      );
    results.push({
      ...queued[index]!,
      canonicalId: resolution.candidate.resolvedTargetId,
      outcome: hadMatch ? "reinforced" : "created",
      matchedLabel: hadMatch ? resolution.candidate.title : null,
    });
    // These legacy graph fixtures predate the durable review ledger and assert
    // graph/withdrawal behavior only. Dedicated review tests retain the row.
    fake.tables["knowledge_candidates"] = fake.tables[
      "knowledge_candidates"
    ].filter((row) => row["id"] !== candidateId);
  }
  return results;
}
