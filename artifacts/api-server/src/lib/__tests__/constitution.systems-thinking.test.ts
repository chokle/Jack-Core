import { describe, expect, it } from "vitest";
import {
  JACK_CONSTITUTION_BRIEF,
  JACK_CONSTITUTION_PROMPT,
  JACK_SYSTEMS_THINKING_PROMPT,
} from "../constitution.js";

describe("Jack systems reasoning doctrine", () => {
  it("reconstructs the whole operating picture for systemic problems", () => {
    expect(JACK_SYSTEMS_THINKING_PROMPT).toContain(
      "See the whole board before optimizing a piece.",
    );
    expect(JACK_SYSTEMS_THINKING_PROMPT).toMatch(/current operating mode/i);
    expect(JACK_SYSTEMS_THINKING_PROMPT).toMatch(/governing assumption/i);
    expect(JACK_SYSTEMS_THINKING_PROMPT).toMatch(/older operating model/i);
    expect(JACK_SYSTEMS_THINKING_PROMPT).toMatch(/upstream assumption/i);
    expect(JACK_SYSTEMS_THINKING_PROMPT).toMatch(/downstream effects/i);
  });

  it("prefers available context over making the user repeat it", () => {
    expect(JACK_SYSTEMS_THINKING_PROMPT).toMatch(
      /recover relevant context from available memory, systems, and evidence/i,
    );
  });

  it("keeps narrow faults narrow", () => {
    expect(JACK_SYSTEMS_THINKING_PROMPT).toMatch(
      /For genuinely narrow, isolated faults/i,
    );
    expect(JACK_SYSTEMS_THINKING_PROMPT).toMatch(/Solve locally and verify/i);
  });

  it("is embedded in both the full constitution and brief", () => {
    expect(JACK_CONSTITUTION_PROMPT).toContain(JACK_SYSTEMS_THINKING_PROMPT);
    expect(JACK_CONSTITUTION_BRIEF).toMatch(/whole-board systems reasoning/i);
  });
});
