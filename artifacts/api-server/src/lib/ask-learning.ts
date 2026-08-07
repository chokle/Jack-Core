import { runMentorAnswerDistillation } from "./distillation.js";
import { verifyAndRecordGraphWrite } from "./memory-graph.js";
import { supabase } from "./supabase.js";

export interface AskLearningResult {
  status: "verified" | "discarded" | "failed";
  extractedCount: number;
  summary?: string;
  supportingEvidenceRefs?: string[];
  assumptionNotes?: string[];
  uncertaintyNotes?: string[];
  objectiveSolved?: boolean;
  riskSignals?: string[];
}

/**
 * Distill durable user-supplied trade knowledge from an Ask Jack turn into the
 * canonical Living Memory graph. Questions, small talk, and unsupported content
 * intentionally distill to zero items ("discarded") rather than polluting it.
 */
export async function learnFromAskInteraction(input: {
  userId: string;
  chatMessageId: string;
  sessionId: string;
  message: string;
}): Promise<AskLearningResult> {
  const { data: existing, error: profileError } = await supabase
    .from("mentor_profiles")
    .select("id, name, trade")
    .eq("contributor_user_id", input.userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (profileError) throw profileError;

  let profile = existing as Record<string, unknown> | null;
  if (!profile) {
    const { data, error } = await supabase
      .from("mentor_profiles")
      .insert({
        name: "Ask Jack Contributor",
        contributor_user_id: input.userId,
        specialties: [],
      })
      .select("id, name, trade")
      .single();
    if (error) throw error;
    profile = data as Record<string, unknown>;
  }

  const startedAtMs = Date.now();
  const result = await runMentorAnswerDistillation({
    mentorProfileId: String(profile["id"]),
    mentorName: String(profile["name"] ?? "Ask Jack Contributor"),
    answerId: input.chatMessageId,
    sessionId: null,
    trade: typeof profile["trade"] === "string" ? profile["trade"] : null,
    category: "ask_jack_interaction",
    topic: null,
    question:
      "What durable, reusable skilled-trades knowledge did the contributor provide?",
    answer: input.message,
  });

  if (result.items.length === 0)
    return {
      status: "discarded",
      extractedCount: 0,
      summary: "No durable reusable contribution was extracted.",
      supportingEvidenceRefs: [],
      uncertaintyNotes: ["No reusable concepts were identified for durable knowledge capture."],
      objectiveSolved: false,
      assumptionNotes: ["User intent was conversational or non-reusable in this turn."],
    };

  const verification = await verifyAndRecordGraphWrite(result.manifest, {
    startedAtMs,
  });
  const outcomeSummary = `Verified ${result.items.length} extract(s).`;
  const supportingEvidenceRefs = Array.from(
    new Set(
      result.items
        .map((item) => `knowledge:${item.id}`)
        .filter((value): value is string => value.length > 0),
    ),
  );

  if (verification.status !== "verified") {
    return {
      status: "failed",
      extractedCount: result.items.length,
      summary: verification.summary ?? "Knowledge write partially landed and needs retry.",
      supportingEvidenceRefs,
      uncertaintyNotes: ["Knowledge graph verification was partial or failed; impact is uncertain."],
      assumptionNotes: ["Graph write verification was not complete."],
      objectiveSolved: false,
      riskSignals: [],
    };
  }
  return {
    status: "verified",
    extractedCount: result.items.length,
    summary: outcomeSummary,
    supportingEvidenceRefs,
    assumptionNotes: [],
    uncertaintyNotes: [],
    objectiveSolved: true,
    riskSignals: [],
  };
}
