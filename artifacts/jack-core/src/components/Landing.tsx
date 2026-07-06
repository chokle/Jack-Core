import { Link } from "wouter";
import {
  ArrowRight,
  Network,
  Mic,
  Clock,
  ShieldCheck,
  Video,
} from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const logoUrl = `${basePath}/logo.svg`;

const features = [
  {
    icon: Video,
    title: "Transcribe & index",
    body: "Training videos are transcribed, mapped to Red Seal competencies, and indexed for instant semantic search.",
  },
  {
    icon: Clock,
    title: "Timestamped answers",
    body: "Ask Jack any trade question and get answers grounded in the source footage — every claim cites the exact moment.",
  },
  {
    icon: Mic,
    title: "Teach Jack",
    body: "A guided mentor interview captures hard-won field knowledge and feeds the same living memory the videos build.",
  },
  {
    icon: Network,
    title: "Living Memory",
    body: "Every video and interview grows one persistent knowledge graph — the platform gets smarter because people teach it.",
  },
];

/**
 * Public landing page. Deliberately API-free: it is the only surface an
 * anonymous visitor can reach, so it must render without any authenticated
 * request. Sign-in / sign-up CTAs route to the dedicated Clerk pages.
 */
export function Landing() {
  return (
    <div className="relative min-h-[100dvh] overflow-hidden bg-background text-foreground">
      {/* Ambient torch glow + faint grid — pure CSS, no data. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60rem 40rem at 50% -10%, hsl(24 100% 50% / 0.18), transparent 60%), radial-gradient(42rem 30rem at 100% 15%, hsl(24 100% 50% / 0.08), transparent 55%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(210 40% 98%) 1px, transparent 1px), linear-gradient(90deg, hsl(210 40% 98%) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />

      <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-6xl flex-col px-6">
        {/* Nav */}
        <header className="flex items-center justify-between py-6">
          <div className="flex items-center gap-2.5">
            <img src={logoUrl} alt="" className="h-8 w-8" />
            <div className="flex items-baseline gap-1">
              <span className="text-lg font-extrabold tracking-tight">JACK</span>
              <span className="text-lg font-extrabold tracking-tight text-primary">
                CORE
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/sign-in"
              className="rounded-lg px-4 py-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              Sign in
            </Link>
            <Link
              href="/sign-up"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-[0_0_20px_rgba(255,100,0,0.35)] transition-colors hover:bg-primary/90"
            >
              Get started
            </Link>
          </div>
        </header>

        {/* Hero */}
        <main className="flex flex-1 flex-col items-center justify-center py-16 text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3.5 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            AI Trade Intelligence Engine
          </div>
          <h1 className="max-w-3xl text-balance text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
            The trade knowledge in your crew's head,{" "}
            <span className="text-primary">searchable forever.</span>
          </h1>
          <p className="mt-6 max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
            Jack transcribes your training videos, maps them to Red Seal
            competencies, and answers any trade question with the exact
            timestamp — while mentors teach it everything they know.
          </p>
          <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
            <Link
              href="/sign-up"
              className="group inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-[0_0_25px_rgba(255,100,0,0.4)] transition-colors hover:bg-primary/90"
            >
              Get started
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/sign-in"
              className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-card/50 px-6 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-muted/60"
            >
              Sign in
            </Link>
          </div>

          {/* Feature grid */}
          <div className="mt-20 grid w-full grid-cols-1 gap-4 text-left sm:grid-cols-2">
            {features.map((f) => (
              <div
                key={f.title}
                className="rounded-2xl border border-border bg-card/40 p-5 backdrop-blur transition-colors hover:border-primary/40"
              >
                <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <f.icon className="h-5 w-5" />
                </div>
                <h3 className="text-base font-semibold">{f.title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </main>

        {/* Footer */}
        <footer className="flex flex-col items-center justify-between gap-3 border-t border-border/60 py-6 text-xs text-muted-foreground sm:flex-row">
          <span>Jack — inside Torch. Built for the field.</span>
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            Private &amp; access-controlled
          </span>
        </footer>
      </div>
    </div>
  );
}
