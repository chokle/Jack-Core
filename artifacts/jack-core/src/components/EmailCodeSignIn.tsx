import { useState, type FormEvent } from "react";
import { useSignIn } from "@clerk/react/legacy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const publicDemoUrl =
  import.meta.env.VITE_PUBLIC_DEMO_URL?.trim() ||
  "https://jack-core-demo-ycf4yh.v2.appdeploy.ai/";

type ClerkError = {
  errors?: Array<{ longMessage?: string; message?: string }>;
};

function messageFrom(error: unknown): string {
  const clerkError = error as ClerkError;
  return clerkError.errors?.[0]?.longMessage
    ?? clerkError.errors?.[0]?.message
    ?? (error instanceof Error ? error.message : null)
    ?? "Sign-in could not continue. Please try again.";
}

export function EmailCodeSignIn() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startEmailCode = async (event: FormEvent) => {
    event.preventDefault();
    if (!isLoaded || !signIn || busy) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await signIn.create({ identifier: email.trim() });
      const factor = attempt.supportedFirstFactors?.find(
        (candidate) => candidate.strategy === "email_code",
      );
      if (!factor || !("emailAddressId" in factor)) {
        throw new Error("Email verification is not available for this account.");
      }
      await attempt.prepareFirstFactor({
        strategy: "email_code",
        emailAddressId: factor.emailAddressId,
      });
      setStep("code");
    } catch (caught) {
      setError(caught instanceof Error && !((caught as ClerkError).errors?.length)
        ? caught.message
        : messageFrom(caught));
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (event: FormEvent) => {
    event.preventDefault();
    if (!isLoaded || !signIn || busy) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await signIn.attemptFirstFactor({ strategy: "email_code", code: code.trim() });
      if (attempt.status !== "complete" || !attempt.createdSessionId) {
        throw new Error("That code could not complete sign-in. Please request a new code.");
      }
      await setActive({ session: attempt.createdSessionId });
      window.location.assign("/app");
    } catch (caught) {
      setError(caught instanceof Error && !((caught as ClerkError).errors?.length)
        ? caught.message
        : messageFrom(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
      <div className="space-y-6 p-7 sm:p-9">
        <div className="text-center">
          <img src="/logo.svg" alt="" className="mx-auto mb-4 h-10 w-10" />
          <h1 className="text-xl font-semibold text-foreground">Pilot participant access</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in with the account assigned to you for the controlled field pilot.
          </p>
        </div>

        <div className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm leading-6 text-muted-foreground">
          <p className="font-semibold text-foreground">Not part of the pilot?</p>
          <p>
            The real Jack environment is restricted to approved participants.
            You can still try the public demo with sample trade knowledge.
          </p>
          <a
            href={publicDemoUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex font-semibold text-primary hover:underline"
          >
            Try Jack demo
          </a>
        </div>

        {step === "email" ? (
          <form onSubmit={startEmailCode} className="space-y-4">
            <label className="block space-y-2 text-sm font-medium text-foreground">
              <span>Email address</span>
              <Input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoFocus
              />
            </label>
            <Button type="submit" className="w-full" disabled={!isLoaded || busy || !email.trim()}>
              {busy ? "Sending code…" : "Continue"}
            </Button>
          </form>
        ) : (
          <form onSubmit={verifyCode} className="space-y-4">
            <div className="text-center">
              <h2 className="font-semibold text-foreground">Check your email</h2>
              <p className="mt-1 text-sm text-muted-foreground">Enter the verification code sent to {email}.</p>
            </div>
            <label className="block space-y-2 text-sm font-medium text-foreground">
              <span>Verification code</span>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                autoFocus
              />
            </label>
            <Button type="submit" className="w-full" disabled={busy || !code.trim()}>
              {busy ? "Verifying…" : "Sign in"}
            </Button>
            <button
              type="button"
              className="w-full text-sm text-primary hover:underline"
              onClick={() => { setStep("email"); setCode(""); setError(null); }}
              disabled={busy}
            >
              Use another email
            </button>
          </form>
        )}

        {error && (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="border-t border-border bg-muted/20 px-6 py-4 text-center text-sm text-muted-foreground">
        Need a pilot account? Contact your Torch pilot lead for an assigned access link.
      </div>
    </div>
  );
}
