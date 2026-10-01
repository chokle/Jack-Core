export type Surface = "ask" | "source" | "settings";
export interface SelectedSource {
  id: string;
  title: string;
}

/** Native navigation state only. Never observes any other app or device content. */
export function encodeContext(
  surface: Surface,
  source: SelectedSource | null,
  now = new Date(),
) {
  const title = source?.title.slice(0, 120) ?? null;
  const context = {
    version: 1,
    route: surface === "ask" ? "/app" : `/app/${surface}`,
    surface:
      surface === "ask"
        ? "Ask Jack"
        : surface === "source"
          ? "Source"
          : "Settings",
    path:
      surface === "source" && title
        ? ["Jack", "Source", title]
        : ["Jack", surface === "ask" ? "Ask Jack" : "Settings"],
    inspector: {
      open: surface === "source",
      label: surface === "source" ? title : null,
    },
    visibleIds: source ? [source.id.slice(0, 160)] : [],
    navigation: {
      canBack: surface !== "ask",
      canUp: surface !== "ask",
      canForward: false,
      hasSourceAction: surface === "source",
    },
    capturedAt: now.toISOString(),
  };
  // Bounds apply after URI encoding: non-ASCII titles can expand substantially.
  let encoded = encodeURIComponent(JSON.stringify(context));
  if (encoded.length > 3500) {
    context.path = ["Jack", "Source"];
    context.inspector.label = null;
    encoded = encodeURIComponent(JSON.stringify(context));
  }
  return encoded;
}
