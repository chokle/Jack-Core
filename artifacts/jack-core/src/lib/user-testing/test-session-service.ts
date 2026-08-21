export type TestEventType =
  | "test_completed"
  | "test_abandoned"
  | "onboarding_started"
  | "onboarding_step_completed"
  | "onboarding_completed"
  | "onboarding_skipped"
  | "feature_viewed"
  | "workflow_completed"
  | "recording_started"
  | "recording_stopped"
  | "recording_upload_succeeded"
  | "recording_upload_failed"
  | "feedback_submitted"
  | "reliability_error";

export type ConsentState = "granted" | "declined" | "withdrawn";

export interface TestSession {
  id: string;
  organizationId: string;
  pilotId: string;
  appSessionId: string;
  status: "active" | "completed" | "abandoned" | "expired" | "withdrawn";
  telemetryStatus: "granted" | "withdrawn";
  screenConsentState: ConsentState;
  microphoneConsentState: ConsentState;
  onboardingStatus: "not_started" | "in_progress" | "completed" | "skipped";
  onboardingStep: number;
  recordingStatus: string;
  feedbackStatus: string;
  questionCount: number;
  startedAt: string;
  resumedAt?: string | null;
  lastActivityAt: string;
  expiresAt: string;
}

export interface TelemetryContext {
  enrolled: boolean;
  requiresPilotSelection: boolean;
  scope: {
    organizationId: string;
    pilotId: string;
    organizationName?: string;
    pilotName?: string;
  } | null;
  consents: {
    telemetry: {
      state: ConsentState;
      privacyNoticeVersion: string;
      consentVersion: string;
    } | null;
    screen: {
      state: ConsentState;
      privacyNoticeVersion: string;
      consentVersion: string;
    } | null;
    microphone: {
      state: ConsentState;
      privacyNoticeVersion: string;
      consentVersion: string;
    } | null;
    conversationReview: {
      state: ConsentState;
      privacyNoticeVersion: string;
      consentVersion: string;
    } | null;
  };
  session: TestSession | null;
  privacyNoticeVersion: string;
  consentVersion: string;
  conversationReviewConsentVersion: string;
}

interface QueuedEvent {
  sessionId: string;
  eventId: string;
  eventType: TestEventType;
  occurredAt: string;
  appSessionId: string;
  metadata: Record<string, string | number | boolean>;
  result: "success" | "failure" | "cancelled" | "unavailable";
  correlationId?: string;
  requestId?: string;
  dedupeKey?: string;
  appVersion?: string;
  deployVersion?: string;
  deviceCategory: "desktop" | "tablet" | "mobile";
  schemaVersion: 1;
}

const SESSION_CACHE_KEY = "jack.userTesting.activeSession.v2";
const APP_SESSION_KEY = "jack.appSession.v1";
const EVENT_QUEUE_KEY = "jack.userTesting.eventQueue.v1";
const MAX_QUEUE_SIZE = 100;
let startRequest: Promise<TestSession> | null = null;
let flushRequest: Promise<TestSession | null> | null = null;
let initialized = false;

function uuid(): string {
  return crypto.randomUUID();
}

export function getAppSessionId(): string {
  try {
    const existing = sessionStorage.getItem(APP_SESSION_KEY);
    if (existing) return existing;
    const created = uuid();
    sessionStorage.setItem(APP_SESSION_KEY, created);
    return created;
  } catch {
    return uuid();
  }
}

export function deviceCategory(): "desktop" | "tablet" | "mobile" {
  if (typeof window === "undefined") return "desktop";
  const width = window.innerWidth;
  if (width < 768) return "mobile";
  if (width < 1024) return "tablet";
  return "desktop";
}

export function getCachedTestSession(): TestSession | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(SESSION_CACHE_KEY) ?? "null",
    ) as TestSession | null;
    return value?.id && value.status === "active" ? value : null;
  } catch {
    return null;
  }
}

export function cacheTestSession(session: TestSession | null): void {
  try {
    if (session?.status === "active") {
      sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(session));
    } else {
      sessionStorage.removeItem(SESSION_CACHE_KEY);
    }
  } catch {
    // The server remains authoritative when browser storage is unavailable.
  }
}

function readQueue(): QueuedEvent[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(EVENT_QUEUE_KEY) ?? "[]",
    );
    return Array.isArray(value) ? (value as QueuedEvent[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedEvent[]): void {
  try {
    localStorage.setItem(EVENT_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // A later server refresh remains authoritative when local storage is unavailable.
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok)
    throw new Error(body.error || "Request could not be completed.");
  return body;
}

export async function loadTelemetryContext(
  pilotId?: string,
): Promise<TelemetryContext> {
  const query = pilotId ? `?pilotId=${encodeURIComponent(pilotId)}` : "";
  const response = await fetch(`/api/testing/telemetry/context${query}`, {
    credentials: "include",
  });
  const context = await readJson<TelemetryContext>(response);
  cacheTestSession(context.session);
  return context;
}

export async function saveTelemetryConsents(input: {
  pilotId: string;
  telemetry: "granted" | "declined";
  screen: "granted" | "declined";
  microphone: "granted" | "declined";
  conversationReview: "granted" | "declined";
  privacyNoticeVersion: string;
  consentVersion: string;
  conversationReviewConsentVersion: string;
}): Promise<TelemetryContext> {
  const response = await fetch("/api/testing/telemetry/consents", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readJson<TelemetryContext>(response);
}

export async function withdrawTelemetry(
  pilotId: string,
  scopes: Array<
    "telemetry" | "screen" | "microphone" | "conversationReview"
  > = ["telemetry"],
): Promise<{ withdrawn: string[]; deletionDueAt: string | null }> {
  if (scopes.includes("telemetry")) {
    cacheTestSession(null);
    writeQueue([]);
  }
  window.dispatchEvent(
    new CustomEvent("jack:telemetry-withdrawn", {
      detail: { withdrawn: scopes, deletionDueAt: null },
    }),
  );
  const response = await fetch("/api/testing/telemetry/withdraw", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pilotId, scopes }),
  });
  const result = await readJson<{
    withdrawn: string[];
    deletionDueAt: string | null;
  }>(response);
  return result;
}

export function exportTelemetry(): void {
  window.location.assign("/api/testing/telemetry/export");
}

async function readSessionResponse(response: Response): Promise<TestSession> {
  const body = await readJson<{ session: TestSession }>(response);
  cacheTestSession(body.session);
  return body.session;
}

export function startTestSession(pilotId?: string): Promise<TestSession> {
  if (startRequest) return startRequest;
  startRequest = fetch("/api/testing/sessions/start", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(pilotId ? { pilotId } : {}),
      appSessionId: getAppSessionId(),
      appVersion: import.meta.env.VITE_APP_VERSION || undefined,
      deployVersion: import.meta.env.VITE_DEPLOY_VERSION || undefined,
      deviceCategory: deviceCategory(),
    }),
  })
    .then(readSessionResponse)
    .finally(() => {
      startRequest = null;
    });
  return startRequest;
}

export async function loadCurrentTestSession(
  pilotId?: string,
): Promise<TestSession | null> {
  const query = pilotId ? `?pilotId=${encodeURIComponent(pilotId)}` : "";
  const response = await fetch(`/api/testing/sessions/current${query}`, {
    credentials: "include",
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { session: TestSession | null };
  cacheTestSession(body.session);
  return body.session;
}

async function reportDropped(sessionId: string, count: number): Promise<void> {
  try {
    await fetch(
      `/api/testing/sessions/${encodeURIComponent(sessionId)}/ingest-failures`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reasonCode: "queue_overflow",
          eventCount: count,
        }),
      },
    );
  } catch {
    // Payload-free observability is best effort and never blocks the product.
  }
}

export function flushTestEvents(): Promise<TestSession | null> {
  if (flushRequest) return flushRequest;
  flushRequest = (async () => {
    let latest = getCachedTestSession();
    let queue = readQueue();

    const persistQueue = (updated: QueuedEvent[]): void => {
      queue = updated;
      writeQueue(updated);
    };

    const isRetryable = (status: number): boolean =>
      status >= 500 || status === 408 || status === 429;

    while (queue.length > 0) {
      const next = queue[0];
      try {
        const response = await fetch(
          `/api/testing/sessions/${encodeURIComponent(next.sessionId)}/events`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              eventId: next.eventId,
              eventType: next.eventType,
              occurredAt: next.occurredAt,
              appSessionId: next.appSessionId,
              metadata: next.metadata,
              result: next.result,
              correlationId: next.correlationId,
              requestId: next.requestId,
              dedupeKey: next.dedupeKey,
              appVersion: next.appVersion,
              deployVersion: next.deployVersion,
              deviceCategory: next.deviceCategory,
              schemaVersion: next.schemaVersion,
            }),
          },
        );

        if (!response.ok) {
          if (isRetryable(response.status)) {
            persistQueue(queue);
            return latest;
          }

          persistQueue(queue.slice(1));
          continue;
        }

        const body = (await response.json()) as { session: TestSession };
        latest = body.session;
        cacheTestSession(latest);
        persistQueue(queue.slice(1));
      } catch {
        persistQueue(queue);
        return latest;
      }
    }

    persistQueue([]);
    return latest;
  })().finally(() => {
    flushRequest = null;
  });
  return flushRequest;
}

export async function trackTestEvent(
  eventType: TestEventType,
  metadata: Record<string, string | number | boolean> = {},
  dedupeKey?: string,
  result?: QueuedEvent["result"],
): Promise<TestSession | null> {
  const session = getCachedTestSession();
  if (!session || session.telemetryStatus !== "granted") return null;
  const queue = readQueue();
  const event: QueuedEvent = {
    sessionId: session.id,
    eventId: uuid(),
    eventType,
    occurredAt: new Date().toISOString(),
    appSessionId: getAppSessionId(),
    metadata,
    result:
      result ??
      (eventType.endsWith("_failed") || eventType === "reliability_error"
        ? "failure"
        : eventType === "test_abandoned" || eventType === "onboarding_skipped"
          ? "cancelled"
          : "success"),
    ...(dedupeKey ? { dedupeKey } : {}),
    appVersion: import.meta.env.VITE_APP_VERSION || undefined,
    deployVersion: import.meta.env.VITE_DEPLOY_VERSION || undefined,
    deviceCategory: deviceCategory(),
    schemaVersion: 1,
  };
  const next = [...queue, event];
  const overflow = Math.max(0, next.length - MAX_QUEUE_SIZE);
  writeQueue(overflow ? next.slice(overflow) : next);
  if (overflow) void reportDropped(session.id, overflow);
  return flushTestEvents();
}

export function initializeTelemetryRetry(): () => void {
  if (initialized) return () => {};
  initialized = true;
  const onOnline = () => void flushTestEvents();
  window.addEventListener("online", onOnline);
  void flushTestEvents();
  return () => {
    initialized = false;
    window.removeEventListener("online", onOnline);
  };
}
