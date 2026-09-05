import { describe, expect, it } from "vitest";
import { selectJackVoice } from "./jack-speech";

function voice(
  name: string,
  lang: string,
  options: { localService?: boolean; voiceURI?: string } = {},
) {
  return {
    default: false,
    lang,
    localService: options.localService ?? true,
    name,
    voiceURI: options.voiceURI ?? name,
  } as unknown as SpeechSynthesisVoice;
}

describe("selectJackVoice", () => {
  it("prefers an explicitly masculine voice in the requested language", () => {
    const female = voice("Google UK English Female", "en-GB");
    const male = voice("Google UK English Male", "en-GB");

    expect(selectJackVoice([female, male], "en-GB")).toBe(male);
  });

  it("uses Android voice URI gender metadata when the display name is generic", () => {
    const female = voice("English United States", "en-US", {
      voiceURI: "en-us-x-sfg#female_1-local",
    });
    const male = voice("English United States", "en-US", {
      voiceURI: "en-us-x-sfg#male_1-local",
    });

    expect(selectJackVoice([female, male], "en-US")).toBe(male);
  });

  it("keeps language ahead of gender when no voice matches the locale", () => {
    const englishFemale = voice("Google US English Female", "en-US");
    const frenchMale = voice("Google français Male", "fr-FR");

    expect(selectJackVoice([frenchMale, englishFemale], "de-DE")).toBe(
      englishFemale,
    );
  });

  it("falls back deterministically when voices have no gender metadata", () => {
    const later = voice("Generic B", "en-US");
    const earlier = voice("Generic A", "en-US");

    expect(selectJackVoice([later, earlier], "en-US")).toBe(earlier);
  });
});
