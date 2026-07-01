/**
 * Shared singletons the vi.mock factories and the test bodies both reference, so
 * a test can seed rows / register embeddings and the code-under-test sees the
 * exact same in-memory state.
 */
import { FakeSupabase } from "./fake-supabase.js";

export const fake = new FakeSupabase();

/** Optional per-text embedding overrides; anything unset falls back to a hash. */
export const embedRegistry = new Map<string, number[]>();

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic, roughly-orthogonal 16-dim vector per input string. Distinct
 * texts land far apart in cosine space (well below the 0.85 merge threshold), so
 * only concepts explicitly registered as similar ever merge in tests.
 */
export function defaultEmbed(text: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rand = mulberry32(h);
  return Array.from({ length: 16 }, () => rand() * 2 - 1);
}

export const createEmbedding = async (text: string): Promise<number[]> =>
  embedRegistry.get(text) ?? defaultEmbed(text);

export const MODELS = {
  transcription: "whisper-1",
  embedding: "text-embedding-3-small",
  chat: "gpt-4o-mini",
  analysis: "gpt-4o-mini",
} as const;

export const openai = {} as unknown;

/** Wipe all in-memory tables and embedding overrides between tests. */
export function resetMocks(): void {
  for (const key of Object.keys(fake.tables)) fake.tables[key] = [];
  embedRegistry.clear();
}
