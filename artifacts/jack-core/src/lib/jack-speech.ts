const MASCULINE_VOICE_MARKERS =
  /(?:^|[\s_#()\-/])(?:male|man|guy|david|daniel|james|george|alex|mark|tom|john|richard|michael|william|arthur|russell|oliver|liam)(?:$|[\s_#()\-/])/i;

const FEMININE_VOICE_MARKERS =
  /(?:^|[\s_#()\-/])(?:female|woman|girl|aria|ava|catherine|emma|jenny|karen|moira|samantha|susan|victoria|zira)(?:$|[\s_#()\-/])/i;

const JACK_CUSTOM_VOICE_MARKERS =
  /(?:^|[\s_#()\-/])(?:jack|custom|clone|personal|user|my\s+voice|voice\s+clone|wavenet|neural2|journey|studio)(?:$|[\s_#()\-/])/i;

const JACK_VOICE_HINT_STORAGE_KEY = "jack.voice.hint";

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

function languageTier(voiceLanguage: string, preferredLanguage: string) {
  const voice = normalizedLanguage(voiceLanguage);
  const preferred = normalizedLanguage(preferredLanguage);
  if (!voice || !preferred) return voice.startsWith("en") ? 1 : 0;

  if (voice === preferred) return 3;
  if (voice.split("-")[0] === preferred.split("-")[0]) return 2;
  // English is Jack's safe fallback when the device has no voice for the
  // requested locale. Other languages are considered only when no English
  // fallback is available.
  return voice.split("-")[0] === "en" ? 1 : 0;
}

function voiceDescriptor(voice: SpeechSynthesisVoice) {
  return `${voice.name} ${voice.voiceURI}`.trim();
}

function normalizedHint(hint: string | undefined) {
  return hint?.trim().toLocaleLowerCase() || "";
}

function hasVoiceHint(voice: SpeechSynthesisVoice, hint: string) {
  const normalized = normalizedHint(hint);
  if (!normalized) return false;
  return (
    voice.name.trim().toLocaleLowerCase() === normalized ||
    voice.voiceURI.trim().toLocaleLowerCase() === normalized
  );
}

/**
 * Resolve an optional exact voice name/URI configured for a deployment or a
 * local device. The environment value wins over a stale device preference.
 */
export function getJackVoiceHint(
  envHint = typeof import.meta.env?.VITE_JACK_VOICE_HINT === "string"
    ? import.meta.env.VITE_JACK_VOICE_HINT
    : undefined,
  storage?: Pick<Storage, "getItem">,
) {
  const configured = envHint?.trim();
  if (configured) return configured;
  try {
    const deviceStorage =
      storage ??
      (typeof globalThis.localStorage === "undefined"
        ? undefined
        : globalThis.localStorage);
    return (
      deviceStorage?.getItem(JACK_VOICE_HINT_STORAGE_KEY)?.trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export function isJackVoiceHintMatch(
  voice: SpeechSynthesisVoice,
  hint: string | undefined,
) {
  return hasVoiceHint(voice, hint ?? "");
}

/** The Web Speech API has no gender field; only trust explicit voice markers. */
export function isExplicitlyMasculineJackVoice(
  voice: SpeechSynthesisVoice | undefined,
) {
  if (!voice) return false;
  const descriptor = voiceDescriptor(voice);
  const gender = (voice as SpeechSynthesisVoice & { gender?: string }).gender;
  if (gender?.toLowerCase() === "female") return false;
  return (
    (gender?.toLowerCase() === "male" ||
      MASCULINE_VOICE_MARKERS.test(descriptor) ||
      JACK_CUSTOM_VOICE_MARKERS.test(descriptor)) &&
    !FEMININE_VOICE_MARKERS.test(descriptor)
  );
}

function isFeminineVoice(voice: SpeechSynthesisVoice) {
  const gender = (voice as SpeechSynthesisVoice & { gender?: string }).gender;
  return (
    gender?.toLowerCase() === "female" ||
    FEMININE_VOICE_MARKERS.test(voiceDescriptor(voice))
  );
}

/**
 * Pick Jack's speech voice deterministically.
 *
 * The Web Speech API does not expose a voice-gender field. Some browser voice
 * names/URIs do identify a male voice, so prefer those markers whenever they
 * exist. Chromium's Android bridge commonly exposes only generic locale names
 * with no gender metadata; the caller handles that case with a pitch fallback.
 * This function never guesses from array order.
 */
export function selectJackVoice(
  voices: readonly SpeechSynthesisVoice[],
  preferredLanguage = "en-US",
  hint?: string,
) {
  if (!voices.length) return undefined;

  const scored = voices.map((voice, index) => {
    const descriptor = voiceDescriptor(voice);
    const masculine = isExplicitlyMasculineJackVoice(voice);
    const feminine = isFeminineVoice(voice);
    const custom =
      masculine && !feminine && JACK_CUSTOM_VOICE_MARKERS.test(descriptor);
    // An exact configured name/URI is the only intentional cross-language
    // override. For all other voices, language tier is selected first;
    // identity preference is applied only inside that tier.
    const identityScore = custom
      ? 20_000
      : masculine
        ? 10_000
        : feminine
          ? -1_000
          : 0;
    const localScore = voice.localService ? 10 : 0;
    return {
      voice,
      index,
      hinted: isJackVoiceHintMatch(voice, hint),
      languageTier: languageTier(voice.lang, preferredLanguage),
      score:
        languageScore(voice.lang, preferredLanguage) +
        identityScore +
        localScore,
      descriptor: descriptor.toLowerCase(),
    };
  });

  const hinted = scored.filter((candidate) => candidate.hinted);
  const candidates = hinted.length
    ? hinted
    : scored.filter(
        (candidate) =>
          candidate.languageTier ===
          Math.max(...scored.map((item) => item.languageTier)),
      );

  return candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.descriptor !== b.descriptor)
      return a.descriptor.localeCompare(b.descriptor);
    return a.index - b.index;
  })[0]?.voice;
}
