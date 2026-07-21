import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import {
  getGetMemoryGraphOnboardingPreferenceQueryKey,
  trackMemoryGraphOnboardingEvent,
  useGetMemoryGraphOnboardingPreference,
  useUpdateMemoryGraphOnboardingPreference,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export const MEMORY_GRAPH_ONBOARDING_VERSION = 1 as const;
export const MEMORY_GRAPH_ONBOARDING_STEP_COUNT = 3;

export type MemoryGraphOnboardingSource = "automatic" | "replay";
export type MemoryGraphOnboardingTarget = "memory" | "connections" | "growth";

const STEPS = [
  {
    heading: "Jack’s Living Memory",
    copy: "This graph represents the field knowledge Jack has captured and connected.",
    target: "memory" as const,
  },
  {
    heading: "Knowledge connects.",
    copy: "Each node represents a topic, source or field contribution. Connections show how that knowledge relates across Jack’s memory.",
    hint: "Tap a node for details. Drag to explore and pinch or scroll to zoom.",
    target: "connections" as const,
  },
  {
    heading: "Every contribution makes Jack stronger.",
    copy: "As tradespeople share and verify their experience, Jack builds a deeper, more useful knowledge network.",
    target: "growth" as const,
  },
] as const;

interface OnboardingSession {
  id: number;
  source: MemoryGraphOnboardingSource;
  step: number;
}

export interface MemoryGraphOnboardingController {
  session: OnboardingSession | null;
  reopen: () => void;
  setStep: (step: number) => void;
  skip: () => void;
  finish: () => void;
  dismiss: () => void;
}

function sendAnalytics(
  event:
    | "memory_onboarding_started"
    | "memory_onboarding_step_viewed"
    | "memory_onboarding_skipped"
    | "memory_onboarding_completed"
    | "memory_onboarding_reopened",
  source: MemoryGraphOnboardingSource,
  step?: number,
): void {
  const body = {
    event,
    source,
    version: MEMORY_GRAPH_ONBOARDING_VERSION,
    ...(step === undefined ? {} : { step }),
  } as const;
  void trackMemoryGraphOnboardingEvent(body).catch(() => {
    // Pilot analytics are deliberately best-effort.
  });
}

export function useMemoryGraphOnboarding(): MemoryGraphOnboardingController {
  const queryClient = useQueryClient();
  const preferenceQuery = useGetMemoryGraphOnboardingPreference({
    query: {
      queryKey: getGetMemoryGraphOnboardingPreferenceQueryKey(),
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: Number.POSITIVE_INFINITY,
    },
  });
  const preferenceRef = useRef(preferenceQuery.data?.preference ?? null);
  const autoDecisionMadeRef = useRef(false);
  const nextSessionIdRef = useRef(1);
  const sessionRef = useRef<OnboardingSession | null>(null);
  const [session, setSessionState] = useState<OnboardingSession | null>(null);

  const setSession = useCallback((next: OnboardingSession | null) => {
    sessionRef.current = next;
    setSessionState(next);
  }, []);

  useEffect(() => {
    if (preferenceQuery.isSuccess) {
      preferenceRef.current = preferenceQuery.data.preference;
    }
  }, [preferenceQuery.data, preferenceQuery.isSuccess]);

  const preferenceMutation = useUpdateMemoryGraphOnboardingPreference({
    mutation: {
      onSuccess: (data) => {
        preferenceRef.current = data.preference;
        queryClient.setQueryData(
          getGetMemoryGraphOnboardingPreferenceQueryKey(),
          data,
        );
      },
    },
  });

  const begin = useCallback(
    (source: MemoryGraphOnboardingSource) => {
      if (sessionRef.current) return;
      const next = { id: nextSessionIdRef.current++, source, step: 0 };
      setSession(next);
      sendAnalytics(
        source === "automatic"
          ? "memory_onboarding_started"
          : "memory_onboarding_reopened",
        source,
      );
    },
    [setSession],
  );

  useEffect(() => {
    if (autoDecisionMadeRef.current) return;
    if (preferenceQuery.isError) {
      autoDecisionMadeRef.current = true;
      return;
    }
    if (!preferenceQuery.isSuccess) return;
    autoDecisionMadeRef.current = true;
    const preference = preferenceQuery.data.preference;
    if (!preference || preference.version !== MEMORY_GRAPH_ONBOARDING_VERSION) {
      begin("automatic");
    }
  }, [
    begin,
    preferenceQuery.data,
    preferenceQuery.isError,
    preferenceQuery.isSuccess,
  ]);

  const persistSeen = useCallback(
    (status: "completed" | "skipped") => {
      if (preferenceRef.current?.version === MEMORY_GRAPH_ONBOARDING_VERSION)
        return;
      preferenceMutation.mutate({
        data: { version: MEMORY_GRAPH_ONBOARDING_VERSION, status },
      });
    },
    [preferenceMutation],
  );

  const skip = useCallback(() => {
    const active = sessionRef.current;
    if (!active) return;
    sendAnalytics("memory_onboarding_skipped", active.source, active.step + 1);
    setSession(null);
    persistSeen("skipped");
  }, [persistSeen, setSession]);

  const finish = useCallback(() => {
    const active = sessionRef.current;
    if (!active) return;
    sendAnalytics(
      "memory_onboarding_completed",
      active.source,
      active.step + 1,
    );
    setSession(null);
    persistSeen("completed");
  }, [persistSeen, setSession]);

  const setStep = useCallback(
    (step: number) => {
      const active = sessionRef.current;
      if (!active) return;
      const bounded = Math.max(
        0,
        Math.min(MEMORY_GRAPH_ONBOARDING_STEP_COUNT - 1, step),
      );
      if (bounded === active.step) return;
      setSession({ ...active, step: bounded });
    },
    [setSession],
  );

  return {
    session,
    reopen: () => begin("replay"),
    setStep,
    skip,
    finish,
    dismiss: () => setSession(null),
  };
}

interface HighlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface MemoryGraphOnboardingProps {
  controller: MemoryGraphOnboardingController;
  stageRef: RefObject<HTMLElement | null>;
  connectionTargetRef: RefObject<HTMLElement | null>;
  growthTargetRef: RefObject<HTMLElement | null>;
  reducedMotion: boolean;
}

export function MemoryGraphOnboarding({
  controller,
  stageRef,
  connectionTargetRef,
  growthTargetRef,
  reducedMotion,
}: MemoryGraphOnboardingProps) {
  const { session } = controller;
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const viewedRef = useRef(new Set<string>());
  const [highlight, setHighlight] = useState<HighlightRect | null>(null);
  const step = session ? STEPS[session.step] : null;

  useEffect(() => {
    if (!session) return;
    primaryActionRef.current?.focus({ preventScroll: true });
  }, [session?.id, session?.step]);

  useEffect(() => {
    if (!session) return;
    const key = `${session.id}:${session.step}`;
    if (viewedRef.current.has(key)) return;
    viewedRef.current.add(key);
    sendAnalytics(
      "memory_onboarding_step_viewed",
      session.source,
      session.step + 1,
    );
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        controller.dismiss();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controller, session]);

  useLayoutEffect(() => {
    if (!session || !step) {
      setHighlight(null);
      return;
    }

    const resolveTarget = () => {
      if (step.target === "memory") return stageRef.current;
      if (step.target === "connections") return connectionTargetRef.current;
      return growthTargetRef.current;
    };
    const update = () => {
      const stage = stageRef.current;
      const target = resolveTarget();
      if (!stage || !target) return setHighlight(null);
      const stageRect = stage.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const inset = step.target === "memory" ? 10 : 7;
      setHighlight({
        left: Math.max(6, targetRect.left - stageRect.left - inset),
        top: Math.max(6, targetRect.top - stageRect.top - inset),
        width: Math.min(stageRect.width - 12, targetRect.width + inset * 2),
        height: Math.min(stageRect.height - 12, targetRect.height + inset * 2),
      });
    };

    update();
    const observer = new ResizeObserver(update);
    if (stageRef.current) observer.observe(stageRef.current);
    const target = resolveTarget();
    if (target) observer.observe(target);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [connectionTargetRef, growthTargetRef, session, stageRef, step]);

  if (!session || !step) return null;

  const isFirst = session.step === 0;
  const isLast = session.step === MEMORY_GRAPH_ONBOARDING_STEP_COUNT - 1;

  return (
    <>
      {highlight && (
        <div
          aria-hidden="true"
          data-testid={`memory-onboarding-highlight-${step.target}`}
          className={`pointer-events-none absolute z-30 rounded-2xl border-2 border-cyan-300/85 shadow-[0_0_0_1px_rgba(255,255,255,0.16),0_0_28px_rgba(34,211,238,0.32)] ${
            reducedMotion ? "" : "transition-all duration-300 ease-out"
          }`}
          style={highlight as CSSProperties}
        />
      )}

      <section
        role="dialog"
        aria-modal="false"
        aria-labelledby="memory-onboarding-heading"
        aria-describedby="memory-onboarding-copy"
        className="pointer-events-auto absolute bottom-[5.75rem] left-1/2 z-40 w-[calc(100%-1rem)] max-w-sm -translate-x-1/2 rounded-2xl border border-white/15 bg-slate-950/95 p-4 text-white shadow-2xl shadow-black/60 backdrop-blur-md sm:bottom-6 sm:p-5"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" && !isFirst) {
            event.preventDefault();
            controller.setStep(session.step - 1);
          }
          if (event.key === "ArrowRight" && !isLast) {
            event.preventDefault();
            controller.setStep(session.step + 1);
          }
        }}
      >
        <p
          aria-live="polite"
          className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-200"
        >
          Step {session.step + 1} of {MEMORY_GRAPH_ONBOARDING_STEP_COUNT}
        </p>
        <h2
          id="memory-onboarding-heading"
          className="mt-2 text-xl font-bold leading-tight"
        >
          {step.heading}
        </h2>
        <p
          id="memory-onboarding-copy"
          className="mt-2 text-sm leading-6 text-white/80"
        >
          {step.copy}
        </p>
        {"hint" in step && (
          <p className="mt-2 text-xs leading-5 text-cyan-100/80">{step.hint}</p>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={controller.skip}
            className="min-h-11 rounded-lg px-3 text-sm font-semibold text-white/65 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-cyan-300"
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isFirst}
              onClick={() => controller.setStep(session.step - 1)}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-sm font-semibold outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back
            </button>
            {isLast ? (
              <button
                ref={primaryActionRef}
                type="button"
                onClick={controller.finish}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-cyan-300 px-4 text-sm font-bold text-slate-950 outline-none transition-colors hover:bg-cyan-200 focus-visible:ring-2 focus-visible:ring-white"
              >
                Finish
                <Check className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : (
              <button
                ref={primaryActionRef}
                type="button"
                onClick={() => controller.setStep(session.step + 1)}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-cyan-300 px-4 text-sm font-bold text-slate-950 outline-none transition-colors hover:bg-cyan-200 focus-visible:ring-2 focus-visible:ring-white"
              >
                Next
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
