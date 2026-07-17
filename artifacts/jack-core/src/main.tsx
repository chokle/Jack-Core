import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { prepareBrowserUpgrade } from "./lib/bootstrap-recovery";

declare global {
  interface Window {
    __JACK_MARK_READY__?: () => void;
    __JACK_REPAIR_SESSION__?: () => Promise<void>;
  }
}

function repairSession(): void {
  if (window.__JACK_REPAIR_SESSION__) {
    void window.__JACK_REPAIR_SESSION__();
    return;
  }
  window.location.assign(`/api/auth/reset-session?reason=bootstrap&at=${Date.now()}`);
}

function FailureScreen({ detail }: { detail: string }) {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 text-foreground">
      <section className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">
          Jack recovery
        </p>
        <h1 className="mt-2 text-2xl font-bold">Jack could not finish loading</h1>
        <p className="mt-3 text-sm text-muted-foreground">{detail}</p>
        <button
          type="button"
          className="mt-5 rounded-lg bg-primary px-4 py-2 font-semibold text-primary-foreground"
          onClick={repairSession}
        >
          Repair browser session
        </button>
      </section>
    </main>
  );
}

class StartupErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Jack startup failed", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <FailureScreen detail="Stored browser state or an expired session prevented startup. Repairing signs you out and reloads a clean application state." />
      );
    }
    return this.props.children;
  }
}

async function start(): Promise<void> {
  await prepareBrowserUpgrade();
  createRoot(document.getElementById("root")!).render(
    <StartupErrorBoundary>
      <App />
    </StartupErrorBoundary>,
  );
}

void start().catch((error) => {
  console.error("Jack bootstrap recovery failed", error);
  createRoot(document.getElementById("root")!).render(
    <FailureScreen detail="Jack could not validate this browser's saved state. Repair the session to continue." />,
  );
});
