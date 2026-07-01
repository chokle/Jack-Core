/**
 * distillation — Jack's internal Atomic Knowledge Distillation Engine.
 *
 * Given a processed video's transcript and timestamped segments, this module
 * asks the analysis model to distill the handful of *reusable* trade concepts the
 * video actually teaches — durable field intelligence like "Voltage Selection",
 * "Travel Speed", "Root Opening", "Arc Blow", "Porosity", "WPS", "Preheat" — and
 * NOT one item per sentence or transcript fragment. Each distilled object is a
 * reusable concept that the same concept from a different video collapses onto,
 * so the graph grows a shared many-to-many knowledge library instead of ballooning
 * with near-duplicate per-video fragments.
 *
 * The engine runs entirely inside the ingestion pipeline. It is never exposed as
 * a public mutation endpoint (the API uses the Supabase service-role key and has
 * no auth, so graph-mutating routes are deliberately server-internal).
 *
 * Both LLM output and Supabase writes are treated as hazards: the model's JSON is
 * normalized, validated, de-duplicated, and bounded before anything is persisted,
 * and text fields are HTML-stripped at write time (defense-in-depth against
 * stored XSS, consistent with the rest of the pipeline).
 */
import { openai, MODELS } from "./openai.js";
import { logger } from "./logger.js";
import { supabase } from "./supabase.js";
import { knowledgeNodeId, syncVideoKnowledge } from "./memory-graph.js";

/**
 * The reusable atomic knowledge categories. `competency` already exists as a
 * seeded node kind and is reused via the knowledge -> competency mapping rather
 * than duplicated here — these are the *new* durable concept categories.
 */
export const KNOWLEDGE_CATEGORIES = [
  "concept",
  "tool",
  "equipment",
  "material",
  "procedure",
  "hazard",
  "slang",
  "certification",
  "standard",
  "regional_term",
] as const;

export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(KNOWLEDGE_CATEGORIES);

/** One reusable atomic knowledge object distilled from a single video. */
export interface AtomicKnowledge {
  /** Canonical deterministic node id: k:<category>:<normalized-title>. */
  id: string;
  title: string;
  description: string;
  category: KnowledgeCategory;
  /** Transcript timestamps (seconds) where this concept is discussed. */
  timestamps: number[];
  /** Per-extraction confidence in [0,1] for this video's contribution. */
  confidence: number;
  /** Optional Red Seal competency this concept maps to, if the model matched one. */
  competencyCode: string | null;
}

/** Never create more than this many concepts from one video — this is a distiller,
 * not a per-sentence indexer. */
export const MAX_KNOWLEDGE_ITEMS = 12;
const MAX_TITLE_LEN = 120;
const MAX_DESCRIPTION_LEN = 600;
const MAX_TIMESTAMPS_PER_ITEM = 8;
const MAX_TRANSCRIPT_CHARS = 8000;

/** Strip HTML so prompt-injected markup in model output is never stored. */
function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Build a compact timestamped transcript so the model can attribute real segment
 * times to each concept. Falls back to the plain transcript when there are no
 * segments. Bounded in length to keep token cost predictable.
 */
function buildTimestampedTranscript(
  transcript: string,
  segments: { start: number; text: string }[],
): string {
  if (segments.length === 0) return transcript.slice(0, MAX_TRANSCRIPT_CHARS);
  const lines: string[] = [];
  let length = 0;
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    const line = `[${seg.start.toFixed(1)}] ${text}`;
    if (length + line.length > MAX_TRANSCRIPT_CHARS) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * Normalize, validate, de-duplicate, and bound the model's raw JSON output into a
 * clean set of atomic knowledge objects. Duplicates within a single video (same
 * normalized concept + category) are merged: their timestamps are unioned and the
 * higher confidence is kept.
 */
export function normalizeItems(raw: unknown, validCompetencyCodes: Set<string>): AtomicKnowledge[] {
  const arr = Array.isArray(raw) ? raw : [];
  const byId = new Map<string, AtomicKnowledge>();

  for (const entry of arr) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;

    const category = typeof e["category"] === "string" ? e["category"].toLowerCase().trim() : "";
    if (!CATEGORY_SET.has(category)) continue;

    const title = typeof e["title"] === "string" ? stripHtml(e["title"]).slice(0, MAX_TITLE_LEN) : "";
    if (!title) continue;

    const description =
      typeof e["description"] === "string"
        ? stripHtml(e["description"]).slice(0, MAX_DESCRIPTION_LEN)
        : "";

    const timestamps = Array.isArray(e["timestamps"])
      ? e["timestamps"]
          .map((t) => (typeof t === "number" ? t : Number(t)))
          .filter((t): t is number => Number.isFinite(t) && t >= 0)
      : [];

    const rawCode = typeof e["competencyCode"] === "string" ? e["competencyCode"].trim() : "";
    const competencyCode = rawCode && validCompetencyCodes.has(rawCode) ? rawCode : null;

    const id = knowledgeNodeId(category as KnowledgeCategory, title);
    const confidence = clampConfidence(e["confidence"]);

    const existing = byId.get(id);
    if (existing) {
      const merged = new Set([...existing.timestamps, ...timestamps]);
      existing.timestamps = [...merged].sort((a, b) => a - b).slice(0, MAX_TIMESTAMPS_PER_ITEM);
      existing.confidence = Math.max(existing.confidence, confidence);
      if (!existing.description && description) existing.description = description;
      if (!existing.competencyCode && competencyCode) existing.competencyCode = competencyCode;
      continue;
    }

    byId.set(id, {
      id,
      title,
      description,
      category: category as KnowledgeCategory,
      timestamps: [...new Set(timestamps)].sort((a, b) => a - b).slice(0, MAX_TIMESTAMPS_PER_ITEM),
      confidence,
      competencyCode,
    });
  }

  // Bound the total: keep the highest-confidence concepts if the model over-produced.
  return [...byId.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_KNOWLEDGE_ITEMS);
}

/**
 * Distill a transcript into a bounded set of reusable atomic knowledge objects by
 * asking the analysis model. Returns a validated, de-duplicated, bounded list —
 * never raw model output.
 */
export async function distillTranscript(input: {
  title: string;
  trade: string | null;
  transcript: string;
  segments: { start: number; text: string }[];
  competencies: { code: string; name: string; trade: string }[];
}): Promise<AtomicKnowledge[]> {
  const { title, trade, transcript, segments, competencies } = input;
  const timestamped = buildTimestampedTranscript(transcript, segments);
  if (!timestamped.trim()) return [];

  const competencyContext =
    competencies.length > 0
      ? competencies.map((c) => `${c.code}: ${c.name} (${c.trade})`).join("\n")
      : "(none)";

  const completion = await openai.chat.completions.create({
    model: MODELS.analysis,
    messages: [
      {
        role: "system",
        content: `You are Jack's Knowledge Distillation Engine for skilled trades training. Your job is to distill a training video transcript into a SMALL set of REUSABLE, DURABLE trade knowledge objects — the kind of field intelligence that recurs across many videos.

Examples of good atomic knowledge (reusable concepts, NOT sentences): Voltage Selection, Travel Speed, Root Opening, Jet Rod, Arc Blow, Porosity, Cold Lap, WPS, Preheat, Hydrogen Cracking, Torque Spec, Bend Radius.

Rules:
- Return ONLY durable, reusable concepts — things another video on the same trade could also teach. Do NOT create one object per sentence, per segment, or per specific example in this video.
- Return AT MOST ${MAX_KNOWLEDGE_ITEMS} objects. Fewer is better; only include what the video genuinely teaches.
- Each object's "category" MUST be one of: ${KNOWLEDGE_CATEGORIES.join(", ")}.
  concept = a technique/principle; tool = a hand/power tool; equipment = larger machinery/gear; material = a consumable/stock; procedure = a repeatable process; hazard = a safety risk; slang = trade terminology/jargon; certification = a credential; standard = a code/spec (e.g. CSA, WPS); regional_term = a location-specific term.
- "timestamps" is an array of transcript times in seconds (from the [seconds] markers) where the concept is discussed.
- "confidence" is your confidence in [0,1] that this is a real, reusable concept this video teaches.
- "competencyCode" is OPTIONAL — set it to a Red Seal code from the list below ONLY if this concept clearly maps to one, else omit or null.

Available Red Seal competencies:
${competencyContext}`,
      },
      {
        role: "user",
        content: `Distill the reusable atomic knowledge from this training video "${title}" (trade: ${trade ?? "general"}).

Timestamped transcript:
${timestamped}

Respond with a JSON object of the exact shape:
{
  "knowledge": [
    {
      "title": "Short concept name",
      "description": "1-2 sentence explanation of the concept",
      "category": "concept",
      "timestamps": [12.5, 88.0],
      "confidence": 0.9,
      "competencyCode": "W-3"
    }
  ]
}`,
      },
    ],
    response_format: { type: "json_object" },
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}");
  } catch {
    return [];
  }

  const knowledge =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["knowledge"]
      : undefined;

  const validCodes = new Set(competencies.map((c) => c.code));
  return normalizeItems(knowledge, validCodes);
}

/**
 * Full pipeline step: read a ready video's transcript, segments, and the
 * competency catalog, distill reusable atomic knowledge, and persist it into the
 * graph (canonical dedup + many-to-many provenance). Throws on failure; callers
 * wrap this best-effort so a distillation failure never downgrades the video.
 */
export async function runDistillation(videoId: string): Promise<void> {
  const { data: video, error: vErr } = await supabase
    .from("videos")
    .select("id, title, trade, transcript, status")
    .eq("id", videoId)
    .maybeSingle();
  if (vErr) throw vErr;

  const transcript = typeof video?.transcript === "string" ? video.transcript : "";
  if (!video || !transcript.trim()) {
    logger.info({ videoId }, "distillation skipped: no transcript");
    return;
  }

  const { data: segRows, error: sErr } = await supabase
    .from("transcript_segments")
    .select("start_time, text")
    .eq("video_id", videoId)
    .order("start_time", { ascending: true });
  if (sErr) throw sErr;

  const segments = (segRows ?? []).map((s: Record<string, unknown>) => ({
    start: typeof s["start_time"] === "number" ? s["start_time"] : Number(s["start_time"]) || 0,
    text: typeof s["text"] === "string" ? s["text"] : "",
  }));

  const { data: comps, error: cErr } = await supabase
    .from("competencies")
    .select("code, name, trade");
  if (cErr) throw cErr;
  const competencies = (comps ?? []).map((c: Record<string, unknown>) => ({
    code: String(c["code"] ?? ""),
    name: String(c["name"] ?? ""),
    trade: String(c["trade"] ?? ""),
  }));

  const items = await distillTranscript({
    title: typeof video.title === "string" ? video.title : "Untitled",
    trade: (video.trade as string | null) ?? null,
    transcript,
    segments,
    competencies,
  });

  await syncVideoKnowledge(videoId, items);
  logger.info({ videoId, count: items.length }, "distilled atomic knowledge");
}
