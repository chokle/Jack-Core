import { runMentorAnswerDistillation } from "./distillation.js";
import { verifyAndRecordGraphWrite } from "./memory-graph.js";
import { supabase } from "./supabase.js";
import {
  isExplicitCorrection,
  targetsCoreIdentity,
} from "./core-memory.js";

export interface AskLearningResult {
  status: "verified" | "pending" | "discarded" | "failed";
  extractedCount: number;
  summary?: string;
}

function correctionTitle(message: string, coreIdentity: boolean): string {
  if (coreIdentity) return "Proposed Jack Core identity correction";
  const compact = message.trim().replace(/\s+/g, " ");
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}...`;
}

async function queueExplicitCorrection(input: {
  userId: string;
  chatMessageId: string;
  message: string;
}): Promise<AskLearningResult> {
  const coreIdentity = targetsCoreIdentity(input.message);
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

  const candidateId = `${coreIdentity ? "core-correction" : "correction"}:${input.chatMessageId}`;
  const { error } = await supabase.from("knowledge_candidates").upsert(
    {
      id: candidateId,
      status: "pending",
      title: correctionTitle(input.message, coreIdentity),
      description: input.message,
      category: "concept",
      trade: typeof profile["trade"] === "string" ? profile["trade"] : null,
      confidence: null,
      competency_code: null,
      mentor_profile_id: String(profile["id"]),
      mentor_name: String(profile["name"] ?? "Ask Jack Contributor"),
      answer_id: input.chatMessageId,
      session_id: null,
      best_matches: [],
      aliases: [],
    },
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (error) throw error;

  return {
    status: "pending",
    extractedCount: 1,
    summary: coreIdentity
      ? "Pending authorized Core Memory review."
      : "Pending Knowledge Review.",
  };
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
  // Corrections never take the automatic reinforce/create path. They remain
  // outside retrieval until a human resolves the conflict, so Jack cannot turn
  // one conversational assertion into shared truth.
  if (isExplicitCorrection(input.message)) {
    return queueExplicitCorrection(input);
  }

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
    return { status: "discarded", extractedCount: 0 };
  const verification = await verifyAndRecordGraphWrite(result.manifest, {
    startedAtMs,
  });
  return {
    status: verification.status === "verified" ? "verified" : "failed",
    extractedCount: result.items.length,
    summary: verification.summary,
  };
}
