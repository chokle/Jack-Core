/**
 * interview — Jack's conversational Interview Mode engine.
 *
 * Jack interviews an experienced tradesperson like a real person would: one
 * plainspoken question at a time, drilling deeper when an answer is substantive
 * and valuable, moving on when a thread is exhausted or the mentor skips, and
 * never badgering. Over the course of the interview it works through a set of
 * durable knowledge themes (first lessons, beginner mistakes, safety, slang,
 * near-misses, advice for apprentices, and so on) so the captured knowledge is
 * broad and reusable — not a single war story.
 *
 * This module owns ONLY the question-generation logic. Persistence (sessions,
 * verbatim answers) and distillation live in the route + distillation engine. The
 * server is authoritative for the pending question; the model never sees or
 * controls stored state directly.
 */
import { chatCompletion, MODELS } from "./openai.js";
import { logger } from "./logger.js";
import { JURISDICTION_POLICY_BRIEF } from "./jurisdiction.js";
import { JACK_CONSTITUTION_BRIEF } from "./constitution.js";
import { JACK_CORE_SYSTEM_MAP_BRIEF } from "./system-map.js";

/** The trades a mentor can be interviewed for (UI selection list). */
export const INTERVIEW_TRADES = [
  "Welding",
  "Heavy Equipment Operator",
  "Electrical",
  "Plumbing",
  "Carpentry",
  "HVAC/R",
  "Other",
] as const;

export type InterviewTrade = (typeof INTERVIEW_TRADES)[number];

/**
 * Map the interview trade label onto the seeded Red Seal trade vocabulary so a
 * mentor's distilled concepts hang off the SAME topic hubs the video pipeline
 * already uses (e.g. "Welding" → "Welder"), instead of fragmenting the graph.
 * "Other" carries the mentor's free-text trade; "Heavy Equipment Operator" has
 * no seeded competencies and simply anchors its own honest topic hub.
 */
const TRADE_NORMALIZATION: Record<string, string> = {
  Welding: "Welder",
  Electrical: "Electrician",
  Plumbing: "Plumber",
  Carpentry: "Carpenter",
  "HVAC/R": "HVAC/R Technician",
  "Heavy Equipment Operator": "Heavy Equipment Operator",
};

/** Normalize a selected trade (+ optional free-text for "Other") to a graph trade. */
export function normalizeTrade(trade: string, tradeInput?: string | null): string | null {
  const t = trade.trim();
  if (!t) return (tradeInput ?? "").trim() || null;
  if (t === "Other") return (tradeInput ?? "").trim() || null;
  return TRADE_NORMALIZATION[t] ?? t;
}

/** One interview theme, with a deterministic fallback question. `{trade}` is
 * interpolated with a friendly trade name at question time. */
export interface InterviewCategory {
  key: string;
  label: string;
  seed: string;
}

export const INTERVIEW_CATEGORIES: InterviewCategory[] = [
  {
    key: "career_background",
    label: "Getting into the trade",
    seed: "To start — how did you get into {trade}, and how long have you been at it?",
  },
  {
    key: "first_lessons",
    label: "First real lessons",
    seed: "What's something you learned early on in {trade} that really stuck with you?",
  },
  {
    key: "beginner_mistakes",
    label: "Beginner mistakes",
    seed: "What mistake do you see new people in {trade} make over and over?",
  },
  {
    key: "tools_equipment",
    label: "Tools & equipment",
    seed: "Is there a tool or piece of equipment you rely on that a lot of people underuse or misuse?",
  },
  {
    key: "machine_process",
    label: "Machines & process",
    seed: "Walk me through how you approach setting up for a typical job.",
  },
  {
    key: "safety",
    label: "Safety",
    seed: "What's a safety habit you never break, no matter how routine the job is?",
  },
  {
    key: "troubleshooting",
    label: "Troubleshooting",
    seed: "When something goes wrong on the job, how do you figure out what's actually causing it?",
  },
  {
    key: "production_tips",
    label: "Doing it faster & better",
    seed: "What's a trick you've picked up that makes the work faster or cleaner without cutting corners?",
  },
  {
    key: "jobsite_culture",
    label: "Jobsite culture",
    seed: "What's the jobsite culture like in {trade}, and what should a new hand know about fitting in?",
  },
  {
    key: "trade_slang",
    label: "Trade slang",
    seed: "Is there any slang or shop talk in {trade} that would confuse an outsider?",
  },
  {
    key: "near_misses",
    label: "Close calls",
    seed: "Have you ever had a close call, and what did it teach you?",
  },
  {
    key: "advice_apprentices",
    label: "Advice for apprentices",
    seed: "If you were training an apprentice tomorrow, what's the one thing you'd drill into them?",
  },
];

const CATEGORY_KEYS = new Set(INTERVIEW_CATEGORIES.map((c) => c.key));
export const TOTAL_INTERVIEW_CATEGORIES = INTERVIEW_CATEGORIES.length;

/** Hard cap so an interview always terminates even if the model never signals done. */
export const MAX_INTERVIEW_QUESTIONS = 40;

/**
 * Per-trade subtopic hints that steer the machine/process thread. Heavy Equipment
 * Operators run very different machines, so we name them to draw out
 * machine-specific field intelligence.
 */
const MACHINE_HINTS: Record<string, string> = {
  "Heavy Equipment Operator":
    "excavators, dozers, graders, wheel loaders, backhoes, skid steers, cranes; grade/slope work, track vs. wheel, load charts, two-blocking, ground conditions",
  Welder: "SMAW/GMAW/FCAW/GTAW processes, machine setup, polarity, wire/rod selection, positions",
  Electrician: "panels, service equipment, motor controls, testing/metering, conduit bending",
  Plumber: "DWV, water supply, fixtures, venting, gas piping, pressure testing",
  Carpenter: "framing, formwork, finishing, layout, fasteners, cutting",
  "HVAC/R Technician": "refrigeration cycle, charging, recovery, airflow, controls, brazing",
};

export interface MentorProfileLite {
  name: string;
  /** Normalized (graph) trade. */
  trade: string | null;
  /** The trade as the mentor selected/typed it (friendlier for prompts). */
  tradeLabel?: string | null;
  yearsExperience?: number | null;
  specialties?: string[];
  region?: string | null;
  background?: string | null;
}

export interface AnsweredTurn {
  question: string;
  category: string | null;
  topic: string | null;
  answer: string | null;
  skipped: boolean;
}

export interface NextQuestion {
  question: string;
  category: string;
  topic: string | null;
  complete: boolean;
}

/** A friendly trade name for prompts/seeds — prefers the mentor's own wording. */
function tradeName(profile: MentorProfileLite): string {
  return (profile.tradeLabel || profile.trade || "the trade").trim();
}

/** Distinct themes already put to the mentor this session. */
function askedCategories(history: AnsweredTurn[]): Set<string> {
  const s = new Set<string>();
  for (const t of history) if (t.category) s.add(t.category);
  return s;
}

/**
 * Deterministic fallback used when the model is unavailable or returns something
 * unusable: walk the themes in order, asking the seed for the first one not yet
 * covered. Signals complete once every theme has been touched or the cap is hit.
 */
function fallbackQuestion(profile: MentorProfileLite, history: AnsweredTurn[]): NextQuestion {
  const asked = askedCategories(history);
  const next = INTERVIEW_CATEGORIES.find((c) => !asked.has(c.key));
  if (!next || history.length >= MAX_INTERVIEW_QUESTIONS) {
    return { question: "", category: "wrap_up", topic: null, complete: true };
  }
  return {
    question: next.seed.replace(/\{trade\}/g, tradeName(profile)),
    category: next.key,
    topic: null,
    complete: false,
  };
}

/**
 * Build the interview system prompt. Extracted (and exported) as a pure function
 * so the Canadian-jurisdiction default is unit-testable without a live model.
 */
export function buildInterviewSystemPrompt(args: {
  name: string;
  remaining: string[];
  machineHint: string | undefined;
}): string {
  const { name, remaining, machineHint } = args;
  return `You are Jack, interviewing a seasoned ${name} to capture their hard-won field knowledge for an apprentice-facing knowledge base. Interview like a sharp, curious human — not a form.

${JURISDICTION_POLICY_BRIEF}
${JACK_CONSTITUTION_BRIEF}
${JACK_CORE_SYSTEM_MAP_BRIEF}

Rules:
- Ask EXACTLY ONE question. Keep it short, plainspoken, and conversational — the way a respectful colleague would ask. No preamble, no multi-part questions, no yes/no questions.
- If the mentor's last answer was substantive and valuable, DRILL DEEPER on it with a natural follow-up (ask for the "how" or "why", a specific example, or the tell-tale signs) instead of jumping topics. If the thread is exhausted, thin, or they skipped, move on to a fresh theme. Never badger.
- Assume a Canadian trade context: when a question touches codes, standards, certification, or safety, frame it the Canadian way (Red Seal / CSA / CWB, provincial regulators) — never assume OSHA, AWS, NEC, or other U.S. rules.
- Over the whole interview, work through these themes (you choose the order and when to move on): ${INTERVIEW_CATEGORIES.map((c) => c.key).join(", ")}. Themes not yet covered: ${remaining.length ? remaining.join(", ") : "(all covered — you may wrap up)"}.
${machineHint ? `- For machine/process questions, useful subtopics for this trade: ${machineHint}.` : ""}
- Set "complete" to true ONLY when you've meaningfully covered the themes and further questions would just repeat — then leave "question" empty.
- "category" MUST be one of the theme keys above (use the closest fit; use "wrap_up" only when complete).
- "topic" is a short 1-3 word tag for what this specific question is about (or null).

Respond with a JSON object: {"question": string, "category": string, "topic": string|null, "complete": boolean}.`;
}

/**
 * Ask the chat model for the next interview question given the mentor's profile
 * and the conversation so far. Returns a plainspoken single question tagged with
 * its theme, or `complete: true` when the interview has run its course. Falls
 * back to a deterministic themed question on any model/parse failure so the
 * interview never dead-ends.
 */
export async function generateNextQuestion(
  profile: MentorProfileLite,
  history: AnsweredTurn[],
): Promise<NextQuestion> {
  if (history.length >= MAX_INTERVIEW_QUESTIONS) {
    return { question: "", category: "wrap_up", topic: null, complete: true };
  }

  const asked = [...askedCategories(history)];
  const remaining = INTERVIEW_CATEGORIES.filter((c) => !asked.includes(c.key)).map((c) => c.key);
  const name = tradeName(profile);
  const machineHint = profile.trade ? MACHINE_HINTS[profile.trade] : undefined;

  // The last answered (non-skipped) turn decides whether to drill deeper.
  const lastAnswered = [...history].reverse().find((t) => !t.skipped && (t.answer ?? "").trim());

  const profileLines = [
    `Name: ${profile.name}`,
    `Trade: ${name}`,
    profile.yearsExperience ? `Years of experience: ${profile.yearsExperience}` : null,
    profile.specialties && profile.specialties.length
      ? `Specialties: ${profile.specialties.join(", ")}`
      : null,
    profile.region ? `Region: ${profile.region}` : null,
    profile.background ? `Background: ${profile.background}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  // Keep the transcript window bounded — recent turns matter most for follow-ups.
  const recent = history.slice(-8);
  const transcript =
    recent.length === 0
      ? "(no questions asked yet — this is the opening question)"
      : recent
          .map((t) => {
            const a = t.skipped ? "[SKIPPED]" : (t.answer ?? "").trim() || "[no answer]";
            return `Q (${t.category ?? "general"}): ${t.question}\nA: ${a}`;
          })
          .join("\n\n");

  const system = buildInterviewSystemPrompt({ name, remaining, machineHint });

  const user = `Mentor profile:
${profileLines}

Conversation so far:
${transcript}

${lastAnswered ? "Decide whether to follow up on their last answer or move to a new theme, then ask the next single question." : "Ask a warm, simple opening question."}`;

  try {
    const completion = await chatCompletion({
      model: MODELS.chat,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as Record<
      string,
      unknown
    >;

    const complete = parsed["complete"] === true;
    const question = typeof parsed["question"] === "string" ? parsed["question"].trim() : "";
    if (complete || !question) {
      return { question: "", category: "wrap_up", topic: null, complete: true };
    }

    const rawCategory = typeof parsed["category"] === "string" ? parsed["category"].trim() : "";
    const category = CATEGORY_KEYS.has(rawCategory)
      ? rawCategory
      : (remaining[0] ?? INTERVIEW_CATEGORIES[0]!.key);
    const rawTopic = typeof parsed["topic"] === "string" ? parsed["topic"].trim() : "";
    const topic = rawTopic ? rawTopic.slice(0, 60) : null;

    return { question: question.slice(0, 400), category, topic, complete: false };
  } catch (err) {
    logger.warn({ err }, "interview question generation failed; using fallback");
    return fallbackQuestion(profile, history);
  }
}
