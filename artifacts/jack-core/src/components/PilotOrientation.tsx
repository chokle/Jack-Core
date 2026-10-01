import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { JackView } from "./JackShell";
import { JackPet } from "./JackPet";

interface PilotOrientationProps {
  userId?: string;
  activeView: JackView;
  onOpenOrientation: () => void;
  onOpenRadar: () => void;
  onOpenCloseout: () => void;
  onFinish: () => void;
  onStepChange?: (step: number) => void;
  canOpenCloseout: boolean;
}

export function PilotOrientation({
  userId,
  activeView,
  onOpenOrientation,
  onOpenRadar,
  onOpenCloseout,
  onFinish,
  onStepChange,
  canOpenCloseout,
}: PilotOrientationProps) {
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
  const [tourActive, setTourActive] = useState(true);
  const steps = [
    {
      key: "meet-jack",
      title: "Meet Jack",
      destination: "orientation" as JackView,
      destinationName: "Start here",
      description:
        "Ask Jack what Torch does, how sources work, or what you need to know before starting.",
      guidance:
        "Hey, I'm Jack. I'll show you where field information lives, then walk you through an end-of-shift closeout.",
      action: null,
      nextLabel: "Next",
    },
    {
      key: "site-radar",
      title: "Site Radar",
      destination: "dashboard" as JackView,
      destinationName: "Dashboard",
      description:
        "Dashboard is your site workspace. Connected sites and recent scans appear here when your account has access. If none are connected, Jack will say so.",
      guidance:
        "You’re on Dashboard. Site Radar lives in the site workspace outlined above. Next I’ll take you to Closeout.",
      action: null,
      nextLabel: canOpenCloseout ? "Next" : "Finish guide",
    },
    {
      key: "closeout",
      title: "End-of-shift Closeout",
      destination: "closeout" as JackView,
      destinationName: "Closeout",
      description:
        "This is where you leave your shift handover. Work date and shift are at the top; answer the questions below, then save a draft or submit when you’re ready.",
      guidance:
        "Closeout is in the menu and the real form is open. Nothing is submitted by this tour. You choose when to save or submit your notes.",
      action: null,
      nextLabel: "Finish guide",
    },
  ];
  const totalSteps = canOpenCloseout ? steps.length : steps.length - 1;
  const currentStepIndex = Math.min(activeStep, totalSteps - 1);
  const step = steps[currentStepIndex];
  const atDestination = activeView === step.destination;

  useEffect(() => {
    if (activeStep >= totalSteps) setActiveStep(totalSteps - 1);
  }, [activeStep, totalSteps]);

  useEffect(() => {
    onStepChange?.(currentStepIndex);
  }, [currentStepIndex, onStepChange]);

  useEffect(() => {
    if (!progressKey || !tourActive) return;
    try {
      window.sessionStorage.setItem(progressKey, String(activeStep));
    } catch {
      // The guide still works when browser storage is unavailable.
    }
  }, [activeStep, progressKey, tourActive]);

  useEffect(() => {
    if (activeView === "orientation") setTourActive(true);
  }, [activeView]);

  const finishGuide = () => {
    setTourActive(false);
    setActiveStep(0);
    onStepChange?.(0);
    if (progressKey) {
      try {
        window.sessionStorage.removeItem(progressKey);
      } catch {
        // Finishing does not depend on browser storage.
      }
    }
    onFinish();
  };

  const navigateToStep = (nextStep: number) => {
    setActiveStep(nextStep);
    if (nextStep === 0) onOpenOrientation();
    if (nextStep === 1) onOpenRadar();
    if (nextStep === 2 && canOpenCloseout) onOpenCloseout();
  };

  const advance = () => {
    if (currentStepIndex === 0) {
      navigateToStep(1);
      return;
    }
    if (currentStepIndex === 1 && canOpenCloseout) {
      navigateToStep(2);
      return;
    }
    finishGuide();
  };

  const goBack = () => {
    if (currentStepIndex === 2) {
      navigateToStep(1);
      return;
    }
    if (currentStepIndex === 1) navigateToStep(0);
  };

  if (!tourActive) return null;
  if (currentStepIndex === 0 && activeView !== "orientation") return null;

  const stepCount = (stepIndex: number) => (
    <div
      className="flex gap-2"
      aria-label={`Step ${stepIndex + 1} of ${totalSteps}`}
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={totalSteps}
      aria-valuenow={stepIndex + 1}
    >
      {steps.slice(0, totalSteps).map((item, index) => (
        <span
          key={item.key}
          className={`h-1.5 flex-1 rounded-full ${index <= stepIndex ? "bg-primary" : "bg-muted"}`}
        />
      ))}
    </div>
  );

  const guideCard = (
    <section
      aria-live="polite"
      className="rounded-xl border border-cyan-400 bg-background/95 p-4 shadow-xl backdrop-blur"
      data-tour-step={step.key}
      role="note"
    >
      <div className="flex items-start gap-3">
        <JackPet
          key={`${step.key}-${activeView}`}
          activity="ALERT"
          size={52}
          label="Jack guiding this step"
        />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-primary">
            Step {currentStepIndex + 1} · {step.destinationName}
          </p>
          <h2 className="mt-1 font-semibold">{step.title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {atDestination
              ? step.description
              : `Next takes you to ${step.destinationName}. ${step.guidance}`}
          </p>
        </div>
      </div>
      <div className="mt-4">{stepCount(currentStepIndex)}</div>
      <div className="mt-4 flex justify-end gap-3">
        {currentStepIndex > 0 && (
          <Button variant="ghost" onClick={goBack}>
            Back
          </Button>
        )}
        <Button onClick={advance}>
          {atDestination ? step.nextLabel : `Go to ${step.destinationName}`}
        </Button>
      </div>
    </section>
  );

  if (activeStep > 0 && activeView !== "orientation") {
    return (
      <div
        className="pointer-events-none fixed inset-x-3 z-[80] flex justify-center sm:right-6 sm:left-auto sm:justify-end"
        style={{ bottom: "calc(var(--jack-pill-height, 0px) + 1rem)" }}
      >
        <div className="pointer-events-auto w-full max-w-md">{guideCard}</div>
      </div>
    );
  }

  return (
    <main className="h-full overflow-y-auto p-4 pb-24 sm:p-8">
      <div className="mx-auto max-w-2xl space-y-6 rounded-2xl border border-border bg-card/95 p-5 shadow-lg sm:p-8">
        <header className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Jack’s quick guide
          </p>
          <h1 className="text-2xl font-bold">Welcome to Jack</h1>
          <p className="text-sm text-muted-foreground">
            Jack will take you into the real workspace and show you where the
            next actions happen.
          </p>
        </header>
        {stepCount(currentStepIndex)}
        <section
          className="rounded-xl border border-cyan-400 bg-primary/10 p-4"
          data-tour-step={step.key}
        >
          <h2 className="font-semibold">{step.title}</h2>
          <p className="mt-3 text-sm text-muted-foreground">
            {step.description}
          </p>
          {step.action}
          <div className="relative mt-5 rounded-xl border border-primary/30 bg-background p-4 shadow-md">
            <div className="flex gap-3">
              <JackPet
                key={`${step.key}-${activeView}`}
                activity="ONLINE"
                size={36}
                label="Jack"
              />
              <p className="text-sm leading-relaxed">{step.guidance}</p>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              {currentStepIndex === 0 && (
                <Button onClick={finishGuide} variant="ghost">
                  Skip guide
                </Button>
              )}
              {currentStepIndex > 0 && (
                <Button onClick={goBack} variant="ghost">
                  Back
                </Button>
              )}
              <Button
                className="whitespace-normal text-center"
                onClick={advance}
              >
                {atDestination
                  ? step.nextLabel
                  : `Go to ${step.destinationName}`}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
