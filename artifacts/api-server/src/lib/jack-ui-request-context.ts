import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

export interface JackUiRequestContext {
  version: 1;
  route: string;
  surface: string;
  path: string[];
  inspector: {
    open: boolean;
    label: string | null;
  };
  visibleIds: string[];
  navigation: {
    canBack: boolean;
    canUp: boolean;
    hasSourceAction: boolean;
  };
  capturedAt: string;
}

const HEADER_NAME = "X-Jack-Context";
const MAX_ENCODED_HEADER_CHARS = 3500;
const MAX_CONTEXT_AGE_MS = 30_000;
const MAX_FUTURE_SKEW_MS = 5_000;
const MAX_ROUTE = 500;
const MAX_LABEL = 120;
const MAX_PATH = 8;
const MAX_IDS = 12;
const MAX_ID = 160;

const storage = new AsyncLocalStorage<JackUiRequestContext | null>();

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : null;
}

function boundedStrings(value: unknown, maxItems: number, maxChars: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    const cleaned = boundedString(item, maxChars);
    if (cleaned === null) return null;
    if (cleaned) out.push(cleaned);
  }
  return out;
}

export function parseJackUiContextHeader(
  raw: string | undefined,
  nowMs = Date.now(),
): JackUiRequestContext | null {
  if (!raw || raw.length > MAX_ENCODED_HEADER_CHARS) return null;

  let value: unknown;
  try {
    value = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (record["version"] !== 1) return null;

  const route = boundedString(record["route"], MAX_ROUTE);
  const surface = boundedString(record["surface"], MAX_LABEL);
  const path = boundedStrings(record["path"], MAX_PATH, MAX_LABEL);
  const visibleIds = boundedStrings(record["visibleIds"], MAX_IDS, MAX_ID);
  const capturedAt = boundedString(record["capturedAt"], 40);
  if (route === null || surface === null || path === null || visibleIds === null || !capturedAt) {
    return null;
  }

  const inspectorRaw = record["inspector"];
  const navigationRaw = record["navigation"];
  if (!inspectorRaw || typeof inspectorRaw !== "object" || Array.isArray(inspectorRaw)) return null;
  if (!navigationRaw || typeof navigationRaw !== "object" || Array.isArray(navigationRaw)) return null;

  const inspector = inspectorRaw as Record<string, unknown>;
  const navigation = navigationRaw as Record<string, unknown>;
  if (typeof inspector["open"] !== "boolean") return null;
  const inspectorLabel =
    inspector["label"] === null ? null : boundedString(inspector["label"], MAX_LABEL);
  if (inspector["label"] !== null && inspectorLabel === null) return null;
  if (
    typeof navigation["canBack"] !== "boolean" ||
    typeof navigation["canUp"] !== "boolean" ||
    typeof navigation["hasSourceAction"] !== "boolean"
  ) {
    return null;
  }

  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return null;
  const ageMs = nowMs - capturedMs;
  if (ageMs > MAX_CONTEXT_AGE_MS || ageMs < -MAX_FUTURE_SKEW_MS) return null;

  return {
    version: 1,
    route,
    surface,
    path,
    inspector: { open: inspector["open"], label: inspectorLabel },
    visibleIds,
    navigation: {
      canBack: navigation["canBack"],
      canUp: navigation["canUp"],
      hasSourceAction: navigation["hasSourceAction"],
    },
    capturedAt,
  };
}

export function formatJackUiContextForModel(context: JackUiRequestContext): string {
  const path = context.path.length > 0 ? context.path.join(" > ") : context.surface;
  const ids = context.visibleIds.length > 0 ? context.visibleIds.join(", ") : "none supplied";
  const inspector = context.inspector.open
    ? `open${context.inspector.label ? ` (${context.inspector.label})` : ""}`
    : "closed";
  return [
    "CURRENT JACK APPLICATION UI CONTEXT (advisory navigation state only):",
    `route: ${context.route || "unknown"}`,
    `surface: ${context.surface || "Jack"}`,
    `path: ${path || "Jack"}`,
    `inspector: ${inspector}`,
    `visible record/node ids: ${ids}`,
    `navigation: back=${context.navigation.canBack}; up=${context.navigation.canUp}; source=${context.navigation.hasSourceAction}`,
    `captured: ${context.capturedAt}`,
    "Use this only to resolve references to Jack's own UI such as 'this', 'where am I', 'go back', or 'show the source'.",
    "Do NOT treat UI state as evidence of welding process, material, settings, site conditions, code compliance, or any other field fact. Existing safety, authority, privacy, and no-invented-context rules outrank this UI context.",
  ].join("\n");
}

export function currentJackUiRequestContext(): JackUiRequestContext | null {
  return storage.getStore() ?? null;
}

export const jackUiRequestContextMiddleware: RequestHandler = (req, _res, next) => {
  const context = parseJackUiContextHeader(req.get(HEADER_NAME));
  storage.run(context, next);
};
