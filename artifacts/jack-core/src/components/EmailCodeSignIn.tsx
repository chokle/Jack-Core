import { useState, type FormEvent } from "react";
import { useSignIn } from "@clerk/react/legacy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ClerkError = {
  errors?: Array<{ longMessage?: string; message?: string }>;
};

type SignInAttempt = {
  supportedFirstFactors?: Array<{ strategy: string; emailAddressId?: string }>;
  supportedSecondFactors?: Array<{ strategy: string }>;
  prepareFirstFactor: (input: {
    strategy: "email_code";
    emailAddressId: string;
  }) => Promise<unknown>;
};

type SignInAttemptStatus =
  | "complete"
  | "needs_second_factor"
  | "needs_client_trust"
  | "needs_new_password"
  | (string & {});

type SignInAttemptResult = {
  status?: SignInAttemptStatus | null;
  createdSessionId?: string | null;
  supportedSecondFactors?: Array<{ strategy: string }>;
};

function messageFrom(error: unknown): string {
  const clerkError = error as ClerkError;
  return (
    clerkError.errors?.[0]?.longMessage ??
    clerkError.errors?.[0]?.message ??
    (error instanceof Error ? error.message : null) ??
    "Sign-in could not continue. Please try again."
  );
}

function formatVerificationContinuation(
  attempt: SignInAttemptResult,
): string | null {
  if (!attempt.status) return null;

  const supportedSecondFactors = attempt.supportedSecondFactors ?? [];
  const hasStrategy = (strategy: string) =>
    supportedSecondFactors.some((factor) => factor.strategy === strategy);

  switch (attempt.status) {
    case "needs_second_factor":
      if (hasStrategy("totp")) {
        return "Password was verified, but two-factor verification is still required. Please enter your TOTP code to continue.";
      }
      if (hasStrategy("phone_code")) {
        return "Password was verified, but SMS two-factor verification is still required. Please continue with the phone code flow.";
      }
      if (hasStrategy("email_code")) {
        return "Password was verified, but email-code two-factor verification is still required. Please continue with the code flow.";
      }
      return "Password was verified, but a second factor is still required.";

    case "needs_client_trust":
      if (hasStrategy("email_code")) {
        return "Password was verified, but Device Trust requires email-code verification. Please complete the code challenge sent to this account.";
      }
      if (hasStrategy("phone_code")) {
        return "Password was verified, but Device Trust requires phone-code verification. Please complete the phone verification challenge.";
      }
      if (hasStrategy("email_link")) {
        return "Password was verified, but Device Trust requires an email-link verification. Please continue with the email link challenge.";
      }
      return "Password was verified, but Device Trust verification is required.";

    case "needs_new_password":
      return "Password was verified, but a new password is required for this account.";

    default:
      return `Sign-in requires an additional step: ${attempt.status}.`;
  }
}

export function EmailCodeSignIn() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const [step, setStep] = useState<"email" | "password" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [hasEmailCode, setHasEmailCode] = useState(false);
  const [emailAddressId, setEmailAddressId] = useState<string | null>(null);
  const [signInAttempt, setSignInAttempt] = useState<SignInAttempt | null>(
    null,
  );

  const startSignIn = async (event: FormEvent) => {
    event.preventDefault();
    if (!isLoaded || !signIn || busy) return;
    setBusy(true);
    setError(null);
    setCode("");
    setPassword("");
    setSignInAttempt(null);
    setHasPassword(false);
    setHasEmailCode(false);
    setEmailAddressId(null);
    try {
      const attempt = await signIn.create({ identifier: email.trim() });
      const factors = (attempt.supportedFirstFactors ?? []) as Array<{
        strategy: string;
        emailAddressId?: string;
      }>;
      const passwordFactor = factors.find(
        (candidate) => candidate.strategy === "password",
      );
      const emailCodeFactor = factors.find(
        (candidate) =>
          candidate.strategy === "email_code" &&
          typeof candidate.emailAddressId === "string",
      );

      const canUsePassword = Boolean(passwordFactor);
      const canUseEmailCode = Boolean(emailCodeFactor?.emailAddressId);

      setHasPassword(canUsePassword);
      setHasEmailCode(canUseEmailCode);
      setSignInAttempt(attempt as SignInAttempt);
      setEmailAddressId(emailCodeFactor?.emailAddressId ?? null);

      if (!canUsePassword && !canUseEmailCode) {
        throw new Error("No sign-in method is available for this account.");
      }

      if (canUsePassword) {
        setStep("password");
        return;
      }

      await attempt.prepareFirstFactor({
        strategy: "email_code",
        emailAddressId: emailCodeFactor?.emailAddressId ?? "",
      });
      setStep("code");
    } catch (caught) {
      setError(
        caught instanceof Error && !(caught as ClerkError).errors?.length
          ? caught.message
          : messageFrom(caught),
      );
    } finally {
      setBusy(false);
    }
  };

  const startEmailCode = async () => {
    if (!emailAddressId || !signInAttempt || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signInAttempt.prepareFirstFactor({
        strategy: "email_code",
        emailAddressId,
      });
      setStep("code");
    } catch (caught) {
      setError(
        caught instanceof Error && !(caught as ClerkError).errors?.length
          ? caught.message
          : messageFrom(caught),
      );
    } finally {
      setBusy(false);
    }
  };

  const signInWithPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!isLoaded || !signIn || busy) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await signIn.attemptFirstFactor({
        strategy: "password",
        password: password.trim(),
      });
      if (attempt.status === "complete" && attempt.createdSessionId) {
        await setActive({ session: attempt.createdSessionId });
        window.location.assign("/app");
        return;
      }

      const actionableError = formatVerificationContinuation(
        attempt as SignInAttemptResult,
      );
      if (actionableError) {
        throw new Error(actionableError);
      }

      throw new Error("Invalid password. Please try again.");
    } catch (caught) {
      setError(
        caught instanceof Error && !(caught as ClerkError).errors?.length
          ? caught.message
          : messageFrom(caught),
      );
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
      const attempt = await signIn.attemptFirstFactor({
        strategy: "email_code",
        code: code.trim(),
      });
      if (attempt.status !== "complete" || !attempt.createdSessionId) {
        throw new Error(
          "That code could not complete sign-in. Please request a new code.",
        );
      }
      await setActive({ session: attempt.createdSessionId });
      window.location.assign("/app");
    } catch (caught) {
      setError(
        caught instanceof Error && !(caught as ClerkError).errors?.length
          ? caught.message
          : messageFrom(caught),
      );
    } finally {
      setBusy(false);
    }
  };

  const backToEmail = () => {
    setStep("email");
    setError(null);
    setCode("");
    setPassword("");
  };

  return (
    <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
      <div className="space-y-6 p-7 sm:p-9">
        <div className="text-center">
          <img src="/logo.svg" alt="" className="mx-auto mb-4 h-10 w-10" />
          <h1 className="text-xl font-semibold text-foreground">
            Welcome back
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to Jack — your trade intelligence engine
          </p>
        </div>

        {step === "email" ? (
          <form onSubmit={startSignIn} className="space-y-4">
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
            <Button
              type="submit"
              className="w-full"
              disabled={!isLoaded || busy || !email.trim()}
            >
              {busy ? "Continuing…" : "Continue"}
            </Button>
          </form>
        ) : step === "password" ? (
          <form onSubmit={signInWithPassword} className="space-y-4">
            <label className="block space-y-2 text-sm font-medium text-foreground">
              <span>Password</span>
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoFocus
              />
            </label>
            <Button
              type="submit"
              className="w-full"
              disabled={busy || !password.trim()}
            >
              {busy ? "Signing in…" : "Sign in"}
            </Button>
            {hasEmailCode && (
              <button
                type="button"
                className="w-full text-sm text-primary hover:underline"
                onClick={startEmailCode}
                disabled={busy}
              >
                Use a verification code instead
              </button>
            )}
            <button
              type="button"
              className="w-full text-sm text-primary hover:underline"
              onClick={backToEmail}
              disabled={busy}
            >
              Use another email
            </button>
          </form>
        ) : (
          <form onSubmit={verifyCode} className="space-y-4">
            <div className="text-center">
              <h2 className="font-semibold text-foreground">
                Check your email
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Enter the verification code sent to {email}.
              </p>
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
            <Button
              type="submit"
              className="w-full"
              disabled={busy || !code.trim()}
            >
              {busy ? "Verifying…" : "Sign in"}
            </Button>
            <button
              type="button"
              className="w-full text-sm text-primary hover:underline"
              onClick={backToEmail}
              disabled={busy}
            >
              Use another email
            </button>
            {hasPassword && (
              <button
                type="button"
                className="w-full text-sm text-primary hover:underline"
                onClick={() => {
                  setStep("password");
                }}
                disabled={busy}
              >
                Use password instead
              </button>
            )}
          </form>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
      </div>
      <div className="border-t border-border bg-muted/20 px-6 py-4 text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <a href="/sign-up" className="font-medium text-primary hover:underline">
          Sign up
        </a>
      </div>
    </div>
  );
}
