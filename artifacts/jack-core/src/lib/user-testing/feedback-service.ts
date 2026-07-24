export const FEEDBACK_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const MINIMUM_FEEDBACK_SESSION_MS = 30_000;

export type FeedbackTrigger =
  | "logout"
  | "interview_complete"
  | "ask_jack_complete"
  | "desktop_exit";

export type FeedbackFeature =
  | "ask_jack"
  | "interview_mode"
  | "memory_graph"
  | "library"
  | "knowledge_review"
  | "video_detail";

export type DeviceCategory = "desktop" | "tablet" | "mobile";

export interface FeedbackAnswers {
  feedbackId: string;
  goal: string;
  useful: "" | "yes" | "partly" | "no";
  shortfall: string;
  adoptionNeed: string;
  additional: string;
}
interface ActivityState {
  sessionId: string;
  arrivedAt: number;
  features: FeedbackFeature[];
}

const SESSION_KEY = "jack.userTesting.feedbackSession.v1";
const DRAFT_PREFIX = "jack.userTesting.feedbackDraft.v1:";
const COOLDOWN_PREFIX = "jack.userTesting.feedbackCooldown.v1:";

function readJson<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(storage: Storage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in private mode. Feedback remains usable
    // in-memory; only restoration/cooldown becomes best-effort.
  }
}

export function getFeedbackActivity(now = Date.now()): ActivityState {
  const stored = readJson<ActivityState>(window.sessionStorage, SESSION_KEY);
  if (
    stored &&
    typeof stored.sessionId === "string" &&
    Number.isFinite(stored.arrivedAt) &&
    Array.isArray(stored.features)
  ) {
    return stored;
  }
  const created: ActivityState = {
    sessionId: crypto.randomUUID(),
    arrivedAt: now,
    features: [],
  };
  writeJson(window.sessionStorage, SESSION_KEY, created);
  return created;
}

export function markFeedbackFeature(feature: FeedbackFeature, now = Date.now()): ActivityState {
  const activity = getFeedbackActivity(now);
  if (!activity.features.includes(feature)) activity.features.push(feature);
  writeJson(window.sessionStorage, SESSION_KEY, activity);
  return activity;
}

export function readFeedbackDraft(userId: string): FeedbackAnswers | null {
  return readJson<FeedbackAnswers>(window.localStorage, `${DRAFT_PREFIX}${userId}`);
}

export function saveFeedbackDraft(userId: string, draft: FeedbackAnswers): void {
  writeJson(window.localStorage, `${DRAFT_PREFIX}${userId}`, draft);
}

export function clearFeedbackDraft(userId: string): void {
  try {
    window.localStorage.removeItem(`${DRAFT_PREFIX}${userId}`);
  } catch {
    // Best-effort cleanup.
  }
}

export function markFeedbackPrompted(userId: string, now = Date.now()): void {
  try {
    window.localStorage.setItem(`${COOLDOWN_PREFIX}${userId}`, String(now));
  } catch {
    // Best-effort deduplication.
  }
}

export function isFeedbackEligible(input: {
  consented: boolean;
  userId: string | null | undefined;
  now?: number;
  activity?: ActivityState;
  cooldownMs?: number;
  minimumSessionMs?: number;
}): boolean {
  const {
    consented,
    userId,
    now = Date.now(),
    activity = getFeedbackActivity(now),
    cooldownMs = FEEDBACK_COOLDOWN_MS,
    minimumSessionMs = MINIMUM_FEEDBACK_SESSION_MS,
  } = input;
  if (!consented || !userId || userId === "presentation-demo") return false;
  if (activity.features.length === 0 || now - activity.arrivedAt < minimumSessionMs) return false;
  try {
    const lastPrompted = Number(window.localStorage.getItem(`${COOLDOWN_PREFIX}${userId}`));
    if (Number.isFinite(lastPrompted) && lastPrompted > 0 && now - lastPrompted < cooldownMs) {
      return false;
    }
  } catch {
    // Fail open when storage is unavailable; the in-memory open state still
    // prevents duplicate dialogs in this render.
  }
  return true;
}

export function isTouchOrMobileDevice(): boolean {
  if (navigator.maxTouchPoints > 0) return true;
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

export function deviceCategory(): DeviceCategory {
  if (isTouchOrMobileDevice() || window.innerWidth < 768) return "mobile";
  if (window.innerWidth < 1024) return "tablet";
  return "desktop";
}

export function isTopBoundaryExit(event: Pick<MouseEvent, "clientY" | "relatedTarget">): boolean {
  return event.relatedTarget === null && event.clientY <= 0;
}
