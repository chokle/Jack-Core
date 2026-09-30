import { useEffect, useState } from "react";
import { Download } from "lucide-react";

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

// The browser can offer installation before signed-in screens finish loading.
// Retain that one-shot event until a visible install action can use it.
let deferredPrompt: InstallPrompt | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as InstallPrompt;
  });
}

function isInstalled(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Browser install prompt where supported; plain phone instructions elsewhere. */
export function InstallJack() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(deferredPrompt);
  const [installed, setInstalled] = useState(isInstalled);
  const [showInstructions, setShowInstructions] = useState(false);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    const onInstalled = () => {
      setPrompt(null);
      setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;

  const onInstall = async () => {
    if (!prompt) {
      setShowInstructions((open) => !open);
      return;
    }
    try {
      await prompt.prompt();
      await prompt.userChoice;
      deferredPrompt = null;
      setPrompt(null);
    } catch {
      deferredPrompt = null;
      setPrompt(null);
      setShowInstructions(true);
    }
  };

  const isApplePhone = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  return (
    <div className="mt-5 text-center md:hidden">
      <button
        type="button"
        onClick={() => void onInstall()}
        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-card/70 px-5 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-muted/60"
      >
        <Download className="h-4 w-4" />
        Install Jack on your phone
      </button>
      {showInstructions && (
        <p className="mx-auto mt-3 max-w-sm text-sm text-muted-foreground">
          {isApplePhone
            ? "In Safari, tap Share, then Add to Home Screen. Turn on Open as Web App."
            : "In your browser menu, tap Install app or Add to Home screen."}
        </p>
      )}
    </div>
  );
}
