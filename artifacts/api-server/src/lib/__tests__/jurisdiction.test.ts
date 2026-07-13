import { describe, it, expect, vi } from "vitest";

// interview.ts and distillation.ts transitively import openai.ts (which throws at
// import time when OPENAI_API_KEY is unset) and supabase.ts. Mock both so the
// pure prompt builders can be imported with zero env/network — this mirrors the
// mock setup used by the other lib tests (see distillation.test.ts).
vi.mock("../openai.js", async () => {
  const m = await import("./mocks.js");
  return { chatCompletion: vi.fn(), createEmbedding: m.createEmbedding, MODELS: m.MODELS, openai: m.openai };
});
vi.mock("../supabase.js", async () => {
  const m = await import("./mocks.js");
  return { supabase: m.fake };
});

import {
  CANADIAN_SOURCE_PRIORITY,
  US_DEFAULT_STANDARDS,
  JURISDICTION_POLICY_PROMPT,
  JURISDICTION_POLICY_BRIEF,
  buildChatSystemPrompt,
} from "../jurisdiction.js";
import { buildInterviewSystemPrompt } from "../interview.js";
import { buildDistillationSystemPrompt } from "../distillation.js";
import {
  JACK_CORE_SYSTEM_MAP_BRIEF,
  JACK_CORE_SYSTEM_MAP_PROMPT,
  JACK_CORE_SYSTEMS,
} from "../system-map.js";

/**
 * QA checks for the "default jurisdiction = Canada" policy. These are
 * deterministic assertions over the canonical policy (the single source every
 * prompt embeds) plus the composed chat/interview/distillation prompts — no live
 * LLM call, so they run fast and offline in CI. They cover the five required
 * guarantees: (1) Canadian sources preferred, (2) OSHA/AWS/NEC never defaulted,
 * (3) CWB/CSA prioritized for welding & safety, (4) Red Seal prioritized for
 * apprenticeship & certification, (5) provincial regulators used when province
 * matters.
 */
describe("Canadian jurisdiction policy", () => {
  describe("QA #1 — Canadian sources are preferred", () => {
    it("ranks Torch first, then Red Seal, CSA, CWB, provincial, Canadian gov, international last", () => {
      expect([...CANADIAN_SOURCE_PRIORITY]).toEqual([
        "Torch Knowledge Repository",
        "Red Seal Occupational Standards",
        "CSA Standards",
        "CWB Standards",
        "Provincial regulations",
        "Trusted Canadian government and standards-related publications",
        "International sources",
      ]);
    });

    it("keeps international sources dead last", () => {
      expect(CANADIAN_SOURCE_PRIORITY[CANADIAN_SOURCE_PRIORITY.length - 1]).toBe("International sources");
    });

    it("lists the priority order, numbered in order, in the answer policy", () => {
      const p = JURISDICTION_POLICY_PROMPT;
      expect(p).toContain("1. Torch Knowledge Repository");
      expect(p).toContain("2. Red Seal Occupational Standards");
      expect(p).toContain("3. CSA Standards");
      expect(p).toContain("4. CWB Standards");
      expect(p).toContain("5. Provincial regulations");
      expect(p).toContain("6. Trusted Canadian government");
      expect(p).toContain("7. International sources");
      // International is conditional, never a default.
      expect(p).toMatch(/International sources[^\n]*ONLY when Canadian guidance is unavailable/);
    });

    it("searches Canadian sources first for any external knowledge", () => {
      expect(JURISDICTION_POLICY_PROMPT).toMatch(/search Canadian sources first/i);
    });
  });

  describe("QA #2 — OSHA/AWS/NEC are never used as defaults", () => {
    it("tracks exactly OSHA, AWS, NEC as forbidden defaults", () => {
      expect([...US_DEFAULT_STANDARDS]).toEqual(["OSHA", "AWS", "NEC"]);
    });

    it("names each US standard only to forbid defaulting to it", () => {
      expect(JURISDICTION_POLICY_PROMPT).toMatch(/Do NOT default to OSHA, AWS welding codes, NEC/);
      for (const std of US_DEFAULT_STANDARDS) {
        expect(JURISDICTION_POLICY_PROMPT).toContain(std);
      }
    });

    it("assumes Canada unless the user states otherwise", () => {
      expect(JURISDICTION_POLICY_PROMPT).toMatch(/default jurisdiction is Canada/i);
      expect(JURISDICTION_POLICY_PROMPT).toMatch(/unless the user explicitly states another jurisdiction/i);
    });
  });

  describe("QA #3 — CWB and CSA prioritized for welding and safety", () => {
    it("names CWB and CSA for welding/safety topics", () => {
      expect(JURISDICTION_POLICY_PROMPT).toMatch(/welding and safety[^\n]*prioritize CWB and CSA/i);
    });
  });

  describe("QA #4 — Red Seal prioritized for apprenticeship and certification", () => {
    it("names Red Seal for apprenticeship/certification topics", () => {
      expect(JURISDICTION_POLICY_PROMPT).toMatch(/apprenticeship and certification[^\n]*Red Seal/i);
    });
  });

  describe("QA #5 — provincial regulators used when the province matters", () => {
    it("names provincial regulators and the ask/flag rule", () => {
      const p = JURISDICTION_POLICY_PROMPT;
      expect(p).toContain("WorkSafeBC");
      expect(p).toContain("Alberta OHS");
      expect(p).toContain("Ontario MLITSD");
      expect(p).toMatch(/province matters/i);
      expect(p).toMatch(/provincial rules may vary/i);
    });
  });

  describe("conflict + unverifiable handling", () => {
    it("names the governing Canadian standard first on a conflict", () => {
      expect(JURISDICTION_POLICY_PROMPT).toMatch(/identify the governing Canadian standard FIRST/);
    });

    it("says so instead of guessing when it cannot verify a Canadian standard", () => {
      expect(JURISDICTION_POLICY_PROMPT).toMatch(/cannot verify the applicable Canadian standard, say so/i);
      expect(JURISDICTION_POLICY_PROMPT).toMatch(/instead of guessing/i);
    });
  });

  describe("the policy reaches every generation prompt", () => {
    it("chat answer prompt embeds the full policy and stays Torch-first", () => {
      const withCtx = buildChatSystemPrompt({ usedInternalKnowledge: true, contextText: "SEG-CONTEXT" });
      expect(withCtx).toContain("SOURCE PRIORITY ORDER");
      expect(withCtx).toContain("Torch Knowledge Repository");
      expect(withCtx).toContain("SEG-CONTEXT");

      const noCtx = buildChatSystemPrompt({ usedInternalKnowledge: false, contextText: "" });
      expect(noCtx).toContain("SOURCE PRIORITY ORDER");
      expect(noCtx).toMatch(/No internal library content matched/);
      expect(noCtx).toMatch(/say so rather than guessing/i);
    });

    it("gives Ask Jack one authoritative map of Jack Core", () => {
      const prompt = buildChatSystemPrompt({
        usedInternalKnowledge: false,
        contextText: "",
      });

      for (const system of JACK_CORE_SYSTEMS) {
        expect(prompt).toContain(system.name);
        expect(prompt).toContain(system.role);
      }
      expect(prompt).toContain(JACK_CORE_SYSTEM_MAP_PROMPT);
      expect(prompt).toMatch(/not an isolated generic chatbot/i);
      expect(prompt).toMatch(/cannot store information[^\n]*false descriptions/i);
      expect(prompt).toContain(
        "I do not have that record in my current retrieval context yet.",
      );
      expect(prompt).toMatch(/contribution is captured and being evaluated for Living Memory/i);
      expect(prompt).toMatch(/Only the interview's contributor may resume or answer/i);
    });

    it("interview prompt assumes Canada and forbids US defaults", () => {
      const s = buildInterviewSystemPrompt({ name: "Welder", remaining: ["safety"], machineHint: undefined });
      expect(s).toContain(JURISDICTION_POLICY_BRIEF);
      expect(s).toContain(JACK_CORE_SYSTEM_MAP_BRIEF);
      expect(s).toMatch(/never assume OSHA, AWS, NEC/);
    });

    it("distillation prompt records Canadian standards, not US equivalents", () => {
      const s = buildDistillationSystemPrompt("(none)");
      expect(s).toContain(JURISDICTION_POLICY_BRIEF);
      expect(s).toContain(JACK_CORE_SYSTEM_MAP_BRIEF);
      expect(s).toMatch(/do NOT record U\.S\. equivalents like OSHA, AWS, or NEC/);
      expect(s).toMatch(/CSA, CWB, Red Seal/);
    });
  });

  describe("jurisdiction brief", () => {
    it("is Canada-first, names Canadian bodies, and forbids US defaults", () => {
      const b = JURISDICTION_POLICY_BRIEF;
      expect(b).toMatch(/Default to Canada/i);
      for (const body of ["Red Seal", "CSA", "CWB", "WorkSafeBC"]) expect(b).toContain(body);
      for (const std of US_DEFAULT_STANDARDS) expect(b).toContain(std);
    });
  });
});
