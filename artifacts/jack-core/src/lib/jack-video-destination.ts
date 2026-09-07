import { listVideos } from "@workspace/api-client-react";

type Destination =
  | { kind: "video"; id: string }
  | { kind: "missing" }
  | { kind: "unavailable" }
  | { kind: "ambiguous"; titles: string[] };

// Speech recognition may split a recording's title ("3G demo" / "3gdemo").
// Match catalog titles, never hard-coded recording names or model-supplied IDs.
function titleKey(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export async function resolveJackVideoDestination(
  target: string,
  signal: AbortSignal,
): Promise<Destination> {
  const wanted = titleKey(target);
  if (!wanted) return { kind: "missing" };
  const candidates = new Map<string, { id: string; title: string }>();
  // Use the same authenticated catalog as Library. Do not cache across users,
  // use privileged reads, or pick a match from an incomplete bounded scan.
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await listVideos(
      { limit: 100, offset },
      { credentials: "include", signal },
    );
    if (signal.aborted) return { kind: "unavailable" };
    for (const video of page.videos) candidates.set(video.id, video);
    if (offset + page.videos.length >= page.total) {
      const videos = [...candidates.values()];
      const exact = videos.filter((video) => titleKey(video.title) === wanted);
      const matches = exact.length
        ? exact
        : videos.filter((video) => titleKey(video.title).includes(wanted));
      if (matches.length === 1) return { kind: "video", id: matches[0].id };
      if (matches.length > 1)
        return {
          kind: "ambiguous",
          titles: matches.slice(0, 3).map((v) => v.title),
        };
      return { kind: "missing" };
    }
    if (page.videos.length < 100) return { kind: "unavailable" };
  }
  return { kind: "unavailable" };
}
