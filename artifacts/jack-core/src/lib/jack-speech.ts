const MASCULINE_VOICE_MARKERS =
  /(?:^|[\s_#()\-/])(?:male|man|guy|david|daniel|james|george|alex|mark|tom|john|richard|michael|william|arthur|russell|oliver|liam)(?:$|[\s_#()\-/])/i;

const FEMININE_VOICE_MARKERS =
  /(?:^|[\s_#()\-/])(?:female|woman|girl|aria|ava|catherine|emma|jenny|karen|moira|samantha|susan|victoria|zira)(?:$|[\s_#()\-/])/i;

function normalizedLanguage(language: string | undefined) {
  return language?.trim().toLowerCase().replace(/_/g, "-") || "";
}

function languageScore(voiceLanguage: string, preferredLanguage: string) {
  const voice = normalizedLanguage(voiceLanguage);
  const preferred = normalizedLanguage(preferredLanguage);
  if (!voice || !preferred) return voice.startsWith("en") ? 1_500 : 0;

  const voiceBase = voice.split("-")[0];
  const preferredBase = preferred.split("-")[0];
  if (voice === preferred) return 3_000;
  if (voiceBase === preferredBase) return 2_500;
  if (voiceBase === "en") return 1_500;
  return 0;
}

function voiceDescriptor(voice: SpeechSynthesisVoice) {
  return `${voice.name} ${voice.voiceURI}`.trim();
}

/**
 * Pick Jack's speech voice deterministically.
 *
 * The Web Speech API does not expose a voice-gender field. Some browser and
 * Android voice names/URIs do identify a male voice, so prefer those markers
 * while keeping the requested language as the stronger constraint. If a
 * browser gives us no gender metadata, the caller can still use Jack's lower
 * pitch fallback; this function never guesses from array order.
 */
export function selectJackVoice(
  voices: readonly SpeechSynthesisVoice[],
  preferredLanguage = "en-US",
) {
  if (!voices.length) return undefined;

  return voices
    .map((voice, index) => {
      const descriptor = voiceDescriptor(voice);
      const masculine = MASCULINE_VOICE_MARKERS.test(descriptor);
      const feminine = FEMININE_VOICE_MARKERS.test(descriptor);
      // Locale is deliberately weighted more heavily than voice-gender
      // metadata. A clearly masculine voice in an unrelated language is a
      // worse fallback for Jack than a matching-language voice.
      const genderScore = masculine ? 400 : feminine ? -200 : 0;
      const localScore = voice.localService ? 10 : 0;
      return {
        voice,
        index,
        score:
          languageScore(voice.lang, preferredLanguage) +
          genderScore +
          localScore,
        descriptor: descriptor.toLowerCase(),
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.descriptor !== b.descriptor)
        return a.descriptor.localeCompare(b.descriptor);
      return a.index - b.index;
    })[0]?.voice;
}
