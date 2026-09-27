import { Button } from "@/components/ui/button";

interface PilotOrientationProps {
  onAskJack: (prompt: string) => void;
  onOpenRadar: () => void;
  onOpenCloseout: () => void;
  onFinish: () => void;
  canOpenCloseout: boolean;
}

export function PilotOrientation({
  onAskJack,
  onOpenRadar,
  onOpenCloseout,
  onFinish,
  canOpenCloseout,
}: PilotOrientationProps) {
  return (
    <main className="h-full overflow-y-auto p-4 pb-24 sm:p-8">
      <div className="mx-auto max-w-2xl space-y-6 rounded-2xl border border-border bg-card/95 p-5 shadow-lg sm:p-8">
        <header className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Start here
          </p>
          <h1 className="text-2xl font-bold">Welcome to Jack</h1>
          <p className="text-sm text-muted-foreground">
            Torch preserves skilled-trades knowledge and makes it useful in the
            field. Jack helps you find answers, understand the site information
            you have access to, and hand over what happened on your shift.
          </p>
          <p className="text-sm text-muted-foreground">
            You can use Ask Jack at any time. This guide is optional and stays
            in the menu if you want to return.
          </p>
        </header>

        <ol className="space-y-4">
          <li className="rounded-xl border border-border p-4">
            <h2 className="font-semibold">1. Meet Jack</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Ask what Torch does, how Jack uses sources, or what you need to
              know before starting.
            </p>
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
          </li>
          <li className="rounded-xl border border-border p-4">
            <h2 className="font-semibold">2. Get familiar with the site</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Site Radar shows your connected site and recent scans when your
              account has access. If no site is connected, it says so.
            </p>
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
          </li>
          <li className="rounded-xl border border-border p-4">
            <h2 className="font-semibold">3. Hand over your shift</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              If you are enrolled in an active pilot, use Closeout to save a
              draft or submit your end-of-shift notes. You can add a dated
              correction later if something was missed.
            </p>
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
          </li>
        </ol>

        <Button variant="ghost" onClick={onFinish}>
          Continue to Living Memory
        </Button>
      </div>
    </main>
  );
}
