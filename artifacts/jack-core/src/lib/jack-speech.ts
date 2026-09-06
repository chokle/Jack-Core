import { customFetch } from "@workspace/api-client-react";

export type JackVoiceState =
  | "idle"
  | "loading"
  | "playing"
  | "unavailable"
  | "blocked";

function isPlaybackBlocked(error: unknown): boolean {
  // Browser DOMExceptions can cross realms and need not inherit this realm's Error.
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NotAllowedError"
  );
}

/** Authenticated canonical audio only; never falls back to device TTS. */
export class JackSpeechPlayer {
  private generation = 0;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private blockedText: string | null = null;

  constructor(private readonly onState: (state: JackVoiceState) => void) {}

  private clearDeadline() {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
  }

  cancel() {
    this.clearDeadline();
    this.blockedText = null;
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio = null;
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }

  async speak(text: string) {
    if (this.blockedText === text && this.audio) {
      const generation = this.generation;
      try {
        // Run play synchronously in the retry tap, preserving mobile user activation.
        await this.audio.play();
        if (generation === this.generation) {
          this.blockedText = null;
          this.onState("playing");
        }
      } catch (error) {
        if (generation !== this.generation) return;
        if (isPlaybackBlocked(error)) {
          this.onState("blocked");
        } else {
          this.cancel();
          this.onState("unavailable");
        }
      }
      return;
    }
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.onState("loading");
    this.timeout = setTimeout(() => {
      if (generation !== this.generation) return;
      this.cancel();
      this.onState("unavailable");
    }, 40_000);
    try {
      const blob = await customFetch<Blob>("/api/jack/speech", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
        responseType: "blob",
      });
      if (blob.type.split(";")[0]?.trim().toLowerCase() !== "audio/mpeg") {
        throw new Error("Canonical voice unavailable");
      }
      if (generation !== this.generation) return;
      this.clearDeadline();
      if (!blob.size) throw new Error("Empty voice response");
      this.url = URL.createObjectURL(blob);
      const audio = new Audio(this.url);
      this.audio = audio;
      audio.onended = () => {
        if (generation !== this.generation) return;
        this.cancel();
        this.onState("idle");
      };
      audio.onerror = () => {
        if (generation !== this.generation) return;
        this.cancel();
        this.onState("unavailable");
      };
      await audio.play();
      if (generation === this.generation) this.onState("playing");
    } catch (error) {
      if (generation !== this.generation) return;
      if (isPlaybackBlocked(error) && this.audio) {
        this.blockedText = text;
        this.onState("blocked");
      } else {
        this.cancel();
        this.onState("unavailable");
      }
    }
  }
}
