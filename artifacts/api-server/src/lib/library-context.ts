import { supabase } from "./supabase.js";
import { currentJackUiRequestContext } from "./jack-ui-request-context.js";

/** Resolve UI IDs as data, never as authority or as arbitrary table identifiers. */
export async function loadLibraryContext(message: string, userId: string) {
  const context = currentJackUiRequestContext();
  const resources =
    context && ["Library", "Video"].includes(context.surface)
      ? (context.resources ?? [])
      : [];
  const selected = resources.find((item) => item.selected);
  const targets = selected ? [selected] : resources;
  if (!targets.length)
    return {
      videos: [] as Record<string, unknown>[],
      failure: null as string | null,
    };
  // Direct IDs cannot bypass ownership. Existing broad Library search has a
  // separate shared-library policy; this new contextual lookup is owner-scoped.
  const { data, error } = await supabase
    .from("videos")
    .select(
      "id,title,trade,status,analysis,transcript,key_points,description,thumbnail_url",
    )
    .eq("uploader_user_id", userId)
    .in(
      "id",
      targets.map((item) => item.id),
    )
    .limit(3);
  if (error)
    return {
      videos: [],
      failure:
        "I couldn't retrieve the Library material for this view. Please try again.",
    };
  if (
    !selected &&
    targets.length > 1 &&
    /\b(this|that)\s+(video|clip)\b/i.test(message)
  ) {
    const titles = (data ?? []).map((video) => String(video.title)).join("; ");
    return {
      videos: [],
      failure: titles
        ? `I can see these Library entries: ${titles}. Which one do you mean?`
        : "I couldn't retrieve the Library content in this view with your account's access.",
    };
  }
  const videos: Record<string, unknown>[] = [];
  for (const video of data ?? []) {
    const { data: segments, error: segmentError } = await supabase
      .from("transcript_segments")
      .select("id,video_id,start_time,end_time,text")
      .eq("video_id", video.id)
      .order("start_time", { ascending: true })
      .limit(1000);
    const words = [
      ...new Set(message.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []),
    ].filter(
      (word) =>
        !/^(the|this|that|what|does|video|showing|show|with|from|have|about)$/.test(
          word,
        ),
    );
    const ranked = (segments ?? [])
      .map((segment) => ({
        segment,
        score: words.reduce(
          (score, word) =>
            score + Number(String(segment.text).toLowerCase().includes(word)),
          0,
        ),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(a.segment.start_time) - Number(b.segment.start_time),
      )
      .slice(0, 6)
      .map(({ segment }) => segment);
    const hasContent =
      ranked.length > 0 ||
      Boolean(video.analysis || video.transcript || video.key_points?.length);
    if (!hasContent && targets.length === 1)
      return {
        videos: [],
        failure: `You're looking at ${video.title}. I found its Library entry, but ${segmentError ? "I couldn't retrieve its saved transcript" : "its saved video content isn't available yet"}.`,
      };
    if (hasContent) videos.push({ ...video, transcript_segments: ranked });
  }
  if (!videos.length)
    return {
      videos,
      failure:
        "I couldn't retrieve the Library content in this view with your account's access. I can't answer from it yet.",
    };
  return { videos, failure: null };
}
