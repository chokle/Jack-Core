import { useEffect, useRef, useState } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { dark } from "@clerk/themes";
import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Library } from "./components/Library";
import { VideoDetail } from "./components/VideoDetail";
import { InterviewMode } from "./components/InterviewMode";
import { KnowledgeReview } from "./components/KnowledgeReview";
import { AskJack } from "./components/AskJack";
import { KnowledgeGraph } from "./components/KnowledgeGraph";
import { JackShell, type JackView } from "./components/JackShell";
import { MemoryGraphView } from "./components/MemoryGraphView";
import { Landing } from "./components/Landing";
import { TestingOverlay, type TestingOverlayHandle } from "./components/testing/TestingOverlay";
import { useMemoryGraphData } from "./lib/use-memory-graph";
import { timeAgo } from "./lib/memory-graph";
import { useGetMe, type ParkedThought } from "@workspace/api-client-react";

const queryClient = new QueryClient();

// REQUIRED — copy verbatim. Resolves the key from window.location.hostname so the
// same build serves multiple Clerk custom domains. Do not inline the env var, leave
// publishableKey undefined, or replace publishableKeyFromHost with anything else.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// Auth proxying caused rate-limit/OAuth fragility on custom domains. Keep it
// opt-in only; the normal production path sends browser auth traffic directly
// to Clerk.
const clerkProxyUrl =
  import.meta.env.VITE_ENABLE_CLERK_PROXY === "true"
    ? import.meta.env.VITE_CLERK_PROXY_URL
    : undefined;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Clerk passes full paths to routerPush/routerReplace, but wouter's setLocation
// prepends the base — strip it to avoid doubling.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

const clerkAppearance = {
  theme: dark,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(24 100% 50%)",
    colorForeground: "hsl(210 40% 98%)",
    colorMutedForeground: "hsl(215 20% 65%)",
    colorDanger: "hsl(0 72% 60%)",
    colorBackground: "hsl(222 47% 11%)",
    colorInput: "hsl(217 33% 17%)",
    colorInputForeground: "hsl(210 40% 98%)",
    colorNeutral: "hsl(210 40% 98%)",
    fontFamily: "'Outfit', ui-sans-serif, system-ui, sans-serif",
    borderRadius: "0.6rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox:
      "bg-card border border-border rounded-2xl w-[440px] max-w-full overflow-hidden shadow-2xl",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-foreground",
    headerSubtitle: "text-muted-foreground",
    socialButtonsBlockButton: "border border-border bg-card/60 hover:bg-muted/60",
    socialButtonsBlockButtonText: "text-foreground",
    dividerLine: "bg-border",
    dividerText: "text-muted-foreground",
    formFieldLabel: "text-foreground",
    formFieldInput: "bg-[hsl(217_33%_17%)] border border-border text-foreground",
    formButtonPrimary:
      "!bg-primary !text-primary-foreground hover:!bg-primary/90 !shadow-[0_0_15px_rgba(255,100,0,0.35)]",
    footerAction: "text-muted-foreground",
    footerActionText: "text-muted-foreground",
    footerActionLink: "!text-primary hover:!text-primary/80",
    identityPreviewEditButton: "!text-primary",
    formFieldSuccessText: "text-muted-foreground",
    alert: "border border-border bg-card/60",
    alertText: "text-foreground",
    otpCodeFieldInput: "!text-foreground border border-border",
    logoBox: "justify-center",
    logoImage: "h-10 w-10",
  },
};

function JackApp() {
  const [view, setView] = useState<JackView>("graph");
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatContext, setChatContext] = useState<string | undefined>();
  // Set when the drawer is opened via "Resume" on a parked chat thought — shows
  // a reorientation banner atop the conversation. Cleared on close so the next
  // plain "Ask Jack" open (no resume) doesn't show a stale banner.
  const [resumedThought, setResumedThought] = useState<ParkedThought | null>(null);
  // A monotonically-increasing token so clicking the *same* citation twice still
  // re-triggers a seek; `time` is the target position in seconds.
  const [seek, setSeek] = useState<{ time: number; token: number } | undefined>();

  const graph = useMemoryGraphData();

  // Beta user-testing mode: the "Start User Test" button in JackShell opens
  // the consent modal via this imperative handle; TestingOverlay also opens
  // itself on `?test=true`. See components/testing/TestingOverlay.tsx.
  const testingOverlayRef = useRef<TestingOverlayHandle>(null);

  // Signed-in identity (for the sidebar) + sign-out. Every user reaching this
  // component is authenticated; `isAdmin` only tunes which controls appear.
  const { data: me } = useGetMe();
  const { signOut } = useClerk();
  const userLabel = me?.name ?? me?.email ?? "Account";
  const userSubLabel = me?.isAdmin ? "Administrator" : "Signed in";

  const handleOpenChat = (context?: string) => {
    setResumedThought(null);
    setChatContext(context);
    setIsChatOpen(true);
  };

  // Resume a parked Ask Jack conversation: prefill the input with whatever was
  // left unfinished and surface a reorientation banner. The full conversation
  // itself is already restored for free — chat history is loaded by session
  // cookie, and a parked thought is always the caller's own session.
  const handleResumeChat = (thought: ParkedThought) => {
    setResumedThought(thought);
    setChatContext(thought.unfinishedThought ?? undefined);
    setIsChatOpen(true);
  };

  const handleSelectVideo = (videoId: string) => {
    setSeek(undefined);
    setSelectedVideoId(videoId);
  };

  const handleNavigate = (next: JackView) => {
    setSelectedVideoId(null);
    setView(next);
  };

  const handleCitationClick = (videoId: string, startTime: number) => {
    setSelectedVideoId(videoId);
    setSeek({ time: startTime, token: Date.now() });
  };

  // Resume an interrupted interview from a mentor node in the Living Memory
  // graph. We stash the session id under the SAME localStorage key Interview
  // Mode reads on mount ("jack.interview.activeSessionId") and switch to that
  // view — Interview Mode's existing resume-on-mount logic then reconnects to
  // exactly where the mentor left off. Kept as a literal (not imported from
  // InterviewMode) so this path stays decoupled from that component's internals.
  const handleResumeInterview = (sessionId: string) => {
    try {
      localStorage.setItem("jack.interview.activeSessionId", sessionId);
    } catch {
      // Storage unavailable (private mode) — Interview Mode will start fresh.
    }
    setSelectedVideoId(null);
    setView("interview");
  };

  const inGraph = view === "graph" && !selectedVideoId;
  const activeNav: JackView = selectedVideoId ? "library" : view;

  return (
    <>
      {/* Ambient memory wallpaper behind the library / detail surfaces. The
          Memory Graph view renders its own full-bleed interactive canvas. */}
      {!inGraph && <KnowledgeGraph />}

      <JackShell
        active={activeNav}
        onNavigate={handleNavigate}
        onOpenChat={() => handleOpenChat()}
        model={graph.model}
        readyCount={graph.readyCount}
        lastUpdatedLabel={graph.lastUpdated ? timeAgo(graph.lastUpdated) : "—"}
        userLabel={userLabel}
        userSubLabel={userSubLabel}
        onSignOut={() => void signOut({ redirectUrl: basePath || "/" })}
        onStartUserTest={() => testingOverlayRef.current?.open()}
      >
        {selectedVideoId ? (
          <VideoDetail
            videoId={selectedVideoId}
            onBack={() => setSelectedVideoId(null)}
            onOpenChat={handleOpenChat}
            seek={seek}
          />
        ) : view === "graph" ? (
          <MemoryGraphView
            data={graph}
            onOpenVideo={handleSelectVideo}
            onJumpToTimestamp={handleCitationClick}
            onResumeInterview={handleResumeInterview}
            onResumeChat={handleResumeChat}
            onStartInterview={() => handleNavigate("interview")}
          />
        ) : view === "interview" ? (
          <InterviewMode />
        ) : view === "review" ? (
          <KnowledgeReview />
        ) : (
          <Library onSelectVideo={handleSelectVideo} />
        )}
      </JackShell>

      {/* Chat Drawer overlay */}
      <AskJack
        isOpen={isChatOpen}
        onClose={() => {
          setIsChatOpen(false);
          setResumedThought(null);
        }}
        resumedThought={resumedThought ?? undefined}
        initialContext={chatContext}
        onCitationClick={handleCitationClick}
      />

      <TestingOverlay ref={testingOverlayRef} autoPrompt />
    </>
  );
}

// The authenticated app surface. Only mounted for signed-in users, so its
// data-fetching hooks (useMemoryGraphData, useGetMe, …) never fire for anon.
function AppSurface() {
  return (
    <TooltipProvider>
      <JackApp />
      <Toaster />
    </TooltipProvider>
  );
}

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      {/* path must be the full browser path — Clerk reads window.location.pathname directly */}
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
      />
    </div>
  );
}

// Base path: landing for anon, straight into the app for signed-in users.
function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/app" />
      </Show>
      <Show when="signed-out">
        <Landing />
      </Show>
    </>
  );
}

// The whole app is authenticated-only. Anon callers are bounced to the landing
// page (never to sign-in directly). The server independently enforces auth on
// every /api route, so this client gate is convenience, not the boundary.
function ProtectedApp() {
  return (
    <>
      <Show when="signed-in">
        <AppSurface />
      </Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

// Clears the React Query cache when the signed-in user changes, so one user's
// data never bleeds into the next session on the same device.
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to Jack — your trade intelligence engine",
          },
        },
        signUp: {
          start: {
            title: "Create your account",
            subtitle: "Join Jack and start building the Living Memory",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <Switch>
          <Route path="/" component={HomeRedirect} />
          <Route path="/app" component={ProtectedApp} />
          {/* REQUIRED — copy "/sign-in/*?" and "/sign-up/*?" verbatim. The /*?
              optional wildcard is the only wouter syntax that matches both the
              bare URL and Clerk's OAuth sub-paths. */}
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          <Route>
            <Redirect to="/" />
          </Route>
        </Switch>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
