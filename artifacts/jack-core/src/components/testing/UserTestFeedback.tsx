import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { Loader2, MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  clearFeedbackDraft,
  deviceCategory,
  getFeedbackActivity,
  isFeedbackEligible,
  isTopBoundaryExit,
  isTouchOrMobileDevice,
  markFeedbackFeature,
  markFeedbackPrompted,
  readFeedbackDraft,
  saveFeedbackDraft,
  type FeedbackAnswers,
  type FeedbackFeature,
  type FeedbackTrigger,
} from "@/lib/user-testing/feedback-service";

const EMPTY_ANSWERS = (): FeedbackAnswers => ({
  feedbackId: crypto.randomUUID(),
  goal: "",
  useful: "",
  shortfall: "",
  adoptionNeed: "",
  additional: "",
});

interface PendingPrompt {
  trigger: FeedbackTrigger;
  onContinue?: () => void | Promise<void>;
}

export interface UserTestFeedbackHandle {
  markFeature: (feature: FeedbackFeature) => void;
  request: (trigger: FeedbackTrigger, onContinue?: () => void | Promise<void>) => void;
}

interface UserTestFeedbackProps {
  consented: boolean;
  userId?: string | null;
  now?: () => number;
  minimumSessionMs?: number;
  requestTimeoutMs?: number;
}

export const UserTestFeedback = forwardRef<UserTestFeedbackHandle, UserTestFeedbackProps>(
  function UserTestFeedback(
    {
      consented,
      userId,
      now = Date.now,
      minimumSessionMs,
      requestTimeoutMs = 5_000,
    },
    ref,
  ) {
    const [pending, setPending] = useState<PendingPrompt | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [answers, setAnswers] = useState<FeedbackAnswers>(() =>
      userId ? readFeedbackDraft(userId) ?? EMPTY_ANSWERS() : EMPTY_ANSWERS(),
    );
    const { toast } = useToast();

    useEffect(() => {
      if (!userId) return;
      setAnswers(readFeedbackDraft(userId) ?? EMPTY_ANSWERS());
    }, [userId]);

    useEffect(() => {
      if (!userId) return;
      saveFeedbackDraft(userId, answers);
    }, [answers, userId]);

    const continueLeaving = useCallback(async (clearDraft: boolean) => {
      const action = pending?.onContinue;
      if (clearDraft && userId) clearFeedbackDraft(userId);
      setPending(null);
      setSubmitting(false);
      await action?.();
    }, [pending, userId]);

    const request = useCallback(
      (trigger: FeedbackTrigger, onContinue?: () => void | Promise<void>) => {
        if (pending) {
          void onContinue?.();
          return;
        }
        const currentTime = now();
        const activity = getFeedbackActivity(currentTime);
        if (
          !isFeedbackEligible({
            consented,
            userId,
            now: currentTime,
            activity,
            minimumSessionMs,
          })
        ) {
          void onContinue?.();
          return;
        }
        markFeedbackPrompted(userId!, currentTime);
        setPending({ trigger, onContinue });
      },
      [consented, minimumSessionMs, now, pending, userId],
    );

    useImperativeHandle(
      ref,
      () => ({
        markFeature: (feature) => {
          markFeedbackFeature(feature, now());
        },
        request,
      }),
      [now, request],
    );

    useEffect(() => {
      if (isTouchOrMobileDevice()) return;
      const onMouseOut = (event: MouseEvent) => {
        if (isTopBoundaryExit(event)) request("desktop_exit");
      };
      document.addEventListener("mouseout", onMouseOut);
      return () => document.removeEventListener("mouseout", onMouseOut);
    }, [request]);

    const valid = useMemo(
      () =>
        answers.goal.trim().length > 0 &&
        answers.useful !== "" &&
        answers.shortfall.trim().length > 0 &&
        answers.adoptionNeed.trim().length > 0,
      [answers],
    );

    const submit = async () => {
      if (!pending || !userId || !valid || submitting) return;
      setSubmitting(true);
      const activity = getFeedbackActivity(now());
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetch("/api/testing/feedback", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            feedbackId: answers.feedbackId,
            goal: answers.goal.trim(),
            useful: answers.useful,
            shortfall: answers.shortfall.trim(),
            adoptionNeed: answers.adoptionNeed.trim(),
            additional: answers.additional.trim() || null,
            featuresUsed: activity.features,
            sessionId: activity.sessionId,
            deviceCategory: deviceCategory(),
            trigger: pending.trigger,
            appVersion:
              import.meta.env.VITE_APP_VERSION ??
              import.meta.env.VITE_COMMIT_SHA ??
              "unknown",
          }),
        });
        if (!response.ok) throw new Error(`Feedback submission failed (${response.status})`);
        toast({ title: "Feedback submitted", description: "Thanks for helping improve Jack." });
        await continueLeaving(true);
      } catch {
        toast({
          title: "Feedback saved on this device",
          description: "We couldn't send it right now. You can still leave Jack.",
        });
        await continueLeaving(false);
      } finally {
        window.clearTimeout(timeout);
      }
    };

    const skip = () => {
      if (submitting) return;
      void continueLeaving(false);
    };

    return (
      <Dialog open={pending !== null} onOpenChange={(open) => !open && skip()}>
        <DialogContent
          data-testid="user-test-feedback"
          className="max-h-[92dvh] overflow-y-auto sm:max-w-xl"
        >
          <DialogHeader>
            <div className="mb-1 flex items-center gap-2 text-primary">
              <MessageSquareText className="h-5 w-5" aria-hidden="true" />
              <DialogTitle>Before you go — how did Jack do?</DialogTitle>
            </div>
            <DialogDescription>
              Four quick questions will help us make Jack more useful in the field.
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="block space-y-2">
              <span className="text-sm font-semibold">
                1. What did you try to accomplish with Jack today?
              </span>
              <Input
                autoFocus
                value={answers.goal}
                onChange={(event) => setAnswers((value) => ({ ...value, goal: event.target.value }))}
                maxLength={500}
                required
              />
            </label>

            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">
                2. Did Jack give you something useful enough to apply on the job?
              </legend>
              <div className="flex flex-wrap gap-2">
                {(["yes", "partly", "no"] as const).map((option) => (
                  <label
                    key={option}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm capitalize has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:checked]:text-primary"
                  >
                    <input
                      type="radio"
                      name="useful"
                      value={option}
                      checked={answers.useful === option}
                      onChange={() => setAnswers((value) => ({ ...value, useful: option }))}
                      required
                    />
                    {option}
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="block space-y-2">
              <span className="text-sm font-semibold">
                3. Where did Jack fall short or make you hesitate?
              </span>
              <Input
                value={answers.shortfall}
                onChange={(event) =>
                  setAnswers((value) => ({ ...value, shortfall: event.target.value }))
                }
                maxLength={500}
                required
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-semibold">
                4. What would Jack need before you’d use it—or recommend it—to your crew?
              </span>
              <Input
                value={answers.adoptionNeed}
                onChange={(event) =>
                  setAnswers((value) => ({ ...value, adoptionNeed: event.target.value }))
                }
                maxLength={500}
                required
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-semibold">Anything else we should know?</span>
              <Textarea
                value={answers.additional}
                onChange={(event) =>
                  setAnswers((value) => ({ ...value, additional: event.target.value }))
                }
                maxLength={1_000}
                rows={3}
              />
              <span className="text-xs text-muted-foreground">Optional</span>
            </label>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="ghost" onClick={skip} disabled={submitting}>
                Skip for now
              </Button>
              <Button type="submit" disabled={!valid || submitting}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Submit feedback
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  },
);
