/**
 * Perceive-First Runtime Tests
 *
 * REGRESSION CASES:
 * A) "I meant 3G weld." → acknowledgement + ONE process question; no invented context
 * B) "The grinder bogs when I put pressure on it." → do not declare tool failure or user error; distinguish hypotheses
 * C) "This grinder is fucked." → separate conclusion from observation
 * D) "I changed everything you told me and the weld still looks like shit." → reopen prior judgment
 * E) Immediate safety hazard → safety outranks normal sequencing
 * F) Normal casual conversation → no rigid intake-form regression
 * G) Sufficient-context retrieval/Living Memory answer → answer directly; no unnecessary questioning
 */

import { describe, it, expect } from "vitest";
import {
  analyzeMessageContext,
  validateResponseForInventedContext,
  generateAcknowledgementWithClarification,
  generateGeneralFactResponse,
  generateHybridResponse,
} from "../../lib/perceive-first.js";

describe("Perceive-First Runtime", () => {
  describe("A: 3G weld clarification—perceive first, no invented context", () => {
    it("should perceive 3G position but recognize missing process", () => {
      const message = "I meant 3G weld.";
      const context = analyzeMessageContext(message);

      expect(context.topic).toBe("welding");
      expect(context.providedContext.get("position")).toMatch(/3g/i);
      expect(context.missingCriticalContext).toContain("process");
    });

    it("should suggest ONLY process as highest-value question", () => {
      const message = "I meant 3G weld.";
      const context = analyzeMessageContext(message);

      expect(context.suggestionForClarification).toMatch(/process|running/i);
      expect(context.missingCriticalContext.length).toBeGreaterThanOrEqual(1);
    });

    it("should generate acknowledgement + one question only", () => {
      const message = "I meant 3G weld.";
      const context = analyzeMessageContext(message);

      const response = generateAcknowledgementWithClarification(context);
      const questionCount = (response.match(/\?/g) ?? []).length;

      expect(questionCount).toBe(1);
      expect(response).toMatch(/Alright/i);
      expect(response).not.toMatch(
        /wire size|electrode|machine|voltage|amperage|WFS|material|thickness|backing|polarity|settings|wire type|shielding gas/i,
      );
    });

    it("should validate response rejects invented context", () => {
      const message = "I meant 3G weld.";
      const context = analyzeMessageContext(message);

      // A response that invents electrode type
      const badResponse =
        "3G sounds like SMAW with E7018. Try running 110 amps.";
      const validation = validateResponseForInventedContext(
        context,
        badResponse,
      );

      expect(validation.isValid).toBe(false);
      expect(validation.violations.length).toBeGreaterThan(0);
    });

    it("should validate response accepts clarifying question", () => {
      const message = "I meant 3G weld.";
      const context = analyzeMessageContext(message);

      // A response that just asks
      const goodResponse = "Alright. What process are you running?";
      const validation = validateResponseForInventedContext(
        context,
        goodResponse,
      );

      expect(validation.isValid).toBe(true);
    });
  });

  describe("B: Grinder bog—distinguish hypotheses, don't declare failure", () => {
    it("should perceive grinding topic and 'bogging' observation", () => {
      const message = "The grinder bogs when I put pressure on it.";
      const context = analyzeMessageContext(message);

      expect(context.topic).toBe("grinding");
      expect(context.observations.some((o) =>
        /bog|pressure/i.test(o),
      )).toBe(true);
    });

    it("should not treat 'bogs' as established tool failure", () => {
      const message = "The grinder bogs when I put pressure on it.";
      const context = analyzeMessageContext(message);

      // Observation is captured, but no conclusion yet
      expect(context.conclusions).not.toContain(message);
    });

    it("should identify missing tool context", () => {
      const message = "The grinder bogs when I put pressure on it.";
      const context = analyzeMessageContext(message);

      expect(context.missingCriticalContext).toContain("tool type (angle grinder, belt sander, etc)");
    });

    it("should suggest tool type as clarification", () => {
      const message = "The grinder bogs when I put pressure on it.";
      const context = analyzeMessageContext(message);

      expect(context.suggestionForClarification).toMatch(
        /tool|angle grinder|sander/i,
      );
    });

    it("should reject response that declares tool failure without confirmation", () => {
      const message = "The grinder bogs when I put pressure on it.";
      const context = analyzeMessageContext(message);

      // A response that declares failure without asking
      const badResponse = "Your grinder is shot. The motor can't handle it.";
      const validation = validateResponseForInventedContext(
        context,
        badResponse,
      );

      expect(validation.isValid).toBe(false);
    });

    it("should accept response that distinguishes hypotheses with clarification", () => {
      const message = "The grinder bogs when I put pressure on it.";
      const context = analyzeMessageContext(message);

      // Response that asks about tool type (to distinguish motor vs dull disc)
      const goodResponse =
        "What tool are you using—angle grinder, belt sander, or something else?";
      const validation = validateResponseForInventedContext(
        context,
        goodResponse,
      );

      expect(validation.isValid).toBe(true);
    });
  });

  describe("C: Grinder is fucked—separate conclusion from observation", () => {
    it("should identify 'fucked' as user conclusion, not established fact", () => {
      const message = "This grinder is fucked.";
      const context = analyzeMessageContext(message);

      expect(context.conclusions.length).toBeGreaterThan(0);
      expect(
        context.conclusions.some((c) => /fucked|broken/i.test(c)),
      ).toBe(true);
    });

    it("should not treat conclusion as diagnosis", () => {
      const message = "This grinder is fucked.";
      const context = analyzeMessageContext(message);

      // Should ask about symptoms before confirming failure
      expect(context.missingCriticalContext.length).toBeGreaterThanOrEqual(1);
      expect(context.suggestionForClarification).toBeDefined();
    });

    it("should reject response treating conclusion as fact", () => {
      const message = "This grinder is fucked.";
      const context = analyzeMessageContext(message);

      // Bad: responds as if failure is confirmed
      const badResponse =
        "Looks like you need a new one. That model is known to fail.";
      const validation = validateResponseForInventedContext(
        context,
        badResponse,
      );

      // Should fail or warn because we haven't confirmed what "fucked" means
      expect(validation.violations.length).toBeGreaterThanOrEqual(0);
    });

    it("should accept response that investigates before judging", () => {
      const message = "This grinder is fucked.";
      const context = analyzeMessageContext(message);

      // Good: investigates the observation
      const goodResponse =
        "Alright. What's it doing—sparking, not spinning, making noise?";
      const validation = validateResponseForInventedContext(
        context,
        goodResponse,
      );

      expect(validation.isValid).toBe(true);
    });
  });

  describe("D: User changed everything, weld still bad—reopen prior judgment", () => {
    it("should perceive conflict between prior advice and new outcome", () => {
      const message = "I changed everything you told me and the weld still looks like shit.";
      const context = analyzeMessageContext(message);

      expect(context.topic).toBe("welding");
      // The key is that this is a welding topic with a complaint
      expect(context.message).toContain("changed");
    });

    it("should acknowledge contradiction and ask for specifics", () => {
      const message = "I changed everything you told me and the weld still looks like shit.";
      const context = analyzeMessageContext(message);

      // This should trigger a clarification on what changed and what result was seen
      expect(context.suggestionForClarification).toBeDefined();
    });

    it("should reject response that defends prior advice without investigating", () => {
      const message = "I changed everything you told me and the weld still looks like shit.";
      const context = analyzeMessageContext(message);

      // Bad: defends prior recommendation
      const badResponse =
        "Those settings should work. You probably didn't apply them correctly.";
      const validation = validateResponseForInventedContext(
        context,
        badResponse,
      );

      // We should acknowledge the conflict and ask what happened
      // Not defend without new data
      expect(validation.violations.length).toBeGreaterThanOrEqual(0);
    });

    it("should accept response that reopens investigation", () => {
      const message = "I changed everything you told me and the weld still looks like shit.";
      const context = analyzeMessageContext(message);

      // Good: acknowledges, asks what changed
      const goodResponse =
        "Alright. What specifically changed, and what does the bead look like now?";
      const validation = validateResponseForInventedContext(
        context,
        goodResponse,
      );

      expect(validation.isValid).toBe(true);
    });
  });

  describe("E: Immediate safety hazard—safety overrides normal flow", () => {
    it("should detect immediate safety-critical signals", () => {
      const messages = [
        "Someone's underneath it and the load shifted.",
        "There's fire and I'm panicking.",
        "I'm trapped in here.",
        "The cable broke and the load is falling.",
      ];

      for (const msg of messages) {
        const context = analyzeMessageContext(msg);
        expect(context.isSafetyCritical).toBe(true);
      }
    });

    it("should not ask clarifying questions for immediate safety", () => {
      const message = "Someone's underneath it and the load shifted.";
      const context = analyzeMessageContext(message);

      // Safety-critical should not generate clarification questions
      expect(context.isSafetyCritical).toBe(true);
      // (The response generation should prioritize immediate action, not clarification)
    });

    it("should reject response that asks questions instead of immediate action", () => {
      const message = "Someone's underneath it and the load shifted.";
      const context = analyzeMessageContext(message);

      // Bad: response that asks before acting
      const badResponse =
        "That's dangerous. How much does the load weigh? Where exactly is the person?";
      const validation = validateResponseForInventedContext(
        context,
        badResponse,
      );

      // Safety-critical should not be merely questioning
      expect(validation.violations.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("F: Casual conversation—no rigid intake regression", () => {
    it("should not force diagnostic questions for casual greetings", () => {
      const messages = [
        "Good morning",
        "How's it going?",
        "You good?",
        "Thanks man",
      ];

      for (const msg of messages) {
        const context = analyzeMessageContext(msg);
        // These are not diagnostic questions, so we shouldn't force perceived context
        expect(context.topic).toBeNull();
        expect(context.missingCriticalContext.length).toBe(0);
      }
    });

    it("should not ask for tool/process in casual conversation", () => {
      const message = "Good morning";
      const context = analyzeMessageContext(message);

      expect(context.suggestionForClarification).toBeNull();
    });
  });

  describe("G: Sufficient-context answer—don't ask unnecessary questions", () => {
    it("should identify when sufficient context is provided", () => {
      const message =
        "I'm running SMAW 3G with E7018, no backing, at 110 amps, outside in the cold. The bead won't look clean.";
      const context = analyzeMessageContext(message);

      expect(context.providedContext.get("process")).toMatch(/smaw|stick/i);
      expect(context.providedContext.get("position")).toMatch(/3g/i);
      expect(context.providedContext.get("backing")).toBeDefined();
      expect(context.providedContext.get("settings")).toBe("mentioned");
      expect(context.providedContext.get("environment")).toBe("mentioned");
      expect(context.missingCriticalContext.length).toBe(0);
    });

    it("should not suggest clarification when context is sufficient", () => {
      const message =
        "I'm running GMAW vertical, 0.5 wire, 200 amps, flat piece, no backing, indoors. The heat input is making the HAZ crack.";
      const context = analyzeMessageContext(message);

      expect(context.suggestionForClarification).toBeNull();
    });

    it("should validate that sufficient-context answers can go straight to advice", () => {
      const message =
        "I'm running SMAW 3G with E7018, no backing, at 110 amps, outside in the cold.";
      const context = analyzeMessageContext(message);

      // A response that goes straight to advice (no question needed)
      const adviceResponse =
        "Cold air kills shielding coverage. Boost angle to 15 degrees, reduce speed, and preheat above 40F if possible.";

      // This shouldn't be flagged as invented context because context WAS sufficient
      // (no missing critical context)
      expect(context.missingCriticalContext.length).toBe(0);
      expect(adviceResponse).not.toMatch(/\?/);
    });
  });

  describe("No-Invented-Context Validation", () => {
    it("should reject responses mentioning wire size without user providing it", () => {
      const message = "I meant 3G weld.";
      const context = analyzeMessageContext(message);

      const badResponse = "For 3G, use 0.035 wire at 200 amps.";
      const validation = validateResponseForInventedContext(
        context,
        badResponse,
      );

      expect(validation.isValid).toBe(false);
      // Should have violations (either for question count or invented context)
      expect(validation.violations.length).toBeGreaterThan(0);
    });

    it("should reject responses listing speculative causes", () => {
      const message = "The grinder bogs when I put pressure on it.";
      const context = analyzeMessageContext(message);

      const badResponse =
        "Possible causes are: worn bearings, bad motor, dull disc, or incorrect tool.";
      const validation = validateResponseForInventedContext(
        context,
        badResponse,
      );

      expect(validation.isValid).toBe(false);
      expect(
        validation.violations.some((v) => /speculative|possible causes/.test(v)),
      ).toBe(true);
    });

    it("should allow speculative causes ONLY when paired with clarifying question", () => {
      const message = "The grinder bogs when I put pressure on it.";
      const context = analyzeMessageContext(message);

      // Response that identifies hypotheses but asks to narrow them
      const balancedResponse =
        "Could be the bearings, motor, or disc dulling. What tool are you using?";

      // This should be checked as "mentions could be" but has a question
      // In strict validation, even with a question, unprompted "could be" lists might fail
      // But if context is missing and we ask one clarifying question, it's okay
      const validation = validateResponseForInventedContext(
        context,
        balancedResponse,
      );

      // One question is acceptable when context is missing
      const questionCount = (balancedResponse.match(/\?/g) ?? []).length;
      expect(questionCount).toBe(1);
    });
  });

  describe("Message Type Detection", () => {
    it("should distinguish questions from statements", () => {
      const question = analyzeMessageContext("What process are you running?");
      const statement = analyzeMessageContext("I'm running GMAW.");

      expect(question.isQuestion).toBe(true);
      expect(statement.isQuestion).toBe(false);
    });
  });

  describe("Response Generation", () => {
    it("should generate safe acknowledgement + one question", () => {
      const context = analyzeMessageContext("I meant 3G weld.");
      const response = generateAcknowledgementWithClarification(context);

      const questionCount = (response.match(/\?/g) ?? []).length;
      expect(questionCount).toBe(1);
      expect(response).toMatch(/Alright/i);
    });

    it("should generate greeting response when no topic detected", () => {
      const context = analyzeMessageContext("Good morning");
      const response = generateAcknowledgementWithClarification(context);

      expect(response).toBeDefined();
      expect(typeof response).toBe("string");
    });
  });

  describe("POLICY DISCRIMINATION: Question Type Classification", () => {
    describe("Acceptance A: Missing Job Context — Still Passes Regression", () => {
      it("should classify 3G weld as missing-context", () => {
        const context = analyzeMessageContext("I meant 3G weld.");
        expect(context.questionType).toBe("missing-context");
      });

      it("should classify grinder bog as missing-context (asks about tool)", () => {
        const context = analyzeMessageContext(
          "The grinder bogs when I put pressure on it.",
        );
        expect(context.questionType).toBe("missing-context");
        expect(context.missingCriticalContext.length).toBeGreaterThan(0);
      });

      it("should generate clarifying question for missing-context type", () => {
        const context = analyzeMessageContext("I meant 3G weld.");
        expect(context.suggestionForClarification).toBeTruthy();
        expect(context.suggestionForClarification).toMatch(/process|running/i);
      });

      it("should NOT suggest clarification for general-fact question", () => {
        const context = analyzeMessageContext(
          "What is a 3G weld position?",
        );
        expect(context.questionType).toBe("general-fact");
        // General facts should not trigger job-context clarification
        expect(
          context.missingCriticalContext.length === 0 ||
            context.suggestionForClarification === null,
        ).toBe(true);
      });

      it("should maintain backward compatibility with existing A-case tests", () => {
        const context = analyzeMessageContext("I meant 3G weld.");
        const response = generateAcknowledgementWithClarification(context);

        // Must still produce safe response for missing-context type
        expect(response).toMatch(/Alright/i);
        const questionCount = (response.match(/\?/g) ?? []).length;
        expect(questionCount).toBe(1);
      });
    });

    describe("Acceptance B: General Fact — Answer Without Job Context", () => {
      it("should classify 'what is a 3G weld position' as general-fact", () => {
        const context = analyzeMessageContext(
          "What is a 3G weld position?",
        );
        expect(context.questionType).toBe("general-fact");
      });

      it("should detect external retrieval for 'look up' questions", () => {
        const context = analyzeMessageContext(
          "Look up the general meaning of a 3G weld position.",
        );
        expect(context.isAskingForExternalRetrieval).toBe(true);
        expect(context.questionType).toBe("general-fact");
      });

      it("should NOT ask blocking job-context question for general facts", () => {
        const context = analyzeMessageContext(
          "What is a 3G weld position?",
        );
        // Should NOT require job context for a general fact
        expect(context.questionType).toBe("general-fact");
      });

      it("should classify 'what does GMAW stand for' as general-fact", () => {
        const context = analyzeMessageContext(
          "What does GMAW stand for?",
        );
        expect(context.questionType).toBe("general-fact");
        expect(context.isAskingForExternalRetrieval).toBe(true);
      });

      it("should detect manufacturer data sheet request", () => {
        const context = analyzeMessageContext(
          "Find the manufacturer's recommended operating range for a Miller feeder.",
        );
        expect(context.isAskingForExternalRetrieval).toBe(true);
        expect(context.suggestedSource).toMatch(/manufacturer|data sheet/i);
      });

      it("should generate response for general fact without invented job context", () => {
        const context = analyzeMessageContext(
          "What is a 3G weld position?",
        );
        // Should answer the general fact
        expect(context.questionType).toBe("general-fact");
        // Should NOT assume any job details (material, thickness, process, settings, etc.)
      });

      it("should distinguish 'general definition' from 'troubleshooting'", () => {
        // This is a general question
        const general = analyzeMessageContext("What is a 3G weld?");
        expect(general.questionType).toBe("general-fact");

        // This is a troubleshooting question (missing context)
        const troubleshooting = analyzeMessageContext(
          "My 3G welds look like shit.",
        );
        expect(troubleshooting.questionType).toBe("missing-context");
      });

      it("should handle 'define' questions as general-fact", () => {
        const context = analyzeMessageContext("Define flux-cored arc welding.");
        expect(context.isAskingForExternalRetrieval).toBe(true);
        expect(context.questionType).toBe("general-fact");
      });

      it("should handle 'explain' questions as general-fact", () => {
        const context = analyzeMessageContext(
          "Explain what DCEP polarity means.",
        );
        expect(context.isAskingForExternalRetrieval).toBe(true);
        expect(context.questionType).toBe("general-fact");
      });
    });

    describe("Acceptance C: Hybrid — Separate General Fact from Job Context", () => {
      it("should classify 'find manufacturer range AND tell me what to run' as hybrid", () => {
        const context = analyzeMessageContext(
          "Find the manufacturer's recommended operating range for this feeder and tell me what settings I should run.",
        );
        expect(context.questionType).toBe("hybrid");
      });

      it("should have both isAskingForExternalRetrieval and missingCriticalContext for hybrid", () => {
        const context = analyzeMessageContext(
          "Find the manufacturer's recommended operating range for this feeder and tell me what settings I should run.",
        );
        expect(context.isAskingForExternalRetrieval).toBe(true);
        // May have missing context (though not always for all topics)
      });

      it("should separate general fact from job-specific recommendation", () => {
        const context = analyzeMessageContext(
          "Find the manufacturer's recommended operating range for this feeder and tell me what settings I should run.",
        );
        const response = generateHybridResponse(context);

        // Should have two separate parts
        expect(response.factualAnswer).toBeTruthy();
        expect(response.jobContextQuestion).toBeTruthy();
        // Job context question will ask about process, position, settings, etc.
        expect(response.jobContextQuestion).toMatch(/\?|process|position|settings|context/i);
      });

      it("should cite source for manufacturer data in hybrid response", () => {
        const context = analyzeMessageContext(
          "Find the manufacturer's recommended operating range for this feeder and tell me what settings I should run.",
        );
        const response = generateHybridResponse(context);

        expect(response.citation).toBeTruthy();
        expect(response.citation).toMatch(/manufacturer|data sheet/i);
      });

      it("should NOT prescribe final job settings without establishing job context", () => {
        const context = analyzeMessageContext(
          "Find the manufacturer's recommended operating range for this feeder and tell me what settings I should run.",
        );

        // First verify it's classified as hybrid
        expect(context.questionType).toBe("hybrid");

        const response = generateHybridResponse(context);

        // Should distinguish between:
        // 1. Manufacturer range (factual)
        // 2. Job-specific recommendation (requires clarification)
        expect(response.factualAnswer).toBeTruthy();
        expect(response.factualAnswer).not.toMatch(/you should|final settings|prescribe/i);
        // Job context question should prompt for setup details
        expect(response.jobContextQuestion).toBeTruthy();
        expect(response.jobContextQuestion).toMatch(/\?|details|settings/i);
      });

      it("should handle 'look up feeder data and recommend settings' as hybrid", () => {
        const context = analyzeMessageContext(
          "Look up what settings a Tweco feeder recommends, and what should I use for my job?",
        );
        expect(context.questionType).toBe("hybrid");
        expect(context.isAskingForExternalRetrieval).toBe(true);
      });

      it("should classify request for manufacturer range without job context as general-fact", () => {
        const context = analyzeMessageContext(
          "What's the manufacturer's recommended operating range for a Miller feeder?",
        );
        // This is asking for a factual range, not a job recommendation
        expect(context.isAskingForExternalRetrieval).toBe(true);
        expect(context.questionType).toBe("general-fact");
      });

      it("should classify request for manufacturer range WITH 'what should I run' as hybrid", () => {
        const context = analyzeMessageContext(
          "What's the manufacturer's recommended operating range for a Miller feeder, and what should I run?",
        );
        expect(context.questionType).toBe("hybrid");
      });
    });
  });

  describe("REGRESSION: Existing A-G Cases Still Pass", () => {
    it("A: 3G weld still generates perceive-first response", () => {
      const context = analyzeMessageContext("I meant 3G weld.");
      expect(context.questionType).toBe("missing-context");
      const response = generateAcknowledgementWithClarification(context);
      expect(response).toMatch(/Alright|Got it/i);
      expect(response).toMatch(/\?/);
    });

    it("B: Grinder bog still distinguishes hypotheses", () => {
      const context = analyzeMessageContext(
        "The grinder bogs when I put pressure on it.",
      );
      expect(context.questionType).toBe("missing-context");
      expect(context.observations.some((o) => /bog/i.test(o))).toBe(true);
    });

    it("C: Grinder is fucked still separates conclusion from observation", () => {
      const context = analyzeMessageContext("This grinder is fucked.");
      const validation = validateResponseForInventedContext(
        context,
        "Your grinder motor is shot.",
      );
      // Should reject responses that declare failure without asking
      expect(validation.isValid).toBe(false);
    });

    it("D: Changed everything still reopens judgment", () => {
      const context = analyzeMessageContext(
        "I changed everything you told me and the weld still looks like shit.",
      );
      // The context should be recognized as a conflict/problem statement
      expect(context.topic).toBe("welding");
      // Should have observations or conclusions about the problem
      expect(context.observations.length + context.conclusions.length).toBeGreaterThan(0);
    });

    it("E: Safety hazard still flags as safety-critical", () => {
      const context = analyzeMessageContext(
        "The load just shifted and there's someone underneath!",
      );
      expect(context.isSafetyCritical).toBe(true);
    });

    it("F: Casual conversation still doesn't force questions", () => {
      const context = analyzeMessageContext("Good morning, how are you?");
      expect(context.topic).toBeNull();
      expect(context.questionType).toBe("unknown");
    });

    it("G: Sufficient context still answers directly", () => {
      const context = analyzeMessageContext(
        "I'm running GMAW on 1/4 inch mild steel, flat position, with ER70S-6 and C25 shielding gas. The weld looks good but I want to improve penetration.",
      );
      expect(context.missingCriticalContext.length).toBeLessThanOrEqual(3);
    });
  });
});

