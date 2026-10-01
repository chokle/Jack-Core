import type {
  ChatResponse,
  Citation,
} from "../../../../lib/api-client-react/src/generated/api.schemas";
export type { ChatResponse, Citation };

export class JackApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(
      status === 401
        ? "Your session expired. Sign in again."
        : status === 403
          ? "Your account does not have access to this Jack resource."
          : status === 429
            ? "Jack is busy. Wait a moment and try again."
            : status === 503
              ? "This Jack service is unavailable. Try again shortly."
              : "Jack could not complete this request. Try again.",
    );
  }
}

export interface SourceDetail {
  title: string;
  text: string;
  videoUrl?: string | null;
}

export function validateApiOrigin(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Jack API must be an HTTPS origin without credentials or a path.",
    );
  }
  return url.origin;
}

/** Relative, server-owned playback routes only: never attach a bearer token to a citation URL. */
export function authorizedMediaUrl(
  origin: string,
  path: string,
  videoId: string,
) {
  const expected = `/api/videos/${encodeURIComponent(videoId)}/play`;
  if (path !== expected)
    throw new Error("Jack returned an unsupported source media URL.");
  return `${origin}${expected}`;
}

export function officialSourceUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Source must use a secure public link.");
  return url.toString();
}

export class JackApi {
  readonly origin: string;
  constructor(
    origin: string,
    private getToken: () => Promise<string | null>,
    private fetcher: typeof fetch = fetch,
  ) {
    this.origin = validateApiOrigin(origin);
  }

  private async request(path: string, options: RequestInit, context?: string) {
    const token = await this.getToken();
    if (!token) throw new JackApiError(401);
    if (options.signal?.aborted) {
      const error = new Error("Request interrupted or timed out. Try again.");
      error.name = "AbortError";
      throw error;
    }
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (context) headers.set("X-Jack-Context", context);
    headers.set("X-Jack-Surface", "native_android");
    const response = await this.fetcher(`${this.origin}${path}`, {
      ...options,
      headers,
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        code?: string;
      } | null;
      throw new JackApiError(response.status, body?.code);
    }
    return response;
  }

  async ask(
    message: string,
    context: string,
    signal: AbortSignal,
  ): Promise<ChatResponse> {
    if (!message.trim() || message.length > 2000)
      throw new Error("Questions must contain 1–2000 characters.");
    const response = await this.request(
      "/api/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim() }),
        signal,
      },
      context,
    );
    const data = (await response.json()) as ChatResponse;
    if (typeof data.answer !== "string" || !Array.isArray(data.citations))
      throw new Error("Jack returned an unreadable answer.");
    return data;
  }
  async authorize(signal: AbortSignal): Promise<void> {
    // Pilot/membership protected route. /api/me alone is deliberately insufficient.
    const response = await this.request("/api/chat/history", {
      method: "GET",
      signal,
    });
    await response.json(); // No client history restoration/cache in this first slice.
  }
  async transcribe(
    audio: FormData,
    context: string,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await this.request(
      "/api/jack/transcribe",
      { method: "POST", body: audio, signal },
      context,
    );
    const data = (await response.json()) as { text?: string };
    if (typeof data.text !== "string" || !data.text.trim())
      throw new Error("No speech was heard. Try again or type your question.");
    return data.text;
  }
  async speech(text: string, context: string, signal: AbortSignal) {
    const response = await this.request(
      "/api/jack/speech",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 5000) }),
        signal,
      },
      context,
    );
    if (!response.headers.get("content-type")?.startsWith("audio/mpeg"))
      throw new Error(
        "Jack's voice is unavailable. Read the answer or try replay.",
      );
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 8 * 1024 * 1024)
      throw new Error("Jack returned invalid audio.");
    return bytes;
  }
  async source(
    kind: "video" | "knowledge",
    id: string,
    signal: AbortSignal,
  ): Promise<SourceDetail> {
    if (!id || id.length > 160 || /[\u0000-\u001f\u007f]/.test(id))
      throw new Error("This citation has no valid source ID.");
    const response = await this.request(
      `/api/jack/sources/${kind}/${encodeURIComponent(id)}`,
      { method: "GET", signal },
    );
    return response.json();
  }
  async mediaHeaders(signal: AbortSignal) {
    const token = await this.getToken();
    if (!token) throw new JackApiError(401);
    if (signal.aborted) {
      const error = new Error("Request interrupted or timed out. Try again.");
      error.name = "AbortError";
      throw error;
    }
    return { Authorization: `Bearer ${token}` };
  }
}
