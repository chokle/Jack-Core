import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export interface ConversationPolicyResponse {
  answer: string;
  reason: "safety" | "clarification" | "reopen-diagnosis";
}

const WELDING_PROCESS_PATTERN =
  /\b(?:smaw|gmaw|gtaw|fcaw|mig|tig|stick|flux[- ]?cored|gas metal|gas tungsten|shielded metal)\b/i;

const SAFETY_HAZARD_PATTERN =
  /someone.?s under|someone.?s underneath|underneath.*someone|\b(?:unsafe|hazard|immediate danger|load.*shifted|under.*load|injur(?:y|ed|ing)|fire|electrical?|collapsed?|collapse|fall|trapped|tripped|critical|panic)\b/i;

function conversationText(
  history: readonly ChatCompletionMessageParam[],
  message: string,
): string {
  return [...history, { role: "user" as const, content: message }]
    .map((item) => String(item.content ?? ""))
    .join("\n");
}

function hasKnownWeldingProcess(
  history: readonly ChatCompletionMessageParam[],
  message: string,
): boolean {
  return WELDING_PROCESS_PATTERN.test(conversationText(history, message));
}

/**
 * Pilot-safe runtime guard for turns where an LLM must not fill in missing
 * field context. Returning null deliberately leaves ordinary conversation and
 * retrieval-supported answers on the normal model path.
 */
export function getConversationPolicyResponse(
  message: string,
  history: readonly ChatCompletionMessageParam[],
): ConversationPolicyResponse | null {
  const lower = message.toLowerCase().trim();

  if (SAFETY_HAZARD_PATTERN.test(lower)) {
    return {
      answer:
        "Stop and secure the area first. Is anyone still exposed to the hazard?",
      reason: "safety",
    };
  }

  if (
    /\b(?:i meant|meant)\b.*\b3g\b.*\bweld/i.test(lower) &&
    !hasKnownWeldingProcess(history, message)
  ) {
    return {
      answer: "Got it — 3G noted. What welding process are you running?",
      reason: "clarification",
    };
  }

  if (/\b(?:grinder|grinding)\b.*\bbog(?:s|ging)?\b/i.test(lower)) {
    return {
      answer:
        "I hear the symptom, but not the cause yet. What exactly slows down: the wheel, the motor, or the cut?",
      reason: "clarification",
    };
  }

  if (
    /\b(?:grinder|grinding)\b.*\b(?:fucked|useless|dead|broken)\b/i.test(lower)
  ) {
    return {
      answer:
        "I hear the conclusion. What observable behaviour are you seeing?",
      reason: "clarification",
    };
  }

  if (
    /\bchanged everything you told me\b/i.test(lower) &&
    /\b(?:still|yet)\b/i.test(lower)
  ) {
    return {
      answer:
        "I hear you. The previous diagnosis is still unresolved, so we need to reopen it. What changed in the result after those adjustments?",
      reason: "reopen-diagnosis",
    };
  }

  return null;
}
