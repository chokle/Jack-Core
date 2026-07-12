import { LockKeyhole, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";

interface UserTestingGateProps {
  open: boolean;
  onStart: () => void;
}

/**
 * Restricted-mode wall shown only after a tester declines the initial consent
 * prompt. It does not request permissions itself; it only reopens the consent
 * modal so recording still starts only after explicit approval.
 */
export function UserTestingGate({ open, onStart }: UserTestingGateProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-background/82 px-4 backdrop-blur-md"
      data-testid="user-testing-restricted-gate"
    >
      <div className="w-full max-w-lg rounded-2xl border border-primary/35 bg-card/95 p-5 shadow-[0_0_45px_rgba(255,100,0,0.22)]">
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <LockKeyhole className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.18em] text-primary">
              User testing mode
            </p>
            <h2 className="mt-1 text-xl font-bold text-foreground">
              Start the test for the full Jack experience
            </h2>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Click Start User Test so we can understand how people naturally use Jack.
          You're not being tested. Jack is. The full app unlocks after you start
          or if recording is unavailable in this browser.
        </p>
        <div className="mt-5 rounded-xl border border-primary/25 bg-primary/10 p-3 text-sm text-primary">
          The Start User Test button is highlighted in the sidebar. You can also start here.
        </div>
        <Button
          type="button"
          onClick={onStart}
          className="mt-5 w-full gap-2"
          data-testid="user-testing-gate-start"
        >
          <Radio className="h-4 w-4" />
          Start User Test
        </Button>
      </div>
    </div>
  );
}
