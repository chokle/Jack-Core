import { useCallback, useEffect, useState } from "react";
import { authenticatedFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

interface DazRuntimeStatus {
  health: {
    ok: boolean;
    schema_version: number;
    adapter: string;
    durable_object: boolean;
  };
  state: {
    schema_version: number;
    identity: { id: string; pronouns: string };
    adapter: string;
    generation: number;
    active: boolean;
    receipts: number;
    recoveries: number;
    authority_audit_entries: number;
  };
}

interface DazRuntimeEnvelope {
  ok: boolean;
  status: DazRuntimeStatus;
}

type CheckState =
  | { status: "idle" | "loading"; data?: undefined; error?: undefined }
  | { status: "ready"; data: DazRuntimeEnvelope; error?: undefined }
  | { status: "error"; data?: undefined; error: string };

function valueText(value: string | number | boolean): string {
  return typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
}

function StatusRow({
  label,
  value,
}: {
  label: string;
  value: string | number | boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-1 font-mono text-sm text-slate-100">
        {valueText(value)}
      </dd>
    </div>
  );
}

export function DazRuntimeCheck() {
  const [state, setState] = useState<CheckState>({ status: "idle" });

  const runCheck = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const response = await authenticatedFetch("/api/daz-runtime/status", {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const body = (await response.json()) as DazRuntimeEnvelope & {
        error?: string;
      };
      if (!response.ok || !body.ok) {
        throw new Error(
          body.error || `Daz runtime returned HTTP ${response.status}`,
        );
      }
      setState({ status: "ready", data: body });
    } catch (error) {
      setState({
        status: "error",
        error:
          error instanceof Error ? error.message : "Daz runtime check failed.",
      });
    }
  }, []);

  useEffect(() => {
    window.__JACK_MARK_READY__?.();
  }, []);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  const status = state.status === "ready" ? state.data.status : null;

  return (
    <main className="min-h-[100dvh] bg-slate-950 px-5 py-8 text-slate-100">
      <section className="mx-auto flex max-w-3xl flex-col gap-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-orange-400">
            Daz runtime acceptance
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">
            Jack to Daz harness check
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">
            This page uses the signed-in Jack session to call the admin Daz
            runtime status endpoint. A pass here proves Jack can reach the
            deployed harness through production auth.
          </p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Authenticated status</p>
              <p className="mt-1 text-sm text-slate-400">
                {state.status === "loading"
                  ? "Checking production runtime..."
                  : state.status === "ready"
                    ? "Runtime responded through Jack."
                    : state.status === "error"
                      ? state.error
                      : "Ready to check."}
              </p>
            </div>
            <Button
              type="button"
              onClick={() => void runCheck()}
              disabled={state.status === "loading"}
            >
              {state.status === "loading" ? "Checking..." : "Run check"}
            </Button>
          </div>
        </div>

        {status ? (
          <dl className="grid gap-3 sm:grid-cols-2">
            <StatusRow label="Runtime OK" value={status.health.ok} />
            <StatusRow label="Identity" value={status.state.identity.id} />
            <StatusRow label="Adapter" value={status.state.adapter} />
            <StatusRow label="Generation" value={status.state.generation} />
            <StatusRow
              label="Durable Object"
              value={status.health.durable_object}
            />
            <StatusRow label="Active lease" value={status.state.active} />
            <StatusRow label="Receipts" value={status.state.receipts} />
            <StatusRow label="Recoveries" value={status.state.recoveries} />
            <StatusRow
              label="Authority audit entries"
              value={status.state.authority_audit_entries}
            />
          </dl>
        ) : null}
      </section>
    </main>
  );
}
