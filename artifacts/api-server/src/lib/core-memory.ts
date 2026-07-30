/**
 * Versioned Core Memory is Jack's server-owned product identity. Conversation
 * text may propose a change, but it cannot mutate this configuration.
 */
export const JACK_CORE_MEMORY = {
  version: 1,
  identity:
    "I'm Jack, Torch's Field Intelligence. I help crews solve problems, capture hard-earned knowledge, and pass it forward.",
} as const;

const IDENTITY_QUESTIONS = [
  /^who are you[?.!]*$/i,
  /^what are you[?.!]*$/i,
  /^who are you and what do you do[?.!]*$/i,
  /^what do you do[?.!]*$/i,
  /^tell me (?:briefly )?who you are[?.!]*$/i,
  /^tell me about yourself[?.!]*$/i,
  /^who is jack[?.!]*$/i,
  /^what is jack[?.!]*$/i,
  /^what does jack do[?.!]*$/i,
  /^(?:describe|explain) jack(?:'s)? (?:identity|purpose|role)(?: in (?:more )?detail)?[?.!]*$/i,
  /^introduce yourself[?.!]*$/i,
] as const;

const CORRECTION_SIGNALS = [
  /^(?:a )?correction\s*[:,—-]\s*\S/i,
  /\bcorrect (?:that|this|your answer|the record)\b/i,
  /\bthat(?:'s| is) (?:wrong|incorrect|outdated)\b/i,
  /\b(?:treat|mark|use)\b.{0,50}\bcanonical\b/i,
  /\bsupersede\b.{0,80}\b(?:claim|wording|statement|previous|earlier)\b/i,
] as const;

const CORE_IDENTITY_SIGNALS = [
  /\bself[- ]description\b/i,
  /\bwho (?:jack|you) (?:is|are)\b/i,
  /\bjack(?:'s| is) (?:identity|description)\b/i,
  /\bfield intelligence\b/i,
  /\bai (?:trade )?intelligence engine\b/i,
] as const;

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isCoreIdentityQuestion(message: string): boolean {
  const value = normalized(message);
  return IDENTITY_QUESTIONS.some((pattern) => pattern.test(value));
}

export function isExplicitCorrection(message: string): boolean {
  const value = normalized(message);
  return CORRECTION_SIGNALS.some((pattern) => pattern.test(value));
}

export function targetsCoreIdentity(message: string): boolean {
  const value = normalized(message);
  return CORE_IDENTITY_SIGNALS.some((pattern) => pattern.test(value));
}

export function matchesCanonicalIdentity(message: string): boolean {
  const value = normalized(message).toLowerCase();
  const identity = normalized(JACK_CORE_MEMORY.identity).toLowerCase();
  const identityIndex = value.lastIndexOf(identity);
  if (identityIndex < 0) return false;

  // Quoting the current identity as the claim being replaced must not turn a
  // different proposed replacement into an already-canonical update.
  const before = value.slice(0, identityIndex);
  const after = value.slice(identityIndex + identity.length);
  if (/\breplace\b/.test(before) && /\bwith\b/.test(after)) return false;
  if (/\b(?:do not|don't|stop)\b.{0,40}$/.test(before)) return false;

  return after.replace(/[\s"'`.,;:!?()[\]{}—-]/g, "").length === 0;
}

export function correctionPersistenceReply(input: {
  stored: boolean;
  coreIdentity: boolean;
}): string {
  if (input.stored) {
    return input.coreIdentity
      ? "I saved that as a pending Core Memory correction. It has not replaced Jack's canonical identity; an authorized configuration review is still required."
      : "I saved that as a pending knowledge correction for review. It is not canonical or eligible for retrieval until a reviewer approves it.";
  }
  return "I couldn't store that correction durably, so I have not treated it as retained. Please try again.";
}
