import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useAuth, useClerk } from "@clerk/react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  exportTelemetry,
  loadTelemetryContext,
  withdrawTelemetry,
  type TelemetryContext,
} from "../lib/user-testing/test-session-service";

export type JackAccessContext = {
  allowed: boolean;
  organizations: Array<{
    id: string;
    name: string;
    role:
      | "member"
      | "champion"
      | "organization_admin"
      | "tester"
      | "pilot_admin";
  }>;
  canInvite: boolean;
};
const AccessContext = createContext<JackAccessContext | null>(null);
export const useJackAccess = () => useContext(AccessContext);

// Share the generated client's token handling and bound requests on poor mobile networks.
export async function accessRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = window.setTimeout(abort, 20_000);
  try {
    return await customFetch<T>(path, {
      ...options,
      credentials: "include",
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function JackAccess({ children }: { children: ReactNode }) {
  const { userId, sessionId, isLoaded } = useAuth();
  if (!isLoaded || !userId)
    return (
      <p role="status" className="p-6">
        Connecting your secure session...
      </p>
    );
  return (
    <SessionAccess key={`${userId}:${sessionId}`}>{children}</SessionAccess>
  );
}

function SessionAccess({ children }: { children: ReactNode }) {
  const { signOut } = useClerk();
  const [access, setAccess] = useState<JackAccessContext | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setAccess(null);
    setError(false);
    void (async () => {
      try {
        const context = await accessRequest<JackAccessContext>(
          "/api/access/accept",
          { method: "POST", signal: controller.signal },
        );
        if (!controller.signal.aborted) setAccess(context);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    })();
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    if (access || error) window.__JACK_MARK_READY__?.();
  }, [access, error]);
  if (access?.allowed === true)
    return (
      <AccessContext.Provider value={access}>{children}</AccessContext.Provider>
    );
  if (!error && !access)
    return (
      <p role="status" className="p-6">
        Opening Jack...
      </p>
    );
  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-lg flex-col justify-center gap-5 p-6">
      <h1 className="text-2xl font-semibold">
        {error
          ? "We couldn't confirm your access"
          : "Your account is signed in"}
      </h1>
      <p className="text-muted-foreground">
        {error
          ? "Please try again when your connection is ready."
          : "No active organization access was found for this account. Use the email on your invitation, or ask your organization's admin for an invite."}
      </p>
      <Button
        onClick={() => {
          setAccess(null);
          setError(false);
          setAttempt((value) => value + 1);
        }}
      >
        Check access again
      </Button>
      <AccessAccountControls />
      <Button
        variant="ghost"
        onClick={() =>
          void signOut({
            redirectUrl: `${import.meta.env.BASE_URL.replace(/\/$/, "")}/sign-in`,
          })
        }
      >
        Sign out
      </Button>
    </main>
  );
}

// Former participants retain privacy and deletion controls without mounting Jack data views.
function AccessAccountControls() {
  const { openUserProfile } = useClerk();
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<TelemetryContext | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [phrase, setPhrase] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20_000);
    void loadTelemetryContext(undefined, {
      signal: controller.signal,
      shouldCache: () => false,
    })
      .then((value) => {
        if (!controller.signal.aborted) setContext(value);
      })
      .catch(() =>
        setError(
          "Privacy settings could not be loaded. You can still export your data or manage your account.",
        ),
      )
      .finally(() => window.clearTimeout(timer));
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch {
      setError("The request could not be completed. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <Button
        variant="outline"
        className="w-full"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        Account &amp; privacy
      </Button>
      {open && (
        <>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => openUserProfile()}
          >
            Manage account security
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={exportTelemetry}
          >
            Export telemetry
          </Button>
          {(
            context?.privacyScopes ??
            (context?.scope
              ? [{ ...context.scope, consents: context.consents }]
              : [])
          ).map((scope) => (
            <div key={scope.pilotId}>
              <p className="text-sm">
                {scope.organizationName} / {scope.pilotName}
              </p>
              <Button
                variant="outline"
                className="mt-2 w-full"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await withdrawTelemetry(scope.pilotId, [
                      "telemetry",
                      "screen",
                      "microphone",
                    ]);
                    setNotice(
                      "Consent withdrawn. Future collection has stopped and deletion has been scheduled.",
                    );
                  })
                }
              >
                Withdraw consent
              </Button>
            </div>
          ))}
          <p className="text-sm text-muted-foreground">
            To permanently delete your account and its contributed data, type
            DELETE.
          </p>
          <Input
            aria-label="Account deletion confirmation"
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            autoComplete="off"
          />
          <Button
            variant="destructive"
            className="w-full"
            disabled={busy || phrase !== "DELETE"}
            onClick={() =>
              void run(async () => {
                await accessRequest("/api/account", { method: "DELETE" });
                window.location.assign("/api/auth/reset-session");
              })
            }
          >
            Delete my account
          </Button>
          {notice && (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
