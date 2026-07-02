import { useState } from "react";
import {
  Mic,
  SkipForward,
  Send,
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
import { useQueryClient } from "@tanstack/react-query";
import {
  useStartInterview,
  useSubmitInterviewAnswer,
  useSkipInterviewQuestion,
  useFinishInterview,
  getGetGraphQueryKey,
  type InterviewSession,
  type ExtractedKnowledgeItem,
  type InterviewAnswerDistillationStatus,
} from "@workspace/api-client-react";

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
          if (result.session.complete) setStage("complete");
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
          if (result.session.complete) setStage("complete");
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
          {stage === "intake" && (
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

              {/* Answer box */}
              <form onSubmit={handleSubmitAnswer} className="space-y-3">
                <Textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="Answer in your own words — Jack captures it verbatim…"
                  className="min-h-32 resize-none bg-background text-base leading-relaxed"
                  disabled={busy}
                  autoFocus
                />
                {error && (
                  <p className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-sm text-destructive">
                    {error}
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={handleSkip}
                      disabled={busy}
                      className="text-muted-foreground"
                    >
                      <SkipForward className="mr-2 h-4 w-4" /> Skip
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={handleFinish}
                      disabled={busy}
                      className="text-muted-foreground"
                    >
                      Wrap up
                    </Button>
                  </div>
                  <Button
                    type="submit"
                    disabled={busy || !answer.trim()}
                    className="bg-primary text-primary-foreground"
                  >
                    {submitAnswer.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
                      </>
                    ) : (
                      <>
                        <Send className="mr-2 h-4 w-4" /> Submit answer
                      </>
                    )}
                  </Button>
                </div>
              </form>

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
