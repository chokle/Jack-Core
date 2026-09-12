import { describe, it, expect, vi } from "vitest";

vi.mock("../openai.js", async () => {
  const m = await import("./mocks.js");
  return {
    chatCompletion: vi.fn(),
    createEmbedding: m.createEmbedding,
    MODELS: m.MODELS,
    openai: m.openai,
  };
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
import { JACK_SOUL_PROMPT } from "../soul.js";
import { JACK_CONSTITUTION_PROMPT } from "../constitution.js";
import { JACK_CORE_SYSTEM_MAP_PROMPT } from "../system-map.js";
import { JACK_CANONICAL_IDENTITY_BLOCK } from "../jack-identity.js";
import { buildInterviewSystemPrompt } from "../interview.js";
import { buildDistillationSystemPrompt } from "../distillation.js";

describe("Canadian jurisdiction policy", () => {
  it("keeps the authority order deterministic", () => {
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

  it("never defaults to US standards", () => {
    expect([...US_DEFAULT_STANDARDS]).toEqual(["OSHA", "AWS", "NEC"]);
    expect(JURISDICTION_POLICY_PROMPT).toMatch(/Do NOT default to OSHA, AWS welding codes, NEC/i);
    expect(JURISDICTION_POLICY_PROMPT).toMatch(/default jurisdiction is Canada/i);
  });

  it("keeps Canadian trade authorities explicit", () => {
    expect(JURISDICTION_POLICY_PROMPT).toMatch(/welding and safety[^\n]*CWB and CSA/i);
    expect(JURISDICTION_POLICY_PROMPT).toMatch(/apprenticeship and certification[^\n]*Red Seal/i);
    expect(JURISDICTION_POLICY_PROMPT).toContain("WorkSafeBC");
    expect(JURISDICTION_POLICY_PROMPT).toMatch(/instead of guessing/i);
  });

  it("keeps the brief Canada-first", () => {
    expect(JURISDICTION_POLICY_BRIEF).toMatch(/Default to Canada/i);
    for (const body of ["Red Seal", "CSA", "CWB"])
      expect(JURISDICTION_POLICY_BRIEF).toContain(body);
  });
});

describe("Ask Jack soul-first architecture", () => {
  it("uses one identity layer at answer time", () => {
    const prompt = buildChatSystemPrompt({ usedInternalKnowledge: true });

    expect(prompt).toContain(JACK_SOUL_PROMPT);
    expect(prompt).not.toContain(JACK_CONSTITUTION_PROMPT);
    expect(prompt).not.toContain(JACK_CORE_SYSTEM_MAP_PROMPT);
    expect(prompt).not.toContain(JACK_CANONICAL_IDENTITY_BLOCK);
  });

  it("keeps personality small and moves hard boundaries outside it", () => {
    const prompt = buildChatSystemPrompt({ usedInternalKnowledge: false });

    expect(prompt).toContain("JACK SOUL.");
    expect(prompt).toContain("Usually give 1-3 things to check");
    expect(prompt).toContain("Do not dump every plausible cause at once");
    expect(prompt).toContain("SOURCE / PROVENANCE:");
    expect(prompt).toContain("JURISDICTION — DEFAULT TO CANADA.");
    expect(prompt).toContain("JACK UI CONTEXT TRUST BOUNDARY:");
  });

  it("defaults field answers to short progressive disclosure", () => {
    const prompt = buildChatSystemPrompt({ usedInternalKnowledge: true });

    expect(prompt).toContain("Default to the shortest useful field answer");
    expect(prompt).toContain("Lead with the likely next move");
    expect(prompt).toContain("Usually give 1-3 checks at once");
    expect(prompt).toContain("Go deeper only when asked");
    expect(prompt).toContain("UNTRUSTED RETRIEVED LIBRARY SOURCE DATA");
  });

  it("keeps no-evidence handling concise and non-hallucinatory", () => {
    const prompt = buildChatSystemPrompt({ usedInternalKnowledge: false });
    expect(prompt).toMatch(/No internal library content matched/i);
    expect(prompt).toMatch(/say that briefly instead of guessing/i);
  });
});

describe("non-answer generation paths", () => {
  it("interview still carries the Canada boundary", () => {
    const prompt = buildInterviewSystemPrompt({
      name: "Welder",
      remaining: ["safety"],
      machineHint: undefined,
    });
    expect(prompt).toContain(JURISDICTION_POLICY_BRIEF);
    expect(prompt).toMatch(/never assume OSHA, AWS, NEC/i);
  });

  it("distillation still carries the Canada boundary", () => {
    const prompt = buildDistillationSystemPrompt("(none)");
    expect(prompt).toContain(JURISDICTION_POLICY_BRIEF);
    expect(prompt).toMatch(/CSA, CWB, Red Seal/);
  });
});
