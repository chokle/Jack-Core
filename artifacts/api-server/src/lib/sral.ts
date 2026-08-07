import { logger } from "./logger.js";
import { supabase } from "./supabase.js";
import type { AskLearningResult } from "./ask-learning.js";

type RawAskLearningResult = AskLearningResult & {
  detectedFailureClass?: string;
  supportingEvidenceRefs?: string[];
  assumptionNotes?: string[];
  uncertaintyNotes?: string[];
  objectiveSolved?: boolean;
  riskSignals?: string[];
};

type SRALProposalStatus =
  | "not_required"
  | "draft"
  | "awaiting_review"
  | "blocked_by_constitution"
  | "blocked_by_evidence"
  | "rejected";

type SralConstitutionResult = "not_applicable" | "passed" | "blocked";

const SRAL_MIN_EVIDENCE_REFERENCES = getSetting("SRAL_MIN_EVIDENCE_REFERENCES", 2);
const SRAL_MIN_RECURRING_REFLECTIONS = getSetting("SRAL_MIN_RECURRING_REFLECTIONS", 1);
interface SRALEvaluationScores {
  accuracy: number;
  helpfulness: number;
  mentorQuality: number;
  communication: number;
  efficiency: number;
  safety: number;
  confidenceCalibration: number;
}

export interface SralReflectionInput {
  actorUserId: string;
  sessionId: string;
  interactionReference: string;
  subsystem: "chat" | "interview" | "teach";
  userMessage: string;
  assistantAnswer: string;
  learning: RawAskLearningResult;
}

export interface SralReflectionRunResult {
  ledgerId: string;
  proposalCreated: boolean;
  proposalId?: string;
  proposalStatus: SRALProposalStatus;
  skipped: boolean;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function getSetting(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normaliseText(value: string | undefined | null): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function scoreFromLearning(input: RawAskLearningResult): SRALEvaluationScores {
  const extracted = input.extractedCount;
  const baseSafety = input.riskSignals?.includes("unsafe_context") ? 0.2 : 0.85;
  const solved = input.objectiveSolved ?? false;

  return {
    accuracy: clamp01(0.25 + extracted * 0.09 + (solved ? 0.35 : 0)),
    helpfulness: clamp01(0.3 + extracted * 0.07 + (solved ? 0.2 : 0)),
    mentorQuality: clamp01(0.4 + extracted * 0.08 + (solved ? 0.3 : 0)),
    communication: clamp01(0.65 + (solved ? 0.15 : -0.1)),
    efficiency: clamp01(0.7 + (solved ? 0.2 : -0.2)),
    safety: clamp01(baseSafety - (extracted === 0 ? 0.2 : 0)),
    confidenceCalibration: clamp01(0.5 + (extracted / 10) + (solved ? 0.25 : -0.1)),
  };
}

function averageScore(scores: SRALEvaluationScores): number {
  return clamp01(
    (scores.accuracy +
      scores.helpfulness +
      scores.mentorQuality +
      scores.communication +
      scores.efficiency +
      scores.safety +
      scores.confidenceCalibration) /
      7,
  );
}

function detectFailureClass(
  input: RawAskLearningResult,
  userMessage: string,
  assistantAnswer: string,
): string {
  if (typeof input.detectedFailureClass === "string" && input.detectedFailureClass.trim()) {
    return input.detectedFailureClass.trim();
  }

  if (input.status === "discarded") return "no_robust_extraction";
  if (input.status === "failed") return "graph_write_partial";

  const userText = normaliseText(userMessage);
  const assistantText = normaliseText(assistantAnswer);
  if (userText.includes("how") && userText.includes("weld")) {
    return assistantText.includes("?") ? "clarification_needed" : "knowledge_capture_gap";
  }
  return "knowledge_capture_gap";
}

function extractLearningNotes(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function extractEvidenceRefs(values: string[] | undefined): string[] {
  const cleaned = new Set<string>();
  for (const value of values ?? []) {
    const next = value.trim();
    if (!next) continue;
    cleaned.add(next.startsWith("ref:") ? next : `ref:${next}`);
  }
  return [...cleaned];
}

function buildAssumptionNotes(
  status: AskLearningResult["status"],
  userMessage: string,
  providedNotes: string[] | undefined,
): string[] {
  const base = extractLearningNotes(providedNotes);
  if (status !== "verified" && base.length === 0) {
    base.push(
      "No durable extraction confirmed; this turn was treated as advisory rather than a confirmed knowledge update.",
    `User message style: ${normaliseText(userMessage).slice(0, 140) || "unclassifiable"}`,
    "Additional evidence is needed before proposing product changes.",
  );
  }
  return base;
}

function buildUncertaintyNotes(
  status: AskLearningResult["status"],
  providedNotes: string[] | undefined,
): string[] {
  const base = extractLearningNotes(providedNotes);
  if (status === "discarded") {
    base.push("No sustained interaction evidence exists to justify behavior change.");
  }
  return base;
}

function assessConstitutionCompatibility(
  learning: RawAskLearningResult,
  objectiveSolved: boolean,
  scores: SRALEvaluationScores,
): { result: SralConstitutionResult; reason: string | null } {
  const riskSignals = learning.riskSignals ?? [];
  if (riskSignals.includes("unsafe_or_unverified_instruction")) {
    return {
      result: "blocked",
      reason:
        "Unsafe or unverified instruction signal was detected; no adaptation candidate can be advanced.",
    };
  }

  if (scores.safety < 0.45) {
    return {
      result: "blocked",
      reason: "Safety confidence is below threshold; skip adaptation proposal.",
    };
  }

  if (!objectiveSolved) {
    return {
      result: "blocked",
      reason: "User objective has not yet been solved; avoid speculative governance changes.",
    };
  }

  if (scores.accuracy < 0.5) {
    return {
      result: "blocked",
      reason: "Accuracy confidence is insufficient for a reviewable change.",
    };
  }

  return { result: "passed", reason: null };
}

function expectedProposalBenefit(
  failureClass: string,
  subsystem: SralReflectionInput["subsystem"],
): string {
  if (failureClass === "knowledge_capture_gap") {
    return "Improve evidence capture guidance when recurring knowledge coverage gaps appear in this flow.";
  }
  if (failureClass === "graph_write_partial") {
    return "Improve recovery from partial graph-write states for sustained failures in this flow.";
  }
  if (failureClass === "clarification_needed") {
    return "Improve clarification pathways for recurring user questions that need better context capture.";
  }
  return `Improve ${subsystem} feedback handling for recurring failure pattern ${failureClass}.`;
}

function expectedProposalRisks(failureClass: string): string[] {
  if (failureClass === "unsafe_or_unverified_instruction") {
    return ["Potentially shifts safety policy without sufficient grounding"];
  }
  return [
    "Risk of over-generalising from narrow recurring examples.",
    "Risk of extra clarifying prompts during high-confidence diagnostic flows.",
    "Rollback burden if reviewed change is found too narrow or stale.",
  ];
}

function isMeaningfulInteraction(learning: RawAskLearningResult): boolean {
  if (learning.status === "verified") return true;
  return learning.extractedCount > 0;
}

async function getExistingLedger(
  interactionReference: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("sral_learning_ledger")
    .select("id")
    .eq("interaction_reference", interactionReference)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return String((data as Record<string, unknown>)["id"] ?? "");
}

async function countRecurringSignals(
  actorUserId: string,
  subsystem: SralReflectionInput["subsystem"],
  failureClass: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("sral_learning_ledger")
    .select("id")
    .eq("actor_user_id", actorUserId)
    .eq("affected_subsystem", subsystem)
    .eq("detected_failure_class", failureClass)
    .eq("learning_status", "verified")
    .order("created_at", { ascending: false })
    .limit(25);
  if (error) throw error;
  return (data ?? []).length;
}

async function writeLedgerRow(
  input: SralReflectionInput,
  scores: SRALEvaluationScores,
  failureClass: string,
  proposalStatus: SRALProposalStatus,
  constitutionReviewResult: SralConstitutionResult,
  assumptionNotes: string[],
  uncertaintyNotes: string[],
  supportingEvidenceRefs: string[],
  measuredOutcome: string,
  objectiveSolved: boolean,
): Promise<string> {
  const confidence = averageScore(scores);
  const { data, error } = await supabase
    .from("sral_learning_ledger")
    .insert({
      interaction_reference: input.interactionReference,
      actor_user_id: input.actorUserId,
      session_id: input.sessionId,
      subsystem: input.subsystem,
      user_message: input.userMessage,
      assistant_answer: input.assistantAnswer,
      learning_status: input.learning.status,
      extracted_count: input.learning.extractedCount,
      reflection_summary: input.learning.summary ?? "No durable reflection summary.",
      evaluation_scores: scores,
      detected_failure_class: failureClass,
      confidence,
      affected_subsystem: input.subsystem,
      expected_benefit: `Review SRAL proposal eligibility for subsystem ${input.subsystem}.`,
      possible_risks: expectedProposalRisks(failureClass),
      constitution_review_result: constitutionReviewResult,
      proposal_status: proposalStatus,
      measured_outcome: measuredOutcome,
      rollback_status: proposalStatus === "awaiting_review" ? "recommended" : "none_required",
      assumption_notes: assumptionNotes,
      uncertainty_notes: uncertaintyNotes,
      supporting_evidence_refs: supportingEvidenceRefs,
      objective_solved: objectiveSolved,
    })
    .select("id")
    .single();
  if (error) {
    throw error;
  }
  return String((data as Record<string, unknown>)["id"]);
}

async function writeProposalRow(
  ledgerId: string,
  input: SralReflectionInput,
  scores: SRALEvaluationScores,
  failureClass: string,
  scoresConfidence: number,
): Promise<string> {
  const { data, error } = await supabase
    .from("sral_proposals")
    .insert({
      ledger_id: ledgerId,
      proposed_change_summary: `Reduce recurring ${failureClass} failures with safer, reversible guidance in ${input.subsystem}.`,
      expected_benefit: expectedProposalBenefit(failureClass, input.subsystem),
      possible_risks: expectedProposalRisks(failureClass),
      evidence_references: extractEvidenceRefs(input.learning.supportingEvidenceRefs),
      confidence_score: scoresConfidence,
      constitution_review_result: "passed",
      proposal_status: "awaiting_review",
      rollback_status: "recommended",
    })
    .select("id")
    .single();
  if (error) throw error;
  return String((data as Record<string, unknown>)["id"]);
}

export async function runSralReflection(
  input: SralReflectionInput,
): Promise<SralReflectionRunResult> {
  if (!isMeaningfulInteraction(input.learning)) {
    return {
      ledgerId: "",
      proposalCreated: false,
      proposalStatus: "not_required",
      skipped: true,
    };
  }

  const existing = await getExistingLedger(input.interactionReference);
  if (existing) {
    return {
      ledgerId: existing,
      proposalCreated: false,
      proposalStatus: "not_required",
      skipped: true,
    };
  }

  const scores = scoreFromLearning(input.learning);
  const failureClass = detectFailureClass(
    input.learning,
    input.userMessage,
    input.assistantAnswer,
  );
  const assumptionNotes = buildAssumptionNotes(
    input.learning.status,
    input.userMessage,
    input.learning.assumptionNotes,
  );
  const uncertaintyNotes = buildUncertaintyNotes(
    input.learning.status,
    input.learning.uncertaintyNotes,
  );
  const objectiveSolved = Boolean(input.learning.objectiveSolved);

  const evidenceRefs = extractEvidenceRefs(input.learning.supportingEvidenceRefs);
  const recurringReflections = await countRecurringSignals(
    input.actorUserId,
    input.subsystem,
    failureClass,
  );
  const hasMinEvidence = evidenceRefs.length >= SRAL_MIN_EVIDENCE_REFERENCES;
  const hasRecurringEvidence = recurringReflections >= SRAL_MIN_RECURRING_REFLECTIONS;
  const canAttemptProposal =
    input.learning.status === "verified" && hasMinEvidence && hasRecurringEvidence;

  let proposalStatus: SRALProposalStatus = "not_required";
  let constitutionReview: SralConstitutionResult = "not_applicable";
  let measuredOutcome = "No proposal generated yet.";
  let proposalId: string | undefined;
  let proposalCreated = false;

  if (!canAttemptProposal) {
    proposalStatus = hasRecurringEvidence ? "not_required" : "blocked_by_evidence";
    measuredOutcome = hasMinEvidence
      ? "Recurring evidence requirement not yet met for proposal generation."
      : "Evidence references below threshold.";
  } else {
    const gate = assessConstitutionCompatibility(input.learning, objectiveSolved, scores);
    if (gate.result === "blocked") {
      proposalStatus = "blocked_by_constitution";
      constitutionReview = "blocked";
      measuredOutcome = gate.reason ?? "Constitution gate rejected candidate.";
    } else {
      proposalStatus = "awaiting_review";
      constitutionReview = "passed";
      measuredOutcome = "Proposal created for human review.";
      const ledgerRow = await writeLedgerRow(
        input,
        scores,
        failureClass,
        proposalStatus,
        constitutionReview,
        assumptionNotes,
        uncertaintyNotes,
        evidenceRefs,
        measuredOutcome,
        objectiveSolved,
      );
      proposalId = await writeProposalRow(
        ledgerRow,
        input,
        scores,
        failureClass,
        averageScore(scores),
      );
      proposalCreated = true;
      return {
        ledgerId: ledgerRow,
        proposalCreated: true,
        proposalId,
        proposalStatus,
        skipped: false,
      };
    }
  }

  const ledgerId = await writeLedgerRow(
    input,
    scores,
    failureClass,
    proposalStatus,
    constitutionReview,
    assumptionNotes,
    uncertaintyNotes,
    evidenceRefs,
    measuredOutcome,
    objectiveSolved,
  );

  return {
    ledgerId,
    proposalCreated,
    proposalStatus,
    skipped: false,
  };
}

export function queueSralReflection(input: SralReflectionInput): void {
  setImmediate(() => {
    void runSralReflection(input).catch((error) => {
      logger.error(
        { err: error, interactionReference: input.interactionReference },
        "Failed to run SRAL reflection",
      );
    });
  });
}
