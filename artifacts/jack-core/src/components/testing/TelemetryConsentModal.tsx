import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface TelemetryConsentChoices {
  telemetry: "granted" | "declined";
  screen: "granted" | "declined";
  microphone: "granted" | "declined";
}

interface TelemetryConsentModalProps {
  open: boolean;
  saving?: boolean;
  onSave: (choices: TelemetryConsentChoices) => void;
  onClose: () => void;
}

export function TelemetryConsentModal({
  open,
  saving = false,
  onSave,
  onClose,
}: TelemetryConsentModalProps) {
  const [telemetry, setTelemetry] = useState(false);
  const [screen, setScreen] = useState(false);
  const [microphone, setMicrophone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTelemetry(false);
    setScreen(false);
    setMicrophone(false);
  }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && !saving && onClose()}>
      <AlertDialogContent data-testid="telemetry-consent-modal" className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Optional Jack pilot telemetry</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-left text-sm">
              <p>
                Jack can collect minimized activity events about onboarding, feature use,
                completed workflows, and errors to evaluate this pilot. Pilot administrators
                for your organization can see these reports. Torch platform superadmins can
                access them only through an explicitly configured, audited role.
              </p>
              <p>
                Activity events are kept for 90 days. They never include names, emails,
                questions, answers, passwords, tokens, keystrokes, clipboard contents, or
                full device fingerprints. Ask Jack conversations are stored separately as
                product history while your account is active and are deleted with the
                conversation or account.
              </p>
              <p>
                Screen recordings are optional and kept for 30 days. Microphone capture is a
                separate option and is never requested automatically. Recording media stays
                private and is accessible only to explicitly authorized Torch platform staff;
                pilot reports show recording status, not the media. You can use Jack and
                participate in the pilot without choosing any of these options.
              </p>
              <p>
                You can withdraw in Account &amp; privacy at any time. Future collection and
                active recording stop immediately; attributable telemetry already collected
                is scheduled for deletion within 30 days unless legally required.
              </p>
              <label className="flex gap-3 rounded-lg border border-border p-3">
                <input
                  type="checkbox"
                  checked={telemetry}
                  onChange={(event) => {
                    const next = event.target.checked;
                    setTelemetry(next);
                    if (!next) {
                      setScreen(false);
                      setMicrophone(false);
                    }
                  }}
                />
                <span>
                  <strong>Allow minimized activity telemetry</strong>
                  <span className="block text-muted-foreground">
                    Required only to create an optional telemetry session, never to access Jack.
                  </span>
                </span>
              </label>
              <label className="flex gap-3 rounded-lg border border-border p-3">
                <input
                  type="checkbox"
                  checked={screen}
                  disabled={!telemetry}
                  onChange={(event) => {
                    const next = event.target.checked;
                    setScreen(next);
                    if (!next) setMicrophone(false);
                  }}
                />
                <span>
                  <strong>Allow optional screen recording</strong>
                  <span className="block text-muted-foreground">
                    A separate browser share dialog appears only after you click Start recording.
                  </span>
                </span>
              </label>
              <label className="flex gap-3 rounded-lg border border-border p-3">
                <input
                  type="checkbox"
                  checked={microphone}
                  disabled={!screen}
                  onChange={(event) => setMicrophone(event.target.checked)}
                />
                <span>
                  <strong>Allow optional microphone recording</strong>
                  <span className="block text-muted-foreground">
                    Jack asks for microphone permission only if this is selected and you later
                    start a recording.
                  </span>
                </span>
              </label>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={saving}
            onClick={() =>
              onSave({
                telemetry: "declined",
                screen: "declined",
                microphone: "declined",
              })
            }
          >
            Continue without telemetry
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={saving}
            onClick={(event) => {
              event.preventDefault();
              onSave({
                telemetry: telemetry ? "granted" : "declined",
                screen: screen ? "granted" : "declined",
                microphone: microphone ? "granted" : "declined",
              });
            }}
          >
            {saving ? "Saving…" : "Save choices"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
