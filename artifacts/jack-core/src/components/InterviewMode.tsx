import { useState, useEffect, useRef } from "react";
import {
  Mic,
  Loader2,
  Sparkles,
  CheckCircle2,
  RotateCcw,
  ArrowRight,
  Quote,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { VoiceAnswerInput } from "@/components/VoiceAnswerInput";
import { useQueryClient } from "@tanstack/react-query";
import {
  useStartInterview,
  useSubmitInterviewAnswer,
  useSkipInterviewQuestion,
  useFinishInterview,
  getInterviewSession,
  getGetGraphQueryKey,
  type InterviewSession,
  type InterviewAnswer,
  type ExtractedKnowledgeItem,
  type InterviewAnswerDistillationStatus,
} from "@workspace/api-client-react";
import {
  ParkThisThoughtButton,
  consumeInterviewResumeNote,
  type InterviewResumeNote,
  type ParkContextItem,
} from "@/components/ParkedThoughts";
import { timeAgo } from "@/lib/memory-graph";
import { Bookmark, X as XIcon } from "lucide-react";

/** The interview trade options, mirrored from the server vocabulary. */
const TRADE_OPTIONS = [
  "Welding",
  "Heavy Equipment Operator",
  "Electrical",
  "Plumbing",
  "Carpentry",
  "HVAC/R",
  "Other",
] as const;

type Stage = "intake" | "interviewing" | "complete";

/**
 * Browser-storage key for the active interview session id. Resume is best-effort
 * within the same browser: the session id is unguessable and there is no user
 * auth (consistent with the rest of the app), so persisting it locally lets an
 * interrupted interview (tab refresh, dropped network, navigation) pick up right
 * where the mentor left off.
 */
const ACTIVE_SESSION_KEY = "jack.interview.activeSessionId";

function saveActiveSessionId(id: string) {
  try {
    localStorage.setItem(ACTIVE_SESSION_KEY, id);
  } catch {
    // Storage unavailable (private mode / blocked) — resume is best-effort only.
  }
}

function clearActiveSessionId() {
  try {
    localStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    // Ignore — nothing to clear if storage is unavailable.
  }
}

function readActiveSessionId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY);
  } catch {
    return null;
  }
}

/**
 * Browser-storage key prefix for the in-progress (not-yet-submitted) answer
 * draft, keyed by session id. Auto-saving the draft as the mentor types means a
 * refresh / nav-away / dropped tab during a long, thoughtful answer resumes with
 * the text intact. The draft stores the question it was typed against so a stale
 * draft can never land on a different question after the interview advances.
 */
const DRAFT_KEY_PREFIX = "jack.interview.draft.";

function draftKey(sessionId: string) {
  return `${DRAFT_KEY_PREFIX}${sessionId}`;
}

function saveDraft(sessionId: string, question: string, text: string) {
  try {
    localStorage.setItem(draftKey(sessionId), JSON.stringify({ question, text }));
  } catch {
    // Storage unavailable (private mode / blocked) — draft save is best-effort.
  }
}

/** Return the saved draft only if it was typed against the current question. */
function readDraft(sessionId: string, question: string): string | null {
  try {
    const raw = localStorage.getItem(draftKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { question?: string; text?: string };
    if (parsed && parsed.question === question && typeof parsed.text === "string") {
      return parsed.text;
    }
    return null;
  } catch {
    return null;
  }
}

function clearDraft(sessionId: string) {
  try {
    localStorage.removeItem(draftKey(sessionId));
  } catch {
    // Ignore — nothing to clear if storage is unavailable.
  }
}

/** True when a fetch error is a definite "not found" (safe to drop stored id). */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 404
  );
}

/** Last few Q&A turns (plus the question in flight) as Park-a-thought context. */
function buildInterviewParkContext(
  transcript: Turn[],
  currentQuestion: string | null | undefined,
): ParkContextItem[] {
  const items: ParkContextItem[] = [];
  for (const t of transcript) {
    items.push({ role: "assistant", text: t.question });
    if (!t.skipped && t.answer) items.push({ role: "user", text: t.answer });
  }
  if (currentQuestion) items.push({ role: "assistant", text: currentQuestion });
  return items.slice(-5);
}

/** Rebuild a transcript turn from a persisted answer row (for resume). */
function turnFromAnswer(a: InterviewAnswer): Turn {
  return {
    question: a.question,
    answer: a.answerText ?? null,
    skipped: a.skipped,
    knowledge: a.extractedKnowledge ?? [],
    distillationStatus: a.distillationStatus ?? (a.skipped ? "pending" : "verified"),
  };
}

/** One captured turn shown in the running transcript. */
interface Turn {
  question: string;
  answer: string | null;
  skipped: boolean;
  knowledge: ExtractedKnowledgeItem[];
  /**
   * Whether this answer's knowledge actually reached the Living Memory graph.
   * "failed" means the verbatim answer is safe but distillation didn't land —
   * a reviewer can retry it from the Graph Health dashboard.
   */
  distillationStatus: InterviewAnswerDistillationStatus;
}

export function InterviewMode() {
  const queryClient = useQueryClient();

  const [stage, setStage] = useState<Stage>("intake");
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [transcript, setTranscript] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  // True while we attempt to resume a stored session on mount, so the intake
  // form doesn't flash before we know whether an interview is still in progress.
  const [resuming, setResuming] = useState(() => readActiveSessionId() !== null);
  // Set only when this session was reopened via a Parking Lot "Resume" — shows
  // a one-time reorientation banner, then is cleared.
  const [resumeNote, setResumeNote] = useState<InterviewResumeNote | null>(null);

  // Intake form state.
  const [name, setName] = useState("");
  const [trade, setTrade] = useState<string>("");
  const [tradeInput, setTradeInput] = useState("");
  const [years, setYears] = useState("");
  const [specialties, setSpecialties] = useState("");
  const [region, setRegion] = useState("");
  const [background, setBackground] = useState("");

  // Current answer being typed.
  const [answer, setAnswer] = useState("");

  const startInterview = useStartInterview();
  const submitAnswer = useSubmitInterviewAnswer();
  const skipQuestion = useSkipInterviewQuestion();
  const finishInterview = useFinishInterview();

  const busy =
    startInterview.isPending ||
    submitAnswer.isPending ||
    skipQuestion.isPending ||
    finishInterview.isPending;

  const refreshGraph = () =>
    queryClient.invalidateQueries({ queryKey: getGetGraphQueryKey() });

  const resetAll = () => {
    clearActiveSessionId();
    setStage("intake");
    setSession(null);
    setTranscript([]);
    setAnswer("");
    setError(null);
    setName("");
    setTrade("");
    setTradeInput("");
    setYears("");
    setSpecialties("");
    setRegion("");
    setBackground("");
  };

  // Resume an interrupted interview: on mount, if a session id is stored, fetch
  // it and its prior answers, rebuild the transcript, and drop the mentor back
  // into the conversation. A completed session or a definite not-found clears the
  // stored id and shows the intake form; a transient network error keeps the id
  // so a later reload can still resume.
  const didRehydrate = useRef(false);
  useEffect(() => {
    if (didRehydrate.current) return;
    didRehydrate.current = true;

    const storedId = readActiveSessionId();
    if (!storedId) {
      setResuming(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const detail = await getInterviewSession(storedId);
        if (cancelled) return;
        if (detail.session.complete) {
          // Finished (or wrapped up) elsewhere — nothing to resume.
          clearActiveSessionId();
          return;
        }
        setSession(detail.session);
        setTranscript(detail.answers.map(turnFromAnswer));
        // Restore the in-progress draft for the CURRENT question only, so a
        // stale draft never lands on a question the mentor already advanced past.
        const draft = readDraft(storedId, detail.session.currentQuestion ?? "");
        if (draft) setAnswer(draft);
        setStage("interviewing");
        setResumeNote(consumeInterviewResumeNote(storedId));
      } catch (err) {
        if (cancelled) return;
        // Only drop the stored id when the session is definitively gone; keep it
        // on a transient failure so a transient outage doesn't lose the resume.
        if (isNotFound(err)) clearActiveSessionId();
      } finally {
        if (!cancelled) setResuming(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-save the in-progress answer to localStorage as the mentor types, keyed
  // by session id + current question. Cleared automatically when the box empties
  // (submit/skip reset it), so only the active question ever has a saved draft.
  useEffect(() => {
    if (stage !== "interviewing" || !session) return;
    const question = session.currentQuestion ?? "";
    if (answer.trim()) {
      saveDraft(session.id, question, answer);
    } else {
      clearDraft(session.id);
    }
  }, [answer, session, stage]);

  const handleStart = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !trade || busy) return;
    if (trade === "Other" && !tradeInput.trim()) {
      setError("Please name the trade.");
      return;
    }
    setError(null);

    const specialtyList = specialties
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const parsedYears = years.trim() ? Number(years.trim()) : null;

    startInterview.mutate(
      {
        data: {
          name: name.trim(),
          trade,
          tradeInput: trade === "Other" ? tradeInput.trim() : null,
          yearsExperience:
            parsedYears !== null && !Number.isNaN(parsedYears) ? parsedYears : null,
          specialties: specialtyList,
          region: region.trim() || null,
          background: background.trim() || null,
        },
      },
      {
        onSuccess: (s) => {
          setSession(s);
          // Persist so an interrupted interview can resume in this browser.
          // A session that started already complete has nothing to resume.
          if (s.complete) clearActiveSessionId();
          else saveActiveSessionId(s.id);
          setStage(s.complete ? "complete" : "interviewing");
        },
        onError: () => setError("Couldn't start the interview. Please try again."),
      },
    );
  };

  const handleSubmitAnswer = (e: React.FormEvent) => {
    e.preventDefault();
    if (!session || !answer.trim() || busy) return;
    const question = session.currentQuestion ?? "";
    const text = answer.trim();
    setError(null);

    submitAnswer.mutate(
      { id: session.id, data: { answer: text } },
      {
        onSuccess: (result) => {
          setTranscript((t) => [
            ...t,
            {
              question,
              answer: text,
              skipped: false,
              knowledge: result.extractedKnowledge,
              distillationStatus: result.answer.distillationStatus ?? "verified",
            },
          ]);
          setSession(result.session);
          setAnswer("");
          refreshGraph();
          if (result.session.complete) {
            clearActiveSessionId();
            setStage("complete");
          }
        },
        onError: () => setError("Couldn't save that answer. Please try again."),
      },
    );
  };

  const handleSkip = () => {
    if (!session || busy) return;
    const question = session.currentQuestion ?? "";
    setError(null);

    skipQuestion.mutate(
      { id: session.id },
      {
        onSuccess: (result) => {
          setTranscript((t) => [
            ...t,
            {
              question,
              answer: null,
              skipped: true,
              knowledge: [],
              distillationStatus: "pending",
            },
          ]);
          setSession(result.session);
          setAnswer("");
          if (result.session.complete) {
            clearActiveSessionId();
            setStage("complete");
          }
        },
        onError: () => setError("Couldn't skip. Please try again."),
      },
    );
  };

  const handleFinish = () => {
    if (!session || busy) return;
    finishInterview.mutate(
      { id: session.id },
      {
        onSuccess: (s) => {
          clearActiveSessionId();
          clearDraft(session.id);
          setSession(s);
          setStage("complete");
          refreshGraph();
        },
        onError: () => setError("Couldn't wrap up. Please try again."),
      },
    );
  };

  const totalDistilled = transcript.reduce((n, t) => n + t.knowledge.length, 0);
  const answeredCount = transcript.filter((t) => !t.skipped).length;
  const failedCount = transcript.filter((t) => t.distillationStatus === "failed").length;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-border/70 bg-background/60 px-5 py-4 backdrop-blur-md md:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary shadow-[0_0_18px_rgba(255,100,0,0.25)]">
            <Mic className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">Interview Mode</h1>
            <p className="text-xs text-muted-foreground">
              Jack interviews an experienced tradesperson — one question at a time.
            </p>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-2xl px-5 py-6 md:px-8 md:py-10">
          {resuming && (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="font-mono text-xs uppercase tracking-[0.18em]">
                Resuming interview…
              </p>
            </div>
          )}

          {!resuming && stage === "intake" && (
            <IntakeForm
              name={name}
              setName={setName}
              trade={trade}
              setTrade={setTrade}
              tradeInput={tradeInput}
              setTradeInput={setTradeInput}
              years={years}
              setYears={setYears}
              specialties={specialties}
              setSpecialties={setSpecialties}
              region={region}
              setRegion={setRegion}
              background={background}
              setBackground={setBackground}
              onSubmit={handleStart}
              busy={busy}
              error={error}
            />
          )}

          {stage === "interviewing" && session && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                  {session.mentorName}
                  {session.trade ? ` · ${session.trade}` : ""}
                </div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  Q{session.questionCount}
                </div>
              </div>

              {resumeNote && (
                <div className="flex items-start justify-between gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <Bookmark className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                    <p className="text-xs leading-relaxed text-amber-200/90">
                      Picking up where you left off — parked {timeAgo(resumeNote.createdAt)}
                      {resumeNote.reason ? `: "${resumeNote.reason}"` : "."}
                      {resumeNote.unfinishedThought
                        ? ` You still wanted to cover: "${resumeNote.unfinishedThought}"`
                        : ""}
                    </p>
                  </div>
                  <button
                    onClick={() => setResumeNote(null)}
                    aria-label="Dismiss"
                    className="shrink-0 text-amber-300/70 hover:text-amber-200"
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              {/* Current question */}
              <div className="rounded-2xl border border-primary/25 bg-card/70 p-5 shadow-lg">
                {session.currentCategory && (
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-primary/80">
                    {session.currentCategory}
                  </div>
                )}
                <p className="flex gap-2 text-base font-medium leading-relaxed text-foreground">
                  <Sparkles className="mt-1 h-4 w-4 shrink-0 text-primary" />
                  <span>{session.currentQuestion}</span>
                </p>
              </div>

              {/* Answer box — voice-first capture with typing fallback */}
              <VoiceAnswerInput
                sessionId={session.id}
                answer={answer}
                onAnswerChange={setAnswer}
                onSubmit={handleSubmitAnswer}
                onSkip={handleSkip}
                onFinish={handleFinish}
                busy={busy}
                submitting={submitAnswer.isPending}
                formError={error}
                parkButton={
                  <ParkThisThoughtButton
                    source="interview"
                    interviewSessionId={session.id}
                    context={buildInterviewParkContext(transcript, session.currentQuestion)}
                    disabled={busy}
                  />
                }
              />

              {/* Live distillation feedback */}
              {totalDistilled > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
                  <Sparkles className="h-3.5 w-3.5" />
                  {totalDistilled} insight{totalDistilled === 1 ? "" : "s"} added to Jack's
                  memory from this interview.
                </div>
              )}

              {/* Failed-capture warning — the answer is saved, but its knowledge
                  didn't reach the graph and a reviewer needs to retry it. */}
              {failedCount > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {failedCount} answer{failedCount === 1 ? "" : "s"} saved, but{" "}
                    {failedCount === 1 ? "its" : "their"} knowledge didn't reach Jack's memory.
                    A reviewer can retry {failedCount === 1 ? "it" : "them"} from Graph Health —
                    nothing you said is lost.
                  </span>
                </div>
              )}

              {/* Transcript */}
              {transcript.length > 0 && (
                <div className="space-y-4 pt-2">
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    So far
                  </div>
                  {transcript.map((t, i) => (
                    <TranscriptItem key={i} turn={t} />
                  ))}
                </div>
              )}
            </div>
          )}

          {stage === "complete" && session && (
            <CompleteCard
              mentorName={session.mentorName}
              answered={answeredCount}
              distilled={totalDistilled}
              onRestart={resetAll}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * Per-concept outcome styling for the extracted-knowledge preview: reinforced an
 * existing concept (emerald), created a new concept (sky), or queued for review
 * (amber). Older snapshots without an outcome fall back to the created style.
 */
const OUTCOME_STYLE: Record<string, string> = {
  reinforced: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  created: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  queued: "border-amber-500/30 bg-amber-500/10 text-amber-300",
};

const OUTCOME_TAG: Record<string, string> = {
  reinforced: "reinforced",
  created: "new",
  queued: "review",
};

function outcomeTitle(k: ExtractedKnowledgeItem): string {
  const base = k.description ? `${k.description} — ` : "";
  if (k.outcome === "reinforced") {
    return `${base}Reinforced existing concept${k.matchedLabel ? `: ${k.matchedLabel}` : ""}`;
  }
  if (k.outcome === "queued") {
    return `${base}Held for review — close match to existing knowledge`;
  }
  return `${base}Added as a new concept`;
}

function TranscriptItem({ turn }: { turn: Turn }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4">
      <p className="mb-2 flex gap-2 text-sm text-muted-foreground">
        <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70" />
        <span>{turn.question}</span>
      </p>
      {turn.skipped ? (
        <p className="pl-5 font-mono text-xs italic text-muted-foreground/60">Skipped</p>
      ) : (
        <p className="whitespace-pre-wrap pl-5 text-sm leading-relaxed text-foreground">
          {turn.answer}
        </p>
      )}
      {turn.knowledge.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 pl-5">
          {turn.knowledge.map((k) => {
            const outcome = k.outcome ?? "created";
            return (
              <span
                key={k.id}
                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${OUTCOME_STYLE[outcome] ?? OUTCOME_STYLE["created"]}`}
                title={outcomeTitle(k)}
              >
                {k.title}
                <span className="ml-1 opacity-60">· {OUTCOME_TAG[outcome] ?? "new"}</span>
              </span>
            );
          })}
        </div>
      )}
      {!turn.skipped && turn.distillationStatus === "failed" && (
        <div className="mt-3 ml-5 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-300">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>Knowledge not captured — saved, but a reviewer needs to retry it.</span>
        </div>
      )}
    </div>
  );
}

function CompleteCard({
  mentorName,
  answered,
  distilled,
  onRestart,
}: {
  mentorName: string;
  answered: number;
  distilled: number;
  onRestart: () => void;
}) {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-border/70 bg-card/70 p-8 text-center shadow-xl">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400">
        <CheckCircle2 className="h-7 w-7" />
      </div>
      <h2 className="text-xl font-bold">Thanks, {mentorName}.</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Your experience is now part of Jack's living memory — captured verbatim and
        woven into the shared knowledge graph.
      </p>
      <div className="my-6 flex justify-center gap-8">
        <div>
          <div className="font-mono text-2xl font-bold text-primary">{answered}</div>
          <div className="text-xs text-muted-foreground">Answers</div>
        </div>
        <div>
          <div className="font-mono text-2xl font-bold text-emerald-400">{distilled}</div>
          <div className="text-xs text-muted-foreground">Insights distilled</div>
        </div>
      </div>
      <Button onClick={onRestart} className="bg-primary text-primary-foreground">
        <RotateCcw className="mr-2 h-4 w-4" /> Interview someone else
      </Button>
    </div>
  );
}

interface IntakeProps {
  name: string;
  setName: (v: string) => void;
  trade: string;
  setTrade: (v: string) => void;
  tradeInput: string;
  setTradeInput: (v: string) => void;
  years: string;
  setYears: (v: string) => void;
  specialties: string;
  setSpecialties: (v: string) => void;
  region: string;
  setRegion: (v: string) => void;
  background: string;
  setBackground: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  busy: boolean;
  error: string | null;
}

function IntakeForm(props: IntakeProps) {
  const {
    name,
    setName,
    trade,
    setTrade,
    tradeInput,
    setTradeInput,
    years,
    setYears,
    specialties,
    setSpecialties,
    region,
    setRegion,
    background,
    setBackground,
    onSubmit,
    busy,
    error,
  } = props;

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-6">
        <h2 className="text-xl font-bold tracking-tight">Tell Jack who's in the chair</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A few details so Jack can ask sharper, more relevant questions. Only a name and
          trade are required.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Dave Thompson"
            className="bg-background"
            required
          />
        </Field>

        <Field label="Trade" required>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {TRADE_OPTIONS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTrade(t)}
                className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                  trade === t
                    ? "border-primary bg-primary/15 font-semibold text-primary"
                    : "border-border bg-background text-muted-foreground hover:bg-muted/50"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </Field>

        {trade === "Other" && (
          <Field label="Which trade?" required>
            <Input
              value={tradeInput}
              onChange={(e) => setTradeInput(e.target.value)}
              placeholder="e.g. Millwright, Ironworker"
              className="bg-background"
            />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-4">
          <Field label="Years in the trade">
            <Input
              type="number"
              min={0}
              value={years}
              onChange={(e) => setYears(e.target.value)}
              placeholder="e.g. 22"
              className="bg-background"
            />
          </Field>
          <Field label="Region">
            <Input
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="e.g. Alberta"
              className="bg-background"
            />
          </Field>
        </div>

        <Field label="Specialties (comma-separated)">
          <Input
            value={specialties}
            onChange={(e) => setSpecialties(e.target.value)}
            placeholder="e.g. pipe welding, TIG, rig work"
            className="bg-background"
          />
        </Field>

        <Field label="Anything else Jack should know?">
          <Textarea
            value={background}
            onChange={(e) => setBackground(e.target.value)}
            placeholder="Optional background — the kind of work, career highlights…"
            className="h-20 resize-none bg-background"
          />
        </Field>

        {error && (
          <p className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-sm text-destructive">
            {error}
          </p>
        )}

        <Button
          type="submit"
          disabled={busy || !name.trim() || !trade}
          className="w-full bg-primary text-primary-foreground"
        >
          {busy ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting…
            </>
          ) : (
            <>
              Begin interview <ArrowRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>
      </form>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
        {required && <span className="ml-1 text-primary">*</span>}
      </label>
      {children}
    </div>
  );
}
