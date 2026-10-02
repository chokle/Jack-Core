import { useEffect, useRef, useState } from "react";
import { TourSpotlight } from "./TourSpotlight";
import { Button } from "@/components/ui/button";

interface PilotOrientationProps {
  userId?: string;
  surface?: "orientation" | "dashboard" | "closeout" | "source";
  chatOpen?: boolean;
  onReturnToGuide?: () => void;
  onAskJack: (prompt: string) => void;
  onOpenDashboard: () => void;
  onOpenCloseout: () => void;
  onFinish: () => void;
  canOpenCloseout: boolean;
}

export function PilotOrientation({
  userId,
  surface = "orientation",
  chatOpen = false,
  onReturnToGuide,
  onAskJack,
  onOpenDashboard,
  onOpenCloseout,
  onFinish,
  canOpenCloseout,
}: PilotOrientationProps) {
  const coachRef = useRef<HTMLElement>(null);
  const progressKey = userId ? `jack-orientation-step-v2:${userId}` : null;
  const [activeStep, setActiveStep] = useState(() => {
    if (!progressKey || typeof window === "undefined") return 0;
    try {
      const saved = Number(window.sessionStorage.getItem(progressKey));
      return Number.isInteger(saved) && saved >= 0 && saved < 3 ? saved : 0;
    } catch {
      return 0;
    }
  });
  useEffect(() => {
    const coach = coachRef.current;
    if (!coach) return;
    const update = () =>
      document.documentElement.style.setProperty(
        "--jack-tour-height",
        `${coach.getBoundingClientRect().height + 32}px`,
      );
    update();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(coach);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      document.documentElement.style.removeProperty("--jack-tour-height");
    };
  }, [surface, chatOpen]);

  const steps = [
    {
      title: "Meet Jack",
      description:
        "Ask what Torch does, how Jack uses sources, or what you need to know before starting.",
      guidance:
        "Hey, I'm Jack. I'll show you how to find answers, check site information, and hand over a shift. We'll take it one step at a time.",
      action: (
        <Button
          className="mt-3"
          onClick={() =>
            onAskJack(
              "What is Torch, what can you help me with here, and how do you know when an answer is reliable?",
            )
          }
        >
          Ask Jack
        </Button>
      ),
      nextLabel: "Next",
    },
    {
      title: "Get familiar with the site",
      description:
        "Dashboard brings your connected site, recent scans, and field context into one workspace when your account has access. If no site is connected, it says so.",
      guidance:
        "This is your site workspace in Dashboard. It only shows sites and scans your account is allowed to see. If nothing is connected yet, I'll tell you clearly.",
      action: (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" onClick={onOpenDashboard}>
            Open Dashboard
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              onAskJack(
                "Help me prepare for my site orientation. What should I check before starting, and what site-specific details do you need from me? Please do not assume you have site procedures or live site data that you have not been given.",
              )
            }
          >
            Ask Jack about the site
          </Button>
        </div>
      ),
      nextLabel: "Next",
    },
    {
      title: "Hand over your shift",
      description:
        "If you are enrolled in an active pilot, use Closeout to save a draft or submit your end-of-shift notes. You can add a dated correction later if something was missed.",
      guidance:
        "When you're enrolled in an active pilot, Closeout is where you leave shift notes. You can save a draft and add a dated correction later if you missed something.",
      action: (
        <div className="mt-3 flex flex-wrap gap-2">
          {canOpenCloseout && (
            <Button variant="outline" onClick={onOpenCloseout}>
              Open Closeout
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() =>
              onAskJack(
                "Help me prepare a clear end-of-shift handover. What should I note before I complete Closeout?",
              )
            }
          >
            Ask Jack about handover
          </Button>
        </div>
      ),
      nextLabel: "Finish guide",
    },
  ];

  useEffect(() => {
    if (!progressKey) return;
    try {
      window.sessionStorage.setItem(progressKey, String(activeStep));
    } catch {
      // The tour still works when browser storage is unavailable.
    }
  }, [activeStep, progressKey]);

  const finishGuide = () => {
    if (progressKey) {
      try {
        window.sessionStorage.removeItem(progressKey);
      } catch {
        // Finishing the guide does not depend on browser storage.
      }
    }
    onFinish();
  };

  const advance = () => {
    if (activeStep === steps.length - 1) {
      finishGuide();
      return;
    }
    setActiveStep((step) => Math.min(step + 1, steps.length - 1));
    if (activeStep === 0) onOpenDashboard();
    else if (canOpenCloseout) onOpenCloseout();
    else onReturnToGuide?.();
  };

  const goBack = () => {
    const previous = Math.max(activeStep - 1, 0);
    setActiveStep(previous);
    if (previous === 0) onReturnToGuide?.();
    else onOpenDashboard();
  };

  if (chatOpen) return null;
  if (surface !== "orientation") {
    return (
      <>
        <TourSpotlight
          targets={
            surface === "dashboard"
              ? '[data-tour-target="site-spatial-state"], [data-tour-coach]'
              : surface === "closeout"
                ? '[data-tour-target="closeout-notes"], [data-tour-coach]'
                : "[data-tour-source], [data-tour-coach]"
          }
        />
        <aside
          ref={coachRef}
          data-tour-coach
          aria-label="Jack onboarding guide"
          className="fixed bottom-4 right-4 z-[70] max-h-[40dvh] w-[calc(100%-2rem)] max-w-sm overflow-y-auto rounded-xl border border-cyan-400 bg-card p-4 shadow-xl"
        >
          <p className="text-xs font-semibold text-primary">
            Step {activeStep + 1} of 3
          </p>
          <h2 className="mt-1 font-semibold">{steps[activeStep].title}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {steps[activeStep].guidance}
          </p>
          {surface === "closeout" && (
            <p className="mt-2 text-sm">
              Try the highlighted notes fields. You do not need to submit a
              closeout to finish this guide.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {activeStep > 0 && (
              <Button variant="ghost" onClick={goBack}>
                Back
              </Button>
            )}
            <Button onClick={advance}>{steps[activeStep].nextLabel}</Button>
            <Button variant="outline" onClick={onReturnToGuide}>
              Return to guide
            </Button>
          </div>
        </aside>
      </>
    );
  }

  return (
    <>
      <TourSpotlight targets="[data-tour-active-step]" />
      <main className="h-full min-w-0 flex-1 overflow-y-auto p-4 pb-24 sm:p-8">
        <div className="mx-auto max-w-2xl space-y-6 rounded-2xl border border-border bg-card/95 p-5 shadow-lg sm:p-8">
          <header className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Jack's quick guide
            </p>
            <h1 className="text-2xl font-bold">Welcome to Jack</h1>
            <p className="text-sm text-muted-foreground">
              Torch preserves skilled-trades knowledge and makes it useful in
              the field. Follow each highlighted step at your own pace.
            </p>
          </header>

          <div
            aria-label={`Step ${activeStep + 1} of ${steps.length}`}
            className="flex gap-2"
            role="progressbar"
            aria-valuemax={steps.length}
            aria-valuemin={1}
            aria-valuenow={activeStep + 1}
          >
            {steps.map((step, index) => (
              <div
                aria-hidden="true"
                className={`h-1.5 flex-1 rounded-full ${index <= activeStep ? "bg-primary" : "bg-muted"}`}
                key={step.title}
              />
            ))}
          </div>

          <ol aria-label="Jack onboarding steps" className="space-y-3">
            {steps.map((step, index) => {
              const isActive = index === activeStep;
              const isComplete = index < activeStep;
              return (
                <li
                  data-tour-active-step={isActive ? "" : undefined}
                  aria-current={isActive ? "step" : undefined}
                  aria-disabled={!isActive}
                  className={`rounded-xl border p-4 transition-colors ${
                    isActive
                      ? "border-cyan-400 bg-primary/10 ring-2 ring-cyan-400/30"
                      : "border-border bg-background/40 opacity-60"
                  }`}
                  key={step.title}
                >
                  <h2 className="flex items-center gap-3 font-semibold">
                    <span
                      aria-hidden="true"
                      className={`flex size-7 shrink-0 items-center justify-center rounded-full text-sm ${isActive || isComplete ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                    >
                      {isComplete ? "✓" : index + 1}
                    </span>
                    {step.title}
                    {isComplete && (
                      <span className="ml-auto text-xs font-medium text-primary">
                        Done
                      </span>
                    )}
                    {!isActive && !isComplete && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        Up next
                      </span>
                    )}
                  </h2>
                  {isActive && (
                    <>
                      <p className="mt-3 text-sm text-muted-foreground">
                        {step.description}
                      </p>
                      {step.action}
                      <div
                        aria-live="polite"
                        className="relative mt-5 rounded-xl border border-primary/30 bg-background p-4 shadow-md"
                        role="note"
                      >
                        <span className="absolute -top-2 left-6 size-4 rotate-45 border-l border-t border-primary/30 bg-background" />
                        <div className="flex gap-3">
                          <p className="text-sm leading-relaxed">
                            {step.guidance}
                          </p>
                        </div>
                        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                          {activeStep > 0 && (
                            <Button
                              className="w-full sm:w-auto"
                              onClick={goBack}
                              variant="ghost"
                            >
                              Back
                            </Button>
                          )}
                          <div className="flex w-full flex-col items-center sm:w-auto">
                            <img
                              alt="Jack mascot guides you to the next step"
                              className="h-[4.5rem] w-auto object-contain motion-safe:animate-bounce"
                              height="82"
                              src="/jack-onboarding-mascot.webp"
                              width="77"
                            />
                            <Button
                              className="w-full whitespace-normal text-center sm:w-auto"
                              onClick={advance}
                            >
                              {step.nextLabel}
                            </Button>
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </main>
    </>
  );
}
