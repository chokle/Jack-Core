import { supabase } from "./supabase.js";
import { readableVideos } from "./library-read-policy.js";
import { currentJackUiRequestContext } from "./jack-ui-request-context.js";
import {
  fetchVerificationCoverage,
  rerankByVerification,
} from "./verification-rerank.js";

const columns =
  "id,title,trade,status,analysis,transcript,key_points,description,thumbnail_url";
const normalized = (value: string) =>
  value
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
function titleScore(wanted: string, title: string) {
  if (!wanted || !title) return 0;
  if (wanted === title) return 1;
  if (wanted.includes(title) || title.includes(wanted)) return 0.92;
  const words = new Set(wanted.split(" "));
  const other = new Set(title.split(" "));
  if (words.size >= 2 && [...words].every((word) => other.has(word)))
    return 0.88;
  return (
    [...words].filter((word) => other.has(word)).length /
    Math.max(words.size, other.size)
  );
}

/** Resolve UI IDs as data, never as authority or arbitrary table identifiers. */
export async function loadLibraryContext(
  message: string,
  userId: string,
  referencedTitles: string[] = [],
) {
  const empty = {
    videos: [] as Record<string, unknown>[],
    failure: null as string | null,
  };
  if (!userId?.trim())
    return { ...empty, failure: "Sign in to access Library content." };
  const context = currentJackUiRequestContext();
  const resources =
    context && ["Library", "Video"].includes(context.surface)
      ? (context.resources ?? [])
      : [];
  const selected = resources.find((item) => item.selected);
  const naturalTitle = message.match(
    /^(?:please\s+)?(?:describe|explain|summari[sz]e|tell me about)\s+(?:the\s+)?(.+?)[?.!]*$/i,
  )?.[1];
  const named = [
    ...referencedTitles,
    ...(naturalTitle &&
    !/^(?:(?:this|that)(?: video| clip)?|it)$/i.test(naturalTitle)
      ? [naturalTitle]
      : []),
  ];
  const intent =
    /\b(video|videos|clip|clips|library|transcript|footage|analysis|key points)\b/i.test(
      message,
    ) ||
    /\b\d{1,3}:\d{2}\b/.test(message) ||
    /^(?:please\s+)?(?:what(?:'s| is)|describe|explain|summari[sz]e|tell me about)\s+(?:this|that|it)[?.!\s]*$/i.test(
      message.trim(),
    );
  if (!intent && !named.length) return empty;
  if (!resources.length && !named.length) return empty;

  let data: Record<string, any>[] = [];
  if (named.length) {
    // Search authoritative titles, including records outside the visible page.
    const titles: Array<{ id: string; title: string }> = [];
    for (let offset = 0; offset < 20000; offset += 1000) {
      const page = await readableVideos(userId)
        .select("id,title")
        .order("id", { ascending: true })
        .range(offset, offset + 999);
      if (page.error)
        return {
          ...empty,
          failure:
            "I couldn't retrieve the Library material. Please try again.",
        };
      titles.push(...(page.data ?? []));
      if ((page.data?.length ?? 0) < 1000) break;
      if (offset === 19000)
        return {
          ...empty,
          failure:
            "This Library is too large for a title lookup right now. Open the video and ask me about it there.",
        };
    }
    for (const wanted of named) {
      const matches = titles
        .map((video) => ({
          video,
          score: titleScore(
            normalized(wanted),
            normalized(String(video.title)),
          ),
        }))
        .filter((item) => item.score >= 0.74)
        .sort((a, b) => b.score - a.score);
      if (matches.length > 1 && matches[0].score === matches[1].score)
        return {
          ...empty,
          failure: `Which Library entry do you mean: ${matches.map((item) => item.video.title).join("; ")}?`,
        };
      if (matches[0] && !data.some((video) => video.id === matches[0].video.id))
        data.push(matches[0].video);
      if (data.length === 2) break;
    }
  }
  if (!data.length) {
    if (
      /\bvideo\s+(?:called|named|titled)\b|\bbased on\s+(?:the\s+)?video\s+/i.test(
        message,
      )
    )
      return {
        ...empty,
        failure:
          "I couldn't find that named video in the Library available to your account.",
      };
    // Quoted technical terms may not be titles; retain a real selected referent.
    if (!resources.length) return empty;
    if (!intent) return empty;
    const targets = selected ? [selected] : resources;
    const result = await readableVideos(userId)
      .select("id,title")
      .in(
        "id",
        targets.map((item) => item.id),
      )
      .limit(3);
    if (result.error)
      return {
        ...empty,
        failure:
          "I couldn't retrieve the Library material for this view. Please try again.",
      };
    data = result.data ?? [];
    if (!selected && data.length > 1)
      return {
        ...empty,
        failure: `I can see these Library entries: ${data.map((video) => video.title).join("; ")}. Which one do you mean?`,
      };
  }
  if (data.length) {
    const selectedRows = await readableVideos(userId)
      .select(columns)
      .in(
        "id",
        data.map((video) => video.id),
      )
      .limit(3);
    if (selectedRows.error)
      return {
        ...empty,
        failure:
          "I couldn't retrieve the saved Library material. Please try again.",
      };
    data = selectedRows.data ?? [];
  }
  const videos: Record<string, unknown>[] = [];
  let coverage: Awaited<ReturnType<typeof fetchVerificationCoverage>>;
  try {
    coverage = await fetchVerificationCoverage(
      data.map((video) => video.id),
      { failClosed: true },
    );
  } catch {
    return {
      ...empty,
      failure:
        "I found the Library entry, but couldn't check its reviewed evidence. Please try again.",
    };
  }
  for (const video of data) {
    // Page across the recording so later evidence is not silently excluded by
    // the database's default row limit. Bound retrieval and expose truncation.
    const segments: Record<string, any>[] = [];
    let segmentError: unknown = null;
    for (let offset = 0; offset < 20000; offset += 1000) {
      const page = await supabase
        .from("transcript_segments")
        .select("id,video_id,start_time,end_time,text")
        .eq("video_id", video.id)
        .order("start_time", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + 999);
      if (page.error) {
        segmentError = page.error;
        break;
      }
      segments.push(...(page.data ?? []));
      if ((page.data?.length ?? 0) < 1000) break;
      if (offset === 19000)
        segmentError = new Error("Transcript exceeds retrieval limit");
    }
    const words = [
      ...new Set(message.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []),
    ].filter(
      (word) =>
        !/^(the|this|that|what|does|video|clip|showing|show|with|from|have|about|describe|explain|summarize|summarise|please|tell)$/.test(
          word,
        ) && !normalized(String(video.title)).split(" ").includes(word),
    );
    const timestamp = message.match(/\b(\d{1,3}):([0-5]\d)\b/);
    const requestedTime = timestamp
      ? Number(timestamp[1]) * 60 + Number(timestamp[2])
      : null;
    const scored = segments
      .filter(
        (segment) =>
          typeof segment.text === "string" &&
          segment.text.trim() &&
          Number.isFinite(Number(segment.start_time)) &&
          Number.isFinite(Number(segment.end_time)) &&
          Number(segment.start_time) >= 0 &&
          Number(segment.end_time) >= Number(segment.start_time),
      )
      .map((segment) => ({
        segment,
        score:
          requestedTime !== null
            ? 1 /
              (1 +
                Math.max(
                  Number(segment.start_time) - requestedTime,
                  requestedTime - Number(segment.end_time),
                  0,
                ))
            : words.reduce(
                (score, word) =>
                  score +
                  Number(String(segment.text).toLowerCase().includes(word)),
                0,
              ),
      }));
    const trusted = rerankByVerification(
      scored,
      ({ segment, score }) => ({
        videoId: video.id,
        startTime: Number(segment.start_time),
        endTime: Number(segment.end_time),
        score:
          requestedTime !== null
            ? score
            : words.length
              ? score / words.length
              : 0,
      }),
      coverage,
    );
    // Overview samples span beginning, middle and end; specific questions rank
    // relevant passages from every page before taking the bounded answer set.
    const chronological = [...trusted].sort(
      (a, b) =>
        Number(a.item.segment.start_time) - Number(b.item.segment.start_time),
    );
    const chosen =
      (requestedTime !== null || words.length) &&
      scored.some((item) => item.score > 0)
        ? trusted.slice(0, 6)
        : chronological.length <= 6
          ? chronological
          : Array.from(
              { length: 6 },
              (_, index) =>
                chronological[
                  Math.round((index * (chronological.length - 1)) / 5)
                ],
            );
    const ranked = chosen.map(({ item, verification, sourceCount }) => ({
      ...item.segment,
      verification,
      source_count: sourceCount,
    }));
    // Whole-video summaries have no time provenance: after a rejection they
    // cannot safely serve as fallback for the suppressed transcript windows.
    const safeVideo = coverage.some(
      (item) => item.videoId === video.id && item.status === "rejected",
    )
      ? {
          ...video,
          transcript: null,
          analysis: null,
          key_points: [],
          description: null,
        }
      : video;
    const hasContent =
      ranked.length > 0 ||
      Boolean(
        safeVideo.analysis ||
        safeVideo.transcript ||
        safeVideo.key_points?.length,
      );
    if (!hasContent && data.length === 1)
      return {
        videos: [],
        failure: `I found ${video.title} in the Library, but ${segmentError ? "I couldn't retrieve its saved transcript" : video.status && video.status !== "completed" ? `processing is ${video.status}; its saved content isn't available yet` : "its saved video content isn't available yet"}.`,
      };
    if (hasContent)
      videos.push({
        ...safeVideo,
        transcript_segments: ranked,
        contentLimit: segmentError
          ? "Saved transcript retrieval failed; answer only from the available saved material."
          : !ranked.length
            ? "No timestamped transcript is available; answer from saved analysis or transcript without inventing timestamps."
            : null,
      });
  }
  if (!videos.length)
    return {
      videos,
      failure:
        "I couldn't retrieve the Library content in this view with your account's access. I can't answer from it yet.",
    };
  return { videos, failure: null };
}
