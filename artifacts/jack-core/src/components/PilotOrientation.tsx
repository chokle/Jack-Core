import { useState } from "react";
import { Button } from "@/components/ui/button";

interface PilotOrientationProps {
  onAskJack: (prompt: string) => void;
  onOpenRadar: () => void;
  onOpenCloseout: () => void;
  onFinish: () => void;
  canOpenCloseout: boolean;
}

function JackHand() {
  return (
    <svg
      aria-label="Jack's hand pointing to Next"
      className="motion-safe:animate-bounce"
      fill="none"
      height="42"
      role="img"
      viewBox="0 0 56 64"
      width="38"
    >
      <g transform="rotate(180 28 32)">
        <path
          d="M24 36V11a5 5 0 0 1 10 0v20l4-7a5 5 0 0 1 9 4l-4 11 3-3a5 5 0 0 1 8 6L44 55a12 12 0 0 1-10 5H24a13 13 0 0 1-13-13V36a5 5 0 0 1 9-3l4 5Z"
          fill="white"
          stroke="#183b39"
          strokeLinejoin="round"
          strokeWidth="3"
        />
        <path
          d="M13 47h11v9h-4a9 9 0 0 1-7-4v-5Z"
          fill="#55d6be"
          stroke="#183b39"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </g>
    </svg>
  );
}

export function PilotOrientation({
  onAskJack,
  onOpenRadar,
  onOpenCloseout,
  onFinish,
  canOpenCloseout,
}: PilotOrientationProps) {
  const [activeStep, setActiveStep] = useState(0);
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
      nextLabel: "Next: get familiar with the site",
    },
    {
      title: "Get familiar with the site",
      description:
        "Site Radar shows your connected site and recent scans when your account has access. If no site is connected, it says so.",
      guidance:
        "This is Site Radar. It only shows sites and scans your account is allowed to see. If nothing is connected yet, I'll tell you clearly.",
      action: (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" onClick={onOpenRadar}>
            Open Site Radar
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
      nextLabel: "Next: hand over your shift",
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

  const advance = () => {
    if (activeStep === steps.length - 1) {
      onFinish();
      return;
    }
    setActiveStep((step) => Math.min(step + 1, steps.length - 1));
  };

  return (
    <main className="h-full overflow-y-auto p-4 pb-24 sm:p-8">
      <div className="mx-auto max-w-2xl space-y-6 rounded-2xl border border-border bg-card/95 p-5 shadow-lg sm:p-8">
        <header className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Jack's quick guide
          </p>
          <h1 className="text-2xl font-bold">Welcome to Jack</h1>
          <p className="text-sm text-muted-foreground">
            Torch preserves skilled-trades knowledge and makes it useful in the
            field. Follow each highlighted step at your own pace.
          </p>
          <Button className="px-0" variant="link" onClick={onFinish}>
            Skip guide
          </Button>
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
                aria-current={isActive ? "step" : undefined}
                aria-disabled={!isActive}
                className={`rounded-xl border p-4 transition-colors ${
                  isActive
                    ? "border-primary bg-primary/10 ring-2 ring-primary/30"
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
                        <span
                          aria-hidden="true"
                          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground"
                        >
                          J
                        </span>
                        <p className="text-sm leading-relaxed">
                          {step.guidance}
                        </p>
                      </div>
                      <div className="mt-5 flex items-end justify-between gap-3">
                        <Button
                          disabled={activeStep === 0}
                          onClick={() =>
                            setActiveStep((value) => Math.max(value - 1, 0))
                          }
                          variant="ghost"
                        >
                          Back
                        </Button>
                        <div className="flex flex-col items-center">
                          <JackHand />
                          <Button onClick={advance}>{step.nextLabel}</Button>
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
  );
}
