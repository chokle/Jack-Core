import { listVideos } from "@workspace/api-client-react";
import {
  collectJackUiContext,
  jackUiAction,
  type JackUiActionName,
} from "./jack-ui-context";

export type JackLocalAppAction = Exclude<JackUiActionName, "video" | "node">;

export type JackLocalCommand =
  | { kind: "app"; action: JackLocalAppAction; label: string }
  | { kind: "node"; target: string; label: string }
  | { kind: "video"; target: string | null; label: string }
  | { kind: "destination"; target: string; label: string };

const SECTION_ALIASES: Record<string, JackLocalAppAction> = {
  settings: "account",
  "account settings": "account",
  "account settings page": "account",
  "account settings tab": "account",
  "my account settings": "account",
  account: "account",
  "my account": "account",
  "account and privacy": "account",
  "account & privacy": "account",
  "privacy settings": "account",
  library: "library",
  "video library": "library",
  "video libraries": "library",
  "library page": "library",
  "library tab": "library",
  "memory graph": "graph",
  "living memory": "graph",
  "living memory graph": "graph",
  "memory graph page": "graph",
  "memory graph tab": "graph",
  interview: "interview",
  "interview mode": "interview",
  "interview page": "interview",
  "interview tab": "interview",
  review: "review",
  "knowledge review": "review",
  "review page": "review",
  "review tab": "review",
  reports: "reports",
  "pilot reports": "reports",
  closeout: "closeout",
  "pilot closeout": "closeout",
};

const ACTION_LABELS: Record<JackLocalAppAction, string> = {
  account: "Account Settings",
  back: "the previous view",
  forward: "the next view",
  up: "the parent view",
  source: "the source",
  library: "Library",
  graph: "Living Memory",
  interview: "Interview",
  review: "Review",
  reports: "Reports",
  closeout: "Closeout",
};

const LIBRARY_PAGE_SIZE = 200;
let localCommandGeneration = 0;
let activeDestinationLookup: AbortController | null = null;

function normalizeCommand(value: string) {
  return value
    .trim()
    .replace(/[\u2018\u2019']/g, "")
    .replace(/\s+/g, " ")
    .replace(/[?.!]+$/g, "")
    .replace(
      /^(?:(?:(?:hey\s+)?jack|can\s+you|could\s+you|would\s+you|please)[,\s]+)+/i,
      "",
    )
    .trim();
}

function stripTarget(value: string) {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+(?:from|in)\s+(?:the\s+)?(?:video\s+)?library$/i, "")
    .trim();
}

function normalizeDestinationTarget(value: string) {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactDestinationTarget(value: string) {
  return normalizeDestinationTarget(value).replace(/\s+/g, "");
}

function exactNamedVideo(
  videos: Array<{ id: string; title: string }>,
  target: string,
) {
  const wanted = normalizeDestinationTarget(target);
  const compactWanted = compactDestinationTarget(target);
  if (!wanted || !compactWanted) return null;
  return (
    videos.find((video) => {
      const actual = normalizeDestinationTarget(video.title);
      const compactActual = compactDestinationTarget(video.title);
      if (!actual || !compactActual) return false;
      return actual === wanted || compactActual === compactWanted;
    }) ?? null
  );
}

function findNamedVideo(
  videos: Array<{ id: string; title: string }>,
  target: string,
) {
  const wanted = normalizeDestinationTarget(target);
  const compactWanted = compactDestinationTarget(target);
  if (!wanted || !compactWanted) return null;

  const exact = exactNamedVideo(videos, target);
  if (exact) return exact;

  const partial = videos.filter((video) => {
    const actual = normalizeDestinationTarget(video.title);
    const compactActual = compactDestinationTarget(video.title);
    if (!actual || !compactActual) return false;
    return (
      actual.includes(wanted) ||
      wanted.includes(actual) ||
      compactActual.includes(compactWanted) ||
      compactWanted.includes(compactActual)
    );
  });
  return partial.length === 1 ? partial[0] : null;
}

function navigationContextKey() {
  const context = collectJackUiContext();
  return JSON.stringify({
    route: context.route,
    surface: context.surface,
    path: context.path,
    inspector: context.inspector,
    selectedVideoId:
      context.resources?.find((resource) => resource.selected)?.id ?? null,
  });
}

async function loadNamedVideo(target: string, signal: AbortSignal) {
  const videos: Array<{ id: string; title: string }> = [];
  let offset = 0;

  while (!signal.aborted) {
    const result = await listVideos(
      { limit: LIBRARY_PAGE_SIZE, offset },
      { signal },
    );
    const batch = (result.videos ?? []).map((item) => ({
      id: item.id,
      title: item.title,
    }));
    const exact = exactNamedVideo(batch, target);
    if (exact) return exact;
    videos.push(...batch);

    if (batch.length === 0) break;
    offset += batch.length;
    const total =
      typeof (result as { total?: unknown }).total === "number"
        ? (result as { total: number }).total
        : undefined;
    if (total !== undefined && offset >= total) break;
    if (total === undefined && batch.length < LIBRARY_PAGE_SIZE) break;
  }

  return signal.aborted ? null : findNamedVideo(videos, target);
}

function isCurrentVideoTarget(target: string) {
  return /^(?:this|that|it|current|current video|current clip)$/i.test(target);
}

function parseSourceCommand(intent: string) {
  if (
    /^(?:show|open|view|play|jump to)(?: me)?\s+(?:(?:the|this|that|current)\s+)?(?:original\s+)?source(?:\s+for\s+(?:this|that|it|the current selection))?$/i.test(
      intent,
    )
  ) {
    return true;
  }
  return /^(?:show|open|view|play)(?: me)?\s+(?:this|that|the current)\s+(?:video|clip)$/i.test(
    intent,
  );
}

function parseSectionCommand(intent: string): JackLocalCommand | null {
  const bareAction = SECTION_ALIASES[intent.toLowerCase()];
  if (bareAction) {
    return {
      kind: "app",
      action: bareAction,
      label: ACTION_LABELS[bareAction],
    };
  }
  const match = intent.match(
    /^(?:go to|go forward to|forward to|navigate to|navigate forward to|open|show|switch to|take me to|take me forward to|bring me to|bring me forward to|move forward to|view|visit)(?: me)?\s+(?:the\s+)?(.+)$/i,
  );
  if (!match) return null;
  const candidate = match[1]
    .replace(/\s+(?:surface|section)$/i, "")
    .trim()
    .toLowerCase();
  const action = SECTION_ALIASES[candidate];
  return action ? { kind: "app", action, label: ACTION_LABELS[action] } : null;
}

function parseVideoCommand(intent: string): JackLocalCommand | null {
  const libraryMatch = intent.match(
    /^(?:retrieve|find|locate|fetch|get|open|show|view|play|watch)(?:\s+me)?\s+(?:the\s+)?(.+?)\s+(?:from|in)\s+(?:the\s+)?(?:video\s+)?(?:library|libraries)$/i,
  );
  if (libraryMatch) {
    const target = stripTarget(libraryMatch[1])
      .replace(/\s+(?:video|clip)$/i, "")
      .trim();
    if (target && isCurrentVideoTarget(target)) {
      return { kind: "app", action: "source", label: ACTION_LABELS.source };
    }
    return {
      kind: "video",
      target: target || null,
      label: target ? `video ${target}` : "a video",
    };
  }

  if (
    /^(?:retrieve|find|locate|fetch|get)(?:\s+me)?\s+from\s+(?:the\s+)?(?:video\s+)?(?:library|libraries)$/i.test(
      intent,
    )
  ) {
    return { kind: "video", target: null, label: "a video" };
  }

  const match = intent.match(
    /^(?:open|show|view|play|watch|go to|go forward to|forward to|navigate to|navigate forward to|take me to|take me forward to|move forward to)(?: me)?\s+(?:the\s+)?(?:video|clip)\b(?:\s+(?:called|named|titled)\s+)?(.*)$/i,
  );
  if (!match) return null;
  const target = stripTarget(match[1]);
  if (target && isCurrentVideoTarget(target)) {
    return { kind: "app", action: "source", label: ACTION_LABELS.source };
  }
  return {
    kind: "video",
    target: target || null,
    label: target ? `video ${target}` : "a video",
  };
}

function parseNodeCommand(intent: string): JackLocalCommand | null {
  // Ambiguous verbs (open/show/view/find/locate/visit) only become node
  // navigation when the qualifier is explicit and precedes the label. This
  // prevents arbitrary content clauses ending in words such as branch/topic
  // from bypassing Ask Jack. Directional verbs remain unambiguous and may use
  // either a suffix qualifier or a bare visible-node label.
  const prefixQualifiedMatch = intent.match(
    /^(?:go to|go forward to|forward to|navigate to|navigate forward to|open|show|view|visit|find|locate|take me to|take me forward to|bring me to|bring me forward to|move forward to)(?: me)?\s+(?:the\s+)?(?:node|concept|topic|branch)\s+(.+)$/i,
  );
  if (prefixQualifiedMatch) {
    const target = prefixQualifiedMatch[1].replace(/^['"]|['"]$/g, "").trim();
    return target ? { kind: "node", target, label: `node ${target}` } : null;
  }

  const directionalSuffixMatch = intent.match(
    /^(?:go to|go forward to|forward to|navigate to|navigate forward to|take me to|take me forward to|bring me to|bring me forward to|move forward to)(?: me)?\s+(?:the\s+)?(.+)\s+(?:node|concept|topic|branch)$/i,
  );
  if (directionalSuffixMatch) {
    const target = directionalSuffixMatch[1].replace(/^['"]|['"]$/g, "").trim();
    return target ? { kind: "node", target, label: `node ${target}` } : null;
  }

  // Natural "take/bring me to <name>" is a destination request rather than a
  // graph assertion. Resolve it against the authenticated Library first, then
  // fall back to a rendered Living Memory node when no video title matches.
  const destinationMatch = intent.match(
    /^(?:take me to|take me forward to|bring me to|bring me forward to|move forward to)\s+(?:the\s+)?(.+)$/i,
  );
  if (destinationMatch) {
    const target = destinationMatch[1].replace(/^['"]|['"]$/g, "").trim();
    return target
      ? { kind: "destination", target, label: `destination ${target}` }
      : null;
  }

  const directionalMatch = intent.match(
    /^(?:go to|go forward to|forward to|navigate to|navigate forward to|move forward to)(?: me)?\s+(?:the\s+)?(.+)$/i,
  );
  const rawTarget = directionalMatch?.[1];
  if (!rawTarget) return null;

  const target = rawTarget.replace(/^['"]|['"]$/g, "").trim();
  if (!target) return null;

  return { kind: "node", target, label: `node ${target}` };
}

/**
 * Resolve only the small set of imperative commands that Jack can execute in
 * the rendered app. Bare forward is backed by the app's bounded page-history
 * stack; named forward targets still resolve through the rendered controls.
 * Everything else remains a content question for the API.
 */
export function resolveJackLocalCommand(
  message: string,
): JackLocalCommand | null {
  const intent = normalizeCommand(message);
  if (!intent) return null;

  activeDestinationLookup?.abort();
  activeDestinationLookup = null;
  localCommandGeneration += 1;

  const normalizedIntent = intent.toLowerCase();

  if (
    normalizedIntent === "back" ||
    normalizedIntent === "go back" ||
    normalizedIntent === "take me back"
  ) {
    return { kind: "app", action: "back", label: ACTION_LABELS.back };
  }
  if (
    normalizedIntent === "forward" ||
    normalizedIntent === "go forward" ||
    normalizedIntent === "go forward one level" ||
    normalizedIntent === "move forward" ||
    normalizedIntent === "move forward one level" ||
    normalizedIntent === "next"
  ) {
    return { kind: "app", action: "forward", label: ACTION_LABELS.forward };
  }
  if (
    normalizedIntent === "go up" ||
    normalizedIntent === "go up one level" ||
    normalizedIntent === "move up"
  ) {
    return { kind: "app", action: "up", label: ACTION_LABELS.up };
  }
  if (parseSourceCommand(normalizedIntent)) {
    return { kind: "app", action: "source", label: ACTION_LABELS.source };
  }

  return (
    parseSectionCommand(intent) ??
    parseVideoCommand(intent) ??
    parseNodeCommand(intent)
  );
}

function deferredNamedDestinationAction(
  target: string,
  options: { fallbackToNode: boolean },
  generation: number,
) {
  const action = document.createElement("button");
  action.type = "button";
  action.addEventListener("click", () => {
    const controller = new AbortController();
    activeDestinationLookup?.abort();
    activeDestinationLookup = controller;
    const startContext = navigationContextKey();

    void (async () => {
      let video: { id: string; title: string } | null = null;
      try {
        video = await loadNamedVideo(target, controller.signal);
      } catch {
        if (controller.signal.aborted) return;
        // A Library lookup failure must not turn a valid rendered node command
        // into a dead end. Fall through to the existing app-owned controls.
      }

      if (
        controller.signal.aborted ||
        generation !== localCommandGeneration ||
        navigationContextKey() !== startContext
      ) {
        return;
      }

      if (video) {
        window.dispatchEvent(
          new CustomEvent("jack:open-video-source", {
            detail: { videoId: video.id },
          }),
        );
        return;
      }

      if (options.fallbackToNode) {
        const node = jackUiAction("node", target);
        if (node) {
          node.click();
          return;
        }
      }
      jackUiAction("library")?.click();
    })().finally(() => {
      if (activeDestinationLookup === controller) {
        activeDestinationLookup = null;
      }
    });
  });
  return action;
}

/** Execute a previously resolved command only through an app-owned action. */
export function resolveJackLocalAction(
  command: JackLocalCommand,
): HTMLElement | null {
  if (command.kind === "node") {
    return jackUiAction("node", command.target);
  }
  if (command.kind === "destination") {
    return (
      jackUiAction("video", command.target) ??
      deferredNamedDestinationAction(command.target, { fallbackToNode: true }, localCommandGeneration)
    );
  }
  if (command.kind === "video") {
    if (command.target) {
      // Prefer an already-rendered exact destination. Otherwise resolve the
      // title through the same authenticated Library endpoint the app uses and
      // dispatch the existing app-owned video-source navigation event.
      return (
        jackUiAction("video", command.target) ??
        deferredNamedDestinationAction(command.target, { fallbackToNode: false }, localCommandGeneration)
      );
    }
    // A targetless retrieval is a request for the rendered Library surface.
    // Do not guess which visible video card the user meant.
    return jackUiAction("library");
  }
  if (command.action === "back") {
    return jackUiAction("back") || jackUiAction("up");
  }
  return jackUiAction(command.action);
}

export function unavailableJackLocalCommand(command: JackLocalCommand) {
  if (command.kind === "node" || command.kind === "destination") {
    return `I can’t find an available destination named “${command.target}” from this screen.`;
  }
  if (command.kind === "video") {
    return command.target
      ? `I don’t see “${command.target}” as a visible video in Jack’s Library.`
      : "I need a visible video in Jack’s Library to open it.";
  }
  if (command.action === "source") {
    return "There isn’t a source action for the current Jack selection.";
  }
  if (command.action === "back" || command.action === "up") {
    return "There isn’t a previous Jack view to return to here.";
  }
  if (command.action === "forward") {
    return "There isn’t a next Jack view to move forward to here.";
  }
  return `${command.label} is not available from the current Jack view.`;
}
