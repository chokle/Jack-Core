/**
 * Perceive-First Runtime — No-Invented-Context Hard Gate
 *
 * This module enforces perceive-first behavior:
 * 1. Perceive provided context before reasoning
 * 2. Do not treat user conclusions as established facts
 * 3. Ambiguity → investigation, not invention
 * 4. One highest-value question per turn when essential context missing
 * 5. Safe known principles stated while unresolved causes remain unresolved
 */

/**
 * Represents the perceived context from a user message.
 */
export interface MessageContext {
  /** Raw user message */
  message: string;

  /** Detected topic/domain (welding, cutting, electrical, etc.) */
  topic: string | null;

  /** Observations user explicitly stated (facts they observed) */
  observations: string[];

  /** Conclusions/interpretations user made (not necessarily facts) */
  conclusions: string[];

  /** Explicitly provided context (process, thickness, material, etc.) */
  providedContext: Map<string, string>;

  /** Critical missing context that should be clarified */
  missingCriticalContext: string[];

  /** Whether this is immediate safety-critical */
  isSafetyCritical: boolean;

  /** Whether user is asking a genuine question (needs answer) vs making a statement */
  isQuestion: boolean;

  /** Highest-value single clarifying question if needed */
  suggestionForClarification: string | null;
}

/**
 * Analyze a user message to perceive its context before responding.
 * Returns the perceived context structure.
 */
export function analyzeMessageContext(message: string): MessageContext {
  const lower = message.toLowerCase();

  // Detect safety-critical signals
  const isSafetyCritical = /\b(unsafe|hazard|immediate danger|load.*shifted|under.*load|injury|injured|fire|electrical|collapsed|collapse|fall|trapped|critical|panic)\b/i.test(
    message,
  ) || /someone.?s\s+(under|underneath|trapped|underneath|shifting)/i.test(message)
    || /load.*(shifted|falling|falls)/i.test(message);

  // Detect topic
  const topicMatch = detectTopic(lower);

  // Parse observations vs conclusions
  const { observations, conclusions } = parseObservationsVsConclusions(message);

  // Extract provided context
  const providedContext = extractProvidedContext(message, topicMatch);

  // Detect critical missing context for the detected topic
  const missingCriticalContext = identifyMissingContext(
    topicMatch,
    providedContext,
    observations,
  );

  // Determine if this is a question
  const isQuestion = message.trim().endsWith("?");

  // Suggest a clarifying question if needed
  const suggestionForClarification =
    missingCriticalContext.length > 0
      ? selectClarifyingQuestion(topicMatch, providedContext, missingCriticalContext)
      : null;

  return {
    message,
    topic: topicMatch,
    observations,
    conclusions,
    providedContext,
    missingCriticalContext,
    isSafetyCritical,
    isQuestion,
    suggestionForClarification,
  };
}

/**
 * Detect the primary topic/domain of the message.
 */
function detectTopic(lower: string): string | null {
  if (
    /\b(weld|welding|smaw|fcaw|gmaw|gtaw|tack|root pass|bead|arc|shielding|heat input|travel speed|polarity|electrode|wire|3g|4g)\b/i.test(
      lower,
    )
  ) {
    return "welding";
  }
  if (
    /\b(grind|grinder|sander|sanding|surface prep|prep|angle grinder|belt sander)\b/i.test(lower)
  ) {
    return "grinding";
  }
  if (
    /\b(oxy[-\s]*fuel|oxyfuel|gas cutting|flame cut|flame|cutting|torch cut|acetylene|plasma|kerf)\b/i.test(
      lower,
    )
  ) {
    return "cutting";
  }
  if (/\b(electrical|wire|circuit|breaker|voltage|amp|power)\b/i.test(lower)) {
    return "electrical";
  }
  return null;
}

/**
 * Parse observations (what user saw/experienced) from conclusions (what user thinks it means).
 */
function parseObservationsVsConclusions(message: string): {
  observations: string[];
  conclusions: string[];
} {
  // Observations use present tense verbs, descriptors of what they see/hear/feel
  const observationPatterns = [
    /(?:i (?:see|hear|feel|notice|watch|observe)|(?:the|it|there).{0,30}(?:is|looks|sounds|appears))/i,
  ];

  // Conclusions use causal language, diagnosis, blame, or interpretation
  const conclusionPatterns = [
    /\b(is|must be|probably|likely|i think|i bet|i'm sure|caused by|because|due to|wrong|bad|fucked|broken)\b/i,
  ];

  const observations: string[] = [];
  const conclusions: string[] = [];

  // Simple heuristic: split by sentences and classify
  const sentences = message
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const sentence of sentences) {
    const hasObservation = observationPatterns.some((p) => p.test(sentence));
    const hasConclusion = conclusionPatterns.some((p) => p.test(sentence));

    if (hasConclusion && !hasObservation) {
      conclusions.push(sentence);
    } else {
      observations.push(sentence);
    }
  }

  return { observations, conclusions };
}

/**
 * Extract explicitly provided context from the message.
 */
function extractProvidedContext(
  message: string,
  topic: string | null,
): Map<string, string> {
  const context = new Map<string, string>();
  const lower = message.toLowerCase();

  // Welding-specific context
  if (topic === "welding") {
    // Process
    if (/\b(smaw|stick|fcaw|flux.?cored|gmaw|mig|tig|gtaw)\b/i.test(message)) {
      const match = message.match(
        /\b(smaw|stick|fcaw|flux.?cored|gmaw|mig|tig|gtaw)\b/i,
      );
      if (match) context.set("process", match[1]);
    }

    // Thickness / 3G/4G/vertical/flat
    if (/\b(3[Gg]|4[Gg]|vertical|flat|overhead|horizontal)\b/.test(message)) {
      const match = message.match(/\b(3[Gg]|4[Gg]|vertical|flat|overhead|horizontal)\b/);
      if (match) context.set("position", match[1]);
    }

    // Plate thickness
    if (/(\d+(?:\.\d+)?(?:"|mm|in))\s*(?:thick|plate)?/i.test(message)) {
      const match = message.match(/(\d+(?:\.\d+)?)\s*(?:"|mm|in)/);
      if (match) context.set("thickness", match[1]);
    }

    // Wire/electrode type
    if (/\b(E7018|E6010|E7024|ER70S.?6|308L|E71T.?1)\b/i.test(message)) {
      const match = message.match(/\b(E7018|E6010|E7024|ER70S.?6|308L|E71T.?1)\b/i);
      if (match) context.set("electrode", match[1]);
    }

    // Backing (including explicit "no backing" or "open root")
    if (/(backing|no backing|open root|root pass)/i.test(message)) {
      const match = message.match(/(backing|no backing|open root|root pass)/i);
      if (match) {
        context.set("backing", match[1]);
      }
    }

    // Settings/parameters (amps, voltage, etc)
    if (/(amps?|voltage|wire speed|travel speed|heat input|\d+\s*amp)/i.test(message)) {
      context.set("settings", "mentioned");
    }

    // Material
    if (/(carbon steel|stainless|mild steel|aluminum)/i.test(message)) {
      const match = message.match(/(carbon steel|stainless|mild steel|aluminum)/i);
      if (match) context.set("material", match[1]);
    }
  }

  // Generic context
  if (/\b(outside|inside|shop|jobsite|indoors?|outdoors?)\b/i.test(message)) {
    context.set("environment", "mentioned");
  }

  return context;
}

/**
 * Identify critical missing context for a given topic.
 */
function identifyMissingContext(
  topic: string | null,
  providedContext: Map<string, string>,
  observations: string[],
): string[] {
  const missing: string[] = [];

  if (topic === "welding") {
    // Critical sequence: process → position/thickness → backing → settings → environment
    if (!providedContext.has("process")) missing.push("process");
    if (!providedContext.has("position") && !providedContext.has("thickness"))
      missing.push("position or thickness");
    // Only flag backing if not mentioned at all (including "no backing")
    if (!providedContext.has("backing")) missing.push("backing/root setup");
    if (!providedContext.has("settings")) missing.push("parameters/settings");
  }

  if (topic === "grinding") {
    if (!providedContext.has("tool")) {
      missing.push("tool type (angle grinder, belt sander, etc)");
    }
    if (!providedContext.has("settings")) {
      missing.push("technique or pressure");
    }
  }

  if (topic === "cutting") {
    if (!providedContext.has("process")) {
      missing.push("cutting method");
    }
  }

  if (!providedContext.has("environment")) {
    // Environment only matters for some topics
    if (topic === "welding" || topic === "cutting" || topic === "electrical") {
      missing.push("environment (inside/outside, conditions)");
    }
  }

  return missing;
}

/**
 * Select the single highest-value clarifying question based on missing context.
 */
function selectClarifyingQuestion(
  topic: string | null,
  providedContext: Map<string, string>,
  missingContext: string[],
): string {
  // Prioritize by specificity and diagnostic value

  if (topic === "welding") {
    // Process is almost always first
    if (!providedContext.has("process")) {
      return "What process are you running?";
    }
    // Then position/thickness
    if (!providedContext.has("position") && !providedContext.has("thickness")) {
      return "What's the position and plate thickness you're working with?";
    }
    // Then backing
    if (!providedContext.has("backing")) {
      return "Are you using backing, or is this an open-root setup?";
    }
    // Then settings
    if (!providedContext.has("settings")) {
      return "What settings are you running?";
    }
  }

  if (topic === "grinding") {
    // What tool are we working with?
    if (!providedContext.has("tool")) {
      return "What tool are you using—angle grinder, belt sander, or something else?";
    }
    // Then technique
    if (!providedContext.has("settings")) {
      return "How much pressure are you applying, and what speed?";
    }
  }

  if (topic === "cutting") {
    if (!providedContext.has("process")) {
      return "What cutting method are you using?";
    }
  }

  // Fallback
  return "What are the main details we're working with?";
}

/**
 * Validate Jack's response for invented context.
 * Returns true if the response is safe (no invented context).
 */
export function validateResponseForInventedContext(
  context: MessageContext,
  response: string,
): { isValid: boolean; violations: string[] } {
  const violations: string[] = [];

  // If context was missing and we had a suggestion, ensure response is just acknowledgement + ONE question
  if (
    context.missingCriticalContext.length > 0 &&
    context.suggestionForClarification
  ) {
    const questionCount = (response.match(/\?/g) ?? []).length;
    if (questionCount !== 1) {
      violations.push(
        `Expected exactly 1 clarifying question when context is missing, got ${questionCount}`,
      );
    }

    // Check for invented context patterns
    const inventedPatterns = [
      { pattern: /assuming\s+you|i assume|i bet|probably|likely/i, reason: "assumed or speculated" },
      { pattern: /possible causes|might be|could be|may be|possible.*are/i, reason: "speculative list of causes without grounding" },
      { pattern: /try (adjusting|changing|setting|using).*without asking/i, reason: "prescribed action before confirming context" },
      {
        pattern: /\b(wire size|machine|voltage|amperage|WFS|material|thickness|joint config|backing|polarity|electrode type|wire type|shielding gas|E[0-9]{4}|ER70S)\b|0\.\d{3}|\d+\s*amps?/i,
        reason: "mentioned technical detail not provided by user",
      },
    ];

    for (const { pattern, reason } of inventedPatterns) {
      if (pattern.test(response)) {
        // Only flag if the response isn't just asking about it
        if (!response.includes("?")) {
          violations.push(`Invented context: ${reason}`);
        }
      }
    }
  }

  // Check for immediate safety violations
  if (context.isSafetyCritical) {
    // Response should immediately address safety, not ask questions
    if (response.includes("?") && !response.match(/immediately|now|right now|first/i)) {
      violations.push(
        "Safety-critical response should include immediate action, not just questions",
      );
    }
  }

  return {
    isValid: violations.length === 0,
    violations,
  };
}

/**
 * Enforce perceive-first behavior by generating a safe response when context is missing.
 */
export function generateAcknowledgementWithClarification(
  context: MessageContext,
): string {
  if (!context.suggestionForClarification) {
    return "Alright. What's happening?";
  }

  // Brief acknowledgement of what we heard + one highest-value question
  let response = "Alright.";

  // If there were observations, acknowledge them
  if (context.observations.length > 0) {
    response += " Got it.";
  }

  response += ` ${context.suggestionForClarification}`;

  return response;
}
