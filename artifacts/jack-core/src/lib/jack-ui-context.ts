export interface JackUiContext {
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

const MAX_LABEL = 120;
const MAX_PATH_ITEMS = 8;
const MAX_VISIBLE_IDS = 12;
const MAX_HEADER_CHARS = 3500;

function cleanText(value: string | null | undefined, max = MAX_LABEL) {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function firstVisible(selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const visible = nodes.find((node) => {
      const style = window.getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    if (visible) return visible;
  }
  return null;
}

function activeSurface() {
  const active = firstVisible([
    "aside [aria-current='page']",
    "[role='navigation'] [aria-current='page']",
    "nav:not([aria-label='breadcrumb']) [aria-current='page']",
  ]);
  return cleanText(active?.innerText) || cleanText(document.title) || "Jack";
}

function breadcrumbPath() {
  const breadcrumb = document.querySelector<HTMLElement>("nav[aria-label='breadcrumb']");
  if (!breadcrumb) return [] as string[];
  const items = Array.from(
    breadcrumb.querySelectorAll<HTMLElement>(
      "a, [aria-current='page'], [role='link']:not([aria-hidden='true'])",
    ),
  )
    .map((node) => cleanText(node.innerText))
    .filter(Boolean);
  return Array.from(new Set(items)).slice(0, MAX_PATH_ITEMS);
}

function visibleRecordIds() {
  const values = new Set<string>();
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-node-id], [data-entry-id], [data-video-id], [data-record-id], [data-id]",
    ),
  );
  for (const node of nodes) {
    for (const key of ["nodeId", "entryId", "videoId", "recordId", "id"] as const) {
      const value = cleanText(node.dataset[key], 160);
      if (value) values.add(value);
      if (values.size >= MAX_VISIBLE_IDS) return Array.from(values);
    }
  }
  return Array.from(values);
}

function inspectorState() {
  const inspector = firstVisible([
    "[data-jack-inspector]",
    "[aria-label*='inspector' i]",
    "[role='dialog']",
  ]);
  if (!inspector) return { open: false, label: null };
  const heading = inspector.querySelector<HTMLElement>("h1, h2, h3, [role='heading']");
  return {
    open: true,
    label: cleanText(heading?.innerText || inspector.getAttribute("aria-label")) || null,
  };
}

function hasSourceAction() {
  const actions = Array.from(
    document.querySelectorAll<HTMLElement>("a, button, [role='button']"),
  );
  return actions.some((node) => /\b(source|citation|evidence)\b/i.test(cleanText(node.innerText, 80)));
}

export function collectJackUiContext(): JackUiContext {
  const path = breadcrumbPath();
  const surface = activeSurface();
  if (path.length === 0 && surface) path.push(surface);
  return {
    version: 1,
    route: `${window.location.pathname}${window.location.search}${window.location.hash}`.slice(0, 500),
    surface,
    path,
    inspector: inspectorState(),
    visibleIds: visibleRecordIds(),
    navigation: {
      canBack: window.history.length > 1,
      canUp: path.length > 1,
      hasSourceAction: hasSourceAction(),
    },
    capturedAt: new Date().toISOString(),
  };
}

export function jackUiContextLabel(context: JackUiContext) {
  return context.path.length > 0 ? context.path.join(" › ") : context.surface;
}

export function encodeJackUiContextHeader(context: JackUiContext) {
  const encoded = encodeURIComponent(JSON.stringify(context));
  return encoded.length <= MAX_HEADER_CHARS
    ? encoded
    : encodeURIComponent(
        JSON.stringify({
          ...context,
          visibleIds: context.visibleIds.slice(0, 4),
          path: context.path.slice(0, 5),
          inspector: context.inspector.open
            ? { open: true, label: context.inspector.label?.slice(0, 60) ?? null }
            : context.inspector,
        }),
      ).slice(0, MAX_HEADER_CHARS);
}
