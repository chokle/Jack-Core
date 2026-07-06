import { useEffect, useState } from "react";

interface ThinkAloudBannerProps {
  onDismiss: () => void;
}

const DISMISS_MS = 8000;

/**
 * Brief reminder shown once recording starts. Deliberately its own tiny
 * local-timeout component — NOT useToast (TOAST_LIMIT is 1 here, so this
 * would evict any other toast in flight) and not the graph's bespoke toast
 * system. Copy is exact — do not paraphrase.
 */
export function ThinkAloudBanner({ onDismiss }: ThinkAloudBannerProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setVisible(false);
      onDismiss();
    }, DISMISS_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!visible) return null;

  return (
    <div
      role="status"
      data-testid="user-testing-think-aloud-banner"
      className="fixed left-1/2 top-4 z-[100] w-[min(92vw,32rem)] -translate-x-1/2 rounded-xl border border-white/10 bg-card/95 px-4 py-3 text-center text-sm text-foreground shadow-2xl shadow-black/70 ring-1 ring-white/5 backdrop-blur-xl duration-200 ease-out animate-in fade-in-0 slide-in-from-top-2"
    >
      As you use Torch, please say what you're thinking out loud. If something
      confuses you, surprises you, or feels frustrating, tell us immediately.
      You're helping improve Torch.
    </div>
  );
}
