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
    canForward: boolean;
    hasSourceAction: boolean;
  };
  capturedAt: string;
}

/**
 * Names of actions that the application owns. Jack may identify these controls
 * from the rendered page, but model prose never gets to select an arbitrary DOM
 * element. The action names are intentionally small and allowlisted.
 */
export type JackUiActionName =
  | "back"
  | "forward"
  | "up"
  | "source"
  | "node"
  | "library"
  | "graph"
  | "interview"
  | "review"
  | "reports"
  | "closeout"
  | "video";

const MAX_LABEL = 120;
const MAX_PATH_ITEMS = 8;
const MAX_VISIBLE_IDS = 12;
const MAX_HEADER_CHARS = 3500;

function cleanText(value: string | null | undefined, max = MAX_LABEL) {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function elementText(node: HTMLElement | null | undefined, max = MAX_LABEL) {
  return cleanText(node?.innerText || node?.textContent, max);
}

function isElementVisible(
  node: HTMLElement | null | undefined,
  options: { allowTransparent?: boolean } = {},
) {
  if (node?.closest("[data-floating-jack]")) return false;
  let current = node ?? null;
  while (current) {
    if (
      current.hidden ||
      current.getAttribute("aria-hidden") === "true" ||
      current.hasAttribute("inert")
    ) {
      return false;
    }
    const style = window.getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      (style.opacity === "0" && !options.allowTransparent)
    ) {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}

function firstVisible(
  selectors: string[],
  options: { allowTransparent?: boolean } = {},
): HTMLElement | null {
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const visible = nodes.find((node) => isElementVisible(node, options));
    if (visible) return visible;
  }
  return null;
}

function activeSurface() {
  const surface = Array.from(
    document.querySelectorAll<HTMLElement>("[data-jack-surface]"),
  )
    .filter((node) => isElementVisible(node, { allowTransparent: true }))
    .at(-1);
  if (surface) return cleanText(surface.dataset.jackSurface);
  const active = firstVisible([
    "aside [aria-current='page']",
    "[role='navigation'] [aria-current='page']",
    "nav:not([aria-label='breadcrumb']) [aria-current='page']",
  ]);
  return elementText(active) || cleanText(document.title) || "Jack";
}

function breadcrumbPath() {
  const state = firstVisible(["[data-jack-path]"], {
    allowTransparent: true,
  });
  if (state) {
    try {
      const path: unknown = JSON.parse(state.dataset.jackPath ?? "[]");
      if (Array.isArray(path)) {
        return path
          .filter((item): item is string => typeof item === "string")
          .map((item) => cleanText(item))
          .filter(Boolean)
          .slice(-MAX_PATH_ITEMS);
      }
    } catch {
      /* Fall back to the visible breadcrumb. */
    }
  }
  const breadcrumb = document.querySelector<HTMLElement>(
    "nav[aria-label='breadcrumb']",
  );
  if (!breadcrumb || !isElementVisible(breadcrumb)) return [] as string[];
  const items = Array.from(
    breadcrumb.querySelectorAll<HTMLElement>(
      "a, button, [aria-current='page'], [role='link']:not([aria-hidden='true'])",
    ),
  )
    .filter((node) => isElementVisible(node))
    .map((node) => elementText(node))
    .filter(Boolean);
  return Array.from(new Set(items)).slice(0, MAX_PATH_ITEMS);
}

function visibleRecordIds() {
  const values = new Set<string>();
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-node-id], [data-branch-id], [data-topic-id], [data-graph-id], [data-entry-id], [data-video-id], [data-record-id], [data-id]",
    ),
  );
  for (const node of nodes) {
    if (
      !isElementVisible(node, {
        allowTransparent: Boolean(node.dataset.videoId),
      })
    )
      continue;
    if (node.closest("[data-jack-command-index]")) continue;
    for (const key of [
      "nodeId",
      "branchId",
      "topicId",
      "graphId",
      "entryId",
      "videoId",
      "recordId",
      "id",
    ] as const) {
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
  const heading = inspector.querySelector<HTMLElement>(
    "h1, h2, h3, [role='heading']",
  );
  return {
    open: true,
    label:
      cleanText(inspector.dataset.jackLabel) ||
      elementText(heading) ||
      cleanText(inspector.getAttribute("aria-label")) ||
      null,
  };
}

function normalizeActionTarget(value: string) {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function actionTargetValues(node: HTMLElement) {
  return [
    node.dataset.videoTitle,
    node.dataset.nodeLabel,
    node.dataset.jackLabel,
    node.getAttribute("aria-label"),
    elementText(node),
  ].filter((value): value is string => Boolean(value));
}

/**
 * Find a visible application-owned action. A target is used only for explicitly
 * named video or graph-node actions; exact labels win over partial matches.
 */
export function jackUiAction(
  action: JackUiActionName,
  target?: string,
): HTMLElement | null {
  // Only application-owned controls may execute navigation. Never infer an
  // action from model output or click an arbitrary matching piece of text.
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(`[data-jack-action='${action}']`),
  )
    .filter(
      (node) =>
        isElementVisible(node) &&
        !node.matches(':disabled, [aria-disabled="true"]'),
    )
    .sort(
      (a, b) =>
        Number(Boolean(b.closest("[data-jack-inspector]"))) -
        Number(Boolean(a.closest("[data-jack-inspector]"))),
    );

  if (!target || (action !== "video" && action !== "node")) {
    return nodes[0] ?? null;
  }

  const wanted = normalizeActionTarget(target);
  if (!wanted) return null;
  const exact = nodes.find((node) =>
    actionTargetValues(node).some(
      (value) => normalizeActionTarget(value) === wanted,
    ),
  );
  if (exact) return exact;
  return (
    nodes.find((node) => {
      return actionTargetValues(node).some((value) => {
        const actual = normalizeActionTarget(value);
        return actual.includes(wanted) || wanted.includes(actual);
      });
    }) ?? null
  );
}

function hasSourceAction() {
  return Boolean(jackUiAction("source"));
}

export function collectJackUiContext(): JackUiContext {
  const path = breadcrumbPath();
  const surface = activeSurface();
  if (path.length === 0 && surface) path.push(surface);
  return {
    version: 1,
    route: window.location.pathname.slice(0, 500),
    surface,
    path,
    inspector: inspectorState(),
    visibleIds: visibleRecordIds(),
    navigation: {
      canBack: Boolean(jackUiAction("back") || jackUiAction("up")),
      canUp: Boolean(jackUiAction("up")),
      canForward: Boolean(jackUiAction("forward")),
      hasSourceAction: hasSourceAction(),
    },
    capturedAt: new Date().toISOString(),
  };
}

export function jackUiContextLabel(context: JackUiContext) {
  return context.path.length > 0 ? context.path.join(" › ") : context.surface;
}

export function encodeJackUiContextHeader(context: JackUiContext) {
  let candidate: JackUiContext = context;
  let encoded = encodeURIComponent(JSON.stringify(candidate));
  if (encoded.length <= MAX_HEADER_CHARS) return encoded;

  candidate = {
    ...context,
    route: context.route.slice(0, 180),
    surface: context.surface.slice(0, 80),
    path: context.path.slice(0, 4).map((item) => item.slice(0, 60)),
    inspector: {
      open: context.inspector.open,
      label: context.inspector.label?.slice(0, 60) ?? null,
    },
    visibleIds: context.visibleIds.slice(0, 3).map((id) => id.slice(0, 80)),
  };
  encoded = encodeURIComponent(JSON.stringify(candidate));
  if (encoded.length <= MAX_HEADER_CHARS) return encoded;

  candidate = {
    ...candidate,
    route: candidate.route.slice(0, 100),
    path: candidate.path.slice(0, 2).map((item) => item.slice(0, 40)),
    inspector: { open: candidate.inspector.open, label: null },
    visibleIds: [],
  };
  encoded = encodeURIComponent(JSON.stringify(candidate));
  if (encoded.length <= MAX_HEADER_CHARS) return encoded;

  return encodeURIComponent(
    JSON.stringify({
      version: 1,
      route: "",
      surface: "Jack",
      path: ["Jack"],
      inspector: { open: false, label: null },
      visibleIds: [],
      navigation: candidate.navigation,
      capturedAt: candidate.capturedAt,
    } satisfies JackUiContext),
  );
}
