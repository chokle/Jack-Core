import OpenAI from "openai";
import { createHash } from "crypto";

const apiKey = process.env["OPENAI_API_KEY"];
if (!apiKey) throw new Error("OPENAI_API_KEY is required");

export const openai = new OpenAI({ apiKey });

/**
 * Cost-efficient model defaults. These are the only models the app uses by
 * default. Larger/premium models must be opted into explicitly per call.
 */
export const MODELS = {
  /** Cheapest hosted transcription model. */
  transcription: "whisper-1",
  /** Small, low-cost embedding model used for all RAG + similarity. */
  embedding: "text-embedding-3-small",
  /** Mini chat model for Ask Jack. */
  chat: "gpt-4o-mini",
  /** Mini chat model for video analysis (use a larger model only on request). */
  analysis: "gpt-4o-mini",
} as const;

/**
 * In-memory cache for embeddings keyed by (model + input). Identical query
 * strings (repeated searches / chat turns) reuse the same vector instead of
 * paying for a new embeddings call.
 */
const embeddingCache = new Map<string, number[]>();
const inFlight = new Map<string, Promise<number[]>>();
const EMBEDDING_CACHE_MAX = 1000;

function embeddingKey(model: string, input: string): string {
  return createHash("sha256").update(`${model}:${input}`).digest("hex");
}

/**
 * Create an embedding with transparent caching. Identical inputs reuse a cached
 * vector, and concurrent identical requests are coalesced onto a single API
 * call (no duplicate spend). Set `cache: false` for one-time large inputs
 * (e.g. a full transcript) that won't be requested again.
 */
export async function createEmbedding(
  input: string,
  opts: { model?: string; cache?: boolean } = {}
): Promise<number[]> {
  const model = opts.model ?? MODELS.embedding;
  const useCache = opts.cache ?? true;
  const key = embeddingKey(model, input);

  if (useCache) {
    const cached = embeddingCache.get(key);
    if (cached) return cached;
    const pending = inFlight.get(key);
    if (pending) return pending;
  }

  const request = (async () => {
    const res = await openai.embeddings.create({ model, input });
    const embedding = res.data[0]?.embedding ?? [];

    if (useCache && embedding.length > 0) {
      if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
        const firstKey = embeddingCache.keys().next().value;
        if (firstKey) embeddingCache.delete(firstKey);
      }
      embeddingCache.set(key, embedding);
    }

    return embedding;
  })();

  if (!useCache) return request;

  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Create embeddings for many inputs in one pass. The embeddings API accepts an
 * array input, so we batch (default 96 per request) to minimize round-trips and
 * cost when indexing all of a transcript's segments. Returns one vector per
 * input, in the same order. Not cached — segment text is one-time index input.
 */
export async function createEmbeddings(
  inputs: string[],
  opts: { model?: string; batchSize?: number } = {}
): Promise<number[][]> {
  const model = opts.model ?? MODELS.embedding;
  const batchSize = opts.batchSize ?? 96;
  const out: number[][] = [];

  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize);
    const res = await openai.embeddings.create({ model, input: batch });
    // The API may return items out of order — sort by `index` to realign them
    // with the inputs before appending.
    const ordered = [...res.data].sort((a, b) => a.index - b.index);
    for (const d of ordered) out.push(d.embedding ?? []);
  }

  return out;
}
