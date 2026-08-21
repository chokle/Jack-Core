import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export interface ConversationPolicyResponse {
  answer: string;
  reason: "safety" | "clarification" | "reopen-diagnosis";
}

const WELDING_PROCESS_PATTERN =
  /\b(?:smaw|gmaw|gtaw|fcaw|mig|tig|stick|flux[- ]?cored|gas metal|gas tungsten|shielded metal)\b/i;

const IMMEDIATE_PERSONNEL_HAZARD_PATTERNS = [
  /\b(?:someone|somebody|anyone|a person|worker|crew member|operator)\b.{0,50}\b(?:under|underneath|trapped|injured|hurt|falling|on fire|being shocked|electrocuted|in immediate danger)\b/i,
  /\b(?:under|underneath)\b.{0,40}\b(?:load|equipment|structure|vehicle)\b.{0,40}\b(?:someone|somebody|anyone|person|worker|crew)\b/i,
  /\b(?:load|equipment|structure|scaffold|wall)\b.{0,50}\b(?:shifted|collapsed|falling|fell)\b.{0,50}\b(?:someone|somebody|anyone|person|worker|crew)\b/i,
  /\b(?:live wire|energized|electric shock|electrical shock|fire|smoke)\b.{0,50}\b(?:someone|somebody|anyone|person|worker|crew|injured|hurt|exposed)\b/i,
  /\b(?:someone|somebody|anyone|person|worker|crew)\b.{0,50}\b(?:live wire|energized|electric shock|electrical shock|fire|smoke)\b/i,
];

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

  if (
    IMMEDIATE_PERSONNEL_HAZARD_PATTERNS.some((pattern) => pattern.test(lower))
  ) {
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
