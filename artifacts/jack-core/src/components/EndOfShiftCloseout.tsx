import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  type CloseoutPayload,
  type CloseoutRecord,
  type CloseoutShift,
  type CloseoutState,
  loadCloseout,
  saveCloseout,
  type GetCloseoutResponse,
} from "@/lib/user-testing/end-of-shift-closeout-service";

const QUESTION_LABELS: Record<string, string> = {
  tasksCompleted: "What tasks were completed today?",
  safetyConcerns: "Any safety concerns or incidents?",
  handoverReadiness: "Are you ready for handover?",
  teamCoordination: "How was team coordination?",
  materialAndTools: "Any missing materials or tools?",
  nextShiftPriorities: "What should next shift focus on?",
};

const DEFAULT_SHIFT: CloseoutShift = "day";
const SHIFT_OPTIONS: Array<{ key: CloseoutShift; label: string }> = [
  { key: "day", label: "Day" },
  { key: "swing", label: "Swing" },
  { key: "night", label: "Night" },
];

function localIsoDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface EndOfShiftCloseoutProps {
  organizationName?: string | null;
  pilotName?: string | null;
  participantId: string;
  participantName?: string | null;
  organizationId?: string;
  pilotId?: string;
}

export function EndOfShiftCloseout({
  organizationName,
  pilotName,
  participantId,
  participantName,
  organizationId,
  pilotId,
}: EndOfShiftCloseoutProps) {
  const today = useMemo(() => localIsoDate(), []);
  const [workDate, setWorkDate] = useState(today);
  const [shift, setShift] = useState<CloseoutShift>(DEFAULT_SHIFT);
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [savedAnswers, setSavedAnswers] = useState<Record<string, string>>({});
  const [state, setState] = useState<CloseoutState>("not_started");
  const [scope, setScope] = useState<GetCloseoutResponse["scope"] | null>(null);
  const [trade, setTrade] = useState<string | null>(null);
  const [crew, setCrew] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [closeout, setCloseout] = useState<CloseoutRecord | null>(null);
  const [closeoutLoaded, setCloseoutLoaded] = useState(false);

  const sortedAnswers = useMemo(() => {
    const next: Record<string, string> = {};
    for (const question of questions) {
      next[question] = answers[question] ?? "";
    }
    return next;
  }, [answers, questions]);

  const complete = useMemo(
    () =>
      questions.length > 0 &&
      questions.every(
        (question) => String(sortedAnswers[question]).trim().length > 0,
      ),
    [questions, sortedAnswers],
  );
  const readOnly = state === "submitted";
  const canResumeDraft = closeout?.status === "draft" && closeoutLoaded;

  const label =
    state === "not_started"
      ? "Not started"
      : state === "draft"
        ? "Draft"
        : "Submitted";

  const hydrate = (body: GetCloseoutResponse) => {
    const nextQuestions = body.availableQuestions ?? [];
    const nextAnswers: Record<string, string> = {};
    for (const question of nextQuestions) {
      nextAnswers[question] = body.closeout?.answers?.[question] ?? "";
    }

    setState(body.state);
    setQuestions(nextQuestions);
    setAnswers(nextAnswers);
    setSavedAnswers(nextAnswers);
    setTrade(body.trade ?? null);
    setCrew(body.crew ?? null);
    setScope(body.scope);
    setCloseout(body.closeout);
    setCloseoutLoaded(true);
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      hydrate(await loadCloseout({ workDate, shift }));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not load closeout.",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [workDate, shift]);

  const save = async (nextState: "draft" | "submitted") => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload: CloseoutPayload = {
        workDate,
        shift,
        status: nextState,
        answers,
      };
      const result = await saveCloseout(payload);
      setState(result.state);
      setCloseout(result.closeout);
      setSavedAnswers(result.closeout.answers);
      setAnswers(result.closeout.answers);
      setMessage(
        nextState === "submitted" ? "Closeout submitted." : "Draft saved.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Closeout could not be saved. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  const resume = () => {
    setAnswers(savedAnswers);
  };

  return (
    <main className="h-full overflow-y-auto p-4 sm:p-6 print:bg-white print:text-black">
      <div className="mx-auto grid max-w-3xl gap-4">
        <header className="space-y-1">
          <p className="text-xs uppercase tracking-[0.18em] text-primary">
            Pilot participant
          </p>
          <h1 className="text-xl font-bold">End-of-Shift Closeout</h1>
          <p className="text-sm text-muted-foreground">
            Structured mobile-ready workflow: save a draft, resume it later,
            then submit once complete.
          </p>
        </header>

        <section className="rounded-xl border border-border bg-card p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium text-muted-foreground">
                Participant
              </span>
              <Input value={participantName || participantId} readOnly />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium text-muted-foreground">
                Participant ID
              </span>
              <Input value={participantId} readOnly />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium text-muted-foreground">
                Work date
              </span>
              <Input
                type="date"
                value={workDate}
                onChange={(event) => setWorkDate(event.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium text-muted-foreground">Shift</span>
              <select
                className="h-10 w-full rounded-md border border-border bg-background p-2 text-sm"
                value={shift}
                onChange={(event) =>
                  setShift(event.target.value as CloseoutShift)
                }
              >
                {SHIFT_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium text-muted-foreground">
                Organization
              </span>
              <Input
                value={
                  organizationName ||
                  scope?.organizationId ||
                  organizationId ||
                  ""
                }
                readOnly
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium text-muted-foreground">Pilot</span>
              <Input
                value={pilotName || scope?.pilotId || pilotId || ""}
                readOnly
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium text-muted-foreground">Trade</span>
              <Input value={trade ?? "—"} readOnly />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium text-muted-foreground">Crew</span>
              <Input value={crew ?? "—"} readOnly />
            </label>
          </div>
        </section>

        <Alert>
          <AlertTitle>{`Closeout status: ${label}`}</AlertTitle>
          <AlertDescription>
            {readOnly
              ? "This closeout is submitted. It cannot be edited."
              : state === "draft"
                ? "A draft was loaded. Resume to continue or resubmit once updated."
                : "No closeout exists yet. Complete all questions to submit."}
          </AlertDescription>
        </Alert>

        {message && (
          <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
            {message}
          </p>
        )}
        {error && (
          <p className="rounded-lg border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading closeout…</p>
        ) : (
          <section className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {canResumeDraft && (
                <Button
                  variant="outline"
                  onClick={() => void resume()}
                  type="button"
                >
                  Resume draft
                </Button>
              )}
              <Button
                disabled={saving || readOnly}
                onClick={() => void save("draft")}
                type="button"
              >
                {saving ? "Saving…" : "Save draft"}
              </Button>
              <Button
                disabled={saving || readOnly || !complete}
                onClick={() => void save("submitted")}
                type="button"
              >
                {saving ? "Submitting…" : "Submit closeout"}
              </Button>
            </div>

            <div className="space-y-3">
              {questions.map((question) => (
                <label key={question} className="block space-y-1 text-sm">
                  <span className="font-semibold">
                    {QUESTION_LABELS[question] ?? question}
                  </span>
                  <Textarea
                    rows={3}
                    maxLength={1000}
                    value={sortedAnswers[question] ?? ""}
                    readOnly={readOnly}
                    onChange={(event) => {
                      const next = event.target.value.slice(0, 1000);
                      setAnswers((current) => ({
                        ...current,
                        [question]: next,
                      }));
                    }}
                    placeholder="Answer briefly"
                    className="min-h-20"
                  />
                  <div className="text-xs text-muted-foreground">
                    {sortedAnswers[question]?.length ?? 0}/1000
                  </div>
                </label>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
