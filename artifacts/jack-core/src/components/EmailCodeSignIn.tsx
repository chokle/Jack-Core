import { useState, type FormEvent } from "react";
import { useSignIn } from "@clerk/react/legacy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ClerkError = {
  errors?: Array<{ longMessage?: string; message?: string }>;
};

function messageFrom(error: unknown): string {
  const clerkError = error as ClerkError;
  return clerkError.errors?.[0]?.longMessage
    ?? clerkError.errors?.[0]?.message
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

  const signInWithGoogle = async () => {
    if (!isLoaded || !signIn || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: `${window.location.origin}/sign-in/sso-callback`,
        redirectUrlComplete: `${window.location.origin}/app`,
      });
    } catch (caught) {
      setError(messageFrom(caught));
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
      <div className="space-y-6 p-7 sm:p-9">
        <div className="text-center">
          <img src="/logo.svg" alt="" className="mx-auto mb-4 h-10 w-10" />
          <h1 className="text-xl font-semibold text-foreground">Welcome back</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to Jack — your trade intelligence engine</p>
        </div>

        {step === "email" ? (
          <>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={signInWithGoogle}
              disabled={!isLoaded || busy}
            >
              Continue with Google
            </Button>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              <span>or use an email code</span>
              <span className="h-px flex-1 bg-border" />
            </div>
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
          </>
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
        Don&apos;t have an account? <a href="/sign-up" className="font-medium text-primary hover:underline">Sign up</a>
      </div>
    </div>
  );
}
