import { useEffect, useRef, useState, type FormEvent } from "react";
import { SignIn, useAuth } from "@clerk/react";
import { useSignIn } from "@clerk/react/legacy";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const appPath = `${basePath}/app`;
type Attempt = { status: string | null; createdSessionId: string | null };

function messageFrom(error: unknown): string {
  const clerkError = error as {
    errors?: Array<{ longMessage?: string; message?: string }>;
  };
  return (
    clerkError?.errors?.[0]?.longMessage ??
    clerkError?.errors?.[0]?.message ??
    (error instanceof Error
      ? error.message
      : "Sign-in could not continue. Please try again.")
  );
}

export function EmailCodeSignIn() {
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { isLoaded: signInLoaded, signIn, setActive } = useSignIn();
  const [, setLocation] = useLocation();
  const [invited] = useState(() =>
    new URLSearchParams(window.location.search).has("__clerk_ticket"),
  );
  const [step, setStep] = useState<"email" | "code" | "security">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!invited) return;
    // Accounts are provisioned by the invitation service. The ticket is never
    // consumed as signup proof: email OTP verifies the account before the server
    // accepts its current, unexpired Jack membership invitation.
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("__clerk_ticket");
      url.searchParams.delete("__clerk_status");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    } catch {
      // Restricted browser history must not block verified email sign-in.
    }
  }, [invited]);

  useEffect(() => {
    if (authLoaded && isSignedIn) setLocation("/app", { replace: true });
  }, [authLoaded, isSignedIn, setLocation]);

  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function finish(attempt: Attempt) {
    if (attempt.status === "complete" && attempt.createdSessionId) {
      if (!setActive)
        throw new Error(
          "Your secure session is still loading. Please try again.",
        );
      await setActive({ session: attempt.createdSessionId });
      window.location.assign(appPath);
    } else if (
      [
        "needs_second_factor",
        "needs_client_trust",
        "needs_new_password",
      ].includes(attempt.status ?? "")
    ) {
      // Resume actual sign-in challenges in Clerk's supported security UI.
      setStep("security");
    } else {
      throw new Error(
        "Sign-in is incomplete. Check your code or request a new one.",
      );
    }
  }

  function start(event: FormEvent) {
    event.preventDefault();
    if (!signInLoaded || !signIn) return;
    void run(async () => {
      const attempt = await signIn.create({
        identifier: email.trim().toLowerCase(),
      });
      const factor = attempt.supportedFirstFactors?.find(
        (candidate) => candidate.strategy === "email_code",
      );
      if (!factor || !("emailAddressId" in factor)) {
        setStep("security");
        return;
      }
      await attempt.prepareFirstFactor({
        strategy: "email_code",
        emailAddressId: factor.emailAddressId,
      });
      setCode("");
      setStep("code");
    });
  }

  function verify(event: FormEvent) {
    event.preventDefault();
    if (!signIn) return;
    void run(async () =>
      finish(
        await signIn.attemptFirstFactor({
          strategy: "email_code",
          code: code.trim(),
        }),
      ),
    );
  }

  if (!authLoaded || isSignedIn) return null;
  if (step === "security")
    return (
      <SignIn
        routing="hash"
        initialValues={{ emailAddress: email.trim() }}
        forceRedirectUrl={appPath}
        signUpUrl={`${basePath}/sign-up`}
      />
    );

  return (
    <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
      <div className="space-y-6 p-7 sm:p-9">
        <div className="text-center">
          <img
            src={`${basePath}/logo.svg`}
            alt=""
            className="mx-auto mb-4 h-10 w-10"
          />
          <h1 className="text-xl font-semibold text-foreground">
            {invited ? "You're invited to Jack" : "Sign in to Jack"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {step === "code"
              ? "Enter the code from your email to open Jack."
              : invited
                ? "Enter the email address that received your invitation. We'll send you a code to open Jack."
                : "Use your email address. We'll send you a sign-in code."}
          </p>
        </div>
        {step === "email" ? (
          <form onSubmit={start} className="space-y-4">
            <label className="block space-y-2 text-sm font-medium">
              <span>Email address</span>
              <Input
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoFocus
                disabled={busy}
              />
            </label>
            <Button
              type="submit"
              className="w-full"
              disabled={busy || !signInLoaded || !email.trim()}
            >
              {busy ? "Sending..." : "Send verification code"}
            </Button>
            {!invited && (
              <p className="text-sm text-muted-foreground">
                New to Jack? Open the invitation sent to your email.
              </p>
            )}
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Check your email at{" "}
              <span className="break-all font-medium text-foreground">
                {email}
              </span>
              .
            </p>
            <label className="block space-y-2 text-sm font-medium">
              <span>Verification code</span>
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(event) =>
                  setCode(event.target.value.replace(/\D/g, ""))
                }
                required
                autoFocus
                disabled={busy}
              />
            </label>
            <Button
              type="submit"
              className="w-full"
              disabled={busy || code.length !== 6}
            >
              {busy ? "Verifying..." : "Sign in"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              disabled={busy}
              onClick={() => {
                setStep("email");
                setCode("");
                setError(null);
              }}
            >
              Change email or request a new code
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
