import { describe, expect, it } from "vitest";
import {
  getJackVoiceHint,
  isExplicitlyMasculineJackVoice,
  selectJackVoice,
} from "./jack-speech";

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

  it("keeps a matching-language voice ahead of an unrelated masculine voice", () => {
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

  it("does not infer a masculine voice from a generic Android locale name", () => {
    const generic = voice("English United States", "en-US");

    expect(isExplicitlyMasculineJackVoice(generic)).toBe(false);
    expect(
      isExplicitlyMasculineJackVoice(
        voice("English United States", "en-US", {
          voiceURI: "en-us-x-sfg#male_1-local",
        }),
      ),
    ).toBe(true);
  });

  it("accepts explicit runtime gender metadata and rejects contradictory metadata", () => {
    const male = voice("English United States", "en-US");
    const female = voice("Jack", "en-US");
    Object.assign(male, { gender: "male" });
    Object.assign(female, { gender: "female" });

    expect(isExplicitlyMasculineJackVoice(male)).toBe(true);
    expect(isExplicitlyMasculineJackVoice(female)).toBe(false);
  });

  it("recognizes a named Jack custom or cloned voice", () => {
    expect(
      isExplicitlyMasculineJackVoice(
        voice("Jack Core Clone", "en-US", {
          voiceURI: "urn:jack-core:clone",
        }),
      ),
    ).toBe(true);
  });

  it("uses an exact configured name or URI before locale ranking", () => {
    const generic = voice("English United States", "en-US");
    const configured = voice("Personal voice", "en-GB", {
      voiceURI: "urn:custom:jack",
    });

    expect(
      selectJackVoice([generic, configured], "en-US", "urn:custom:jack"),
    ).toBe(configured);
  });

  it("ranks a generic matching locale above a clearly feminine voice", () => {
    const female = voice("Google US English Female", "en-US");
    const generic = voice("English United States", "en-US");

    expect(selectJackVoice([female, generic], "en-US")).toBe(generic);
  });

  it("prefers a build hint over a stale device hint", () => {
    const storage = { getItem: () => "stale-device-voice" };

    expect(getJackVoiceHint("VITE configured voice", storage)).toBe(
      "VITE configured voice",
    );
    expect(getJackVoiceHint(undefined, storage)).toBe("stale-device-voice");
  });
});
