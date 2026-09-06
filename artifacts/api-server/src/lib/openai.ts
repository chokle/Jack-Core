import OpenAI from "openai";
import { createHash } from "crypto";
import { trackInference } from "./vitality.js";
import {
  currentJackUiRequestContext,
  formatJackUiContextForModel,
} from "./jack-ui-request-context.js";
import { ASK_JACK_UI_CONTEXT_SENTINEL } from "./jurisdiction.js";

let cachedOpenAI: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!cachedOpenAI) {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for AI-backed routes");
    }
    cachedOpenAI = new OpenAI({ apiKey });
  }

  return cachedOpenAI;
}

export const openai = new Proxy({} as OpenAI, {
  get(_target, prop) {
    const client = getOpenAI();
    return Reflect.get(client, prop, client);
  },
});

function foregroundJackMessages(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): {
  enabled: boolean;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
} {
  const first = messages[0];
  if (
    !first ||
    first.role !== "system" ||
    typeof first.content !== "string" ||
    !first.content.startsWith(ASK_JACK_UI_CONTEXT_SENTINEL)
  ) {
    return { enabled: false, messages };
  }

  const cleaned = first.content
    .slice(ASK_JACK_UI_CONTEXT_SENTINEL.length)
    .replace(/^\n/, "");
  return {
    enabled: true,
    messages: [{ ...first, content: cleaned }, ...messages.slice(1)],
  };
}

/**
 * Add request-local Jack application context only when the server-owned Ask Jack
 * foreground system prompt explicitly opts in. General-purpose/background model
 * calls do not carry the opt-in marker and therefore never inherit ambient UI
 * state, even when they execute concurrently inside the same request scope.
 */
export function withJackUiRequestContext(
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const foreground = foregroundJackMessages([...params.messages]);
  if (!foreground.enabled) return params;

  const context = currentJackUiRequestContext();
  if (!context) return { ...params, messages: foreground.messages };

  const uiMessage: OpenAI.Chat.Completions.ChatCompletionUserMessageParam = {
    role: "user",
    content: formatJackUiContextForModel(context),
  };
  const messages = [...foreground.messages];
  let insertAt = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      insertAt = index;
      break;
    }
  }
  messages.splice(insertAt, 0, uiMessage);
  return { ...params, messages };
}

/**
 * Chat-completion wrapper that reports "reasoning" activity to the Vitality
 * Engine (llm:start/end, plus an error signal on failure). Use this instead of
 * `openai.chat.completions.create` directly so the heartbeat widget reflects
 * every model call. Non-streaming only — Jack does not stream completions.
 */
export function chatCompletion(
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const request = withJackUiRequestContext(params);
  return trackInference(() => openai.chat.completions.create(request));
}

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
  opts: { model?: string; cache?: boolean } = {},
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
    const res = await trackInference(() =>
      openai.embeddings.create({ model, input }),
    );
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
  opts: { model?: string; batchSize?: number } = {},
): Promise<number[][]> {
  const model = opts.model ?? MODELS.embedding;
  const batchSize = opts.batchSize ?? 96;
  const out: number[][] = [];

  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize);
    const res = await trackInference(() =>
      openai.embeddings.create({ model, input: batch }),
    );
    // The API may return items out of order — sort by `index` to realign them
    // with the inputs before appending.
    const ordered = [...res.data].sort((a, b) => a.index - b.index);
    for (const d of ordered) out.push(d.embedding ?? []);
  }

  return out;
}
