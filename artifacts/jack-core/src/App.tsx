import { useEffect, useRef, useState } from "react";
import { SignIn, SignUp, Show, useAuth, useClerk } from "@clerk/react";
import {
  InternalClerkProvider as ClerkProvider,
  publishableKeyFromHost,
} from "@clerk/react/internal";
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
import { InterviewMode, type TorchInterviewPreload } from "./components/InterviewMode";
import { KnowledgeReview } from "./components/KnowledgeReview";
import { AskJack } from "./components/AskJack";
import { KnowledgeGraph } from "./components/KnowledgeGraph";
import { JackShell, type JackView } from "./components/JackShell";
import { MemoryGraphView } from "./components/MemoryGraphView";
import { Landing } from "./components/Landing";
import {
  TestingOverlay,
  type TestingOverlayEvent,
  type TestingOverlayHandle,
} from "./components/testing/TestingOverlay";
import { UserTestingGate } from "./components/testing/UserTestingGate";
import { useMemoryGraphData } from "./lib/use-memory-graph";
import { timeAgo } from "./lib/memory-graph";
import { useGetMe, type ParkedThought } from "@workspace/api-client-react";

const queryClient = new QueryClient();

const configuredClerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const isLocalClerkHost =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.hostname === "[::1]";

// Local IP hosts are not valid Clerk custom domains. Resolving 127.0.0.1 through
// publishableKeyFromHost produces clerk.127.0.0.1 and prevents ClerkJS loading.
// Deployed hosts still use host-aware resolution for Torch's custom domains.
const clerkPubKey = isLocalClerkHost
  ? configuredClerkPubKey
  : publishableKeyFromHost(window.location.hostname, configuredClerkPubKey);

// Auth proxying caused rate-limit/OAuth fragility on custom domains. Keep it
// opt-in only; the normal production path sends browser auth traffic directly
// to Clerk.
const clerkProxyUrl =
  isLocalClerkHost
    ? `${window.location.origin}/api/__clerk`
    : import.meta.env.VITE_ENABLE_CLERK_PROXY === "true"
    ? import.meta.env.VITE_CLERK_PROXY_URL
    : undefined;

// Serve Clerk's browser bundles from the same reliable CDN path used by the
// Torch app. The instance API still comes from the signed publishable key, but
// a slow custom-domain bundle endpoint can no longer leave the React tree blank.
const localClerkJsUrl =
  "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6/dist/clerk.browser.js";
const localClerkUiUrl =
  "https://cdn.jsdelivr.net/npm/@clerk/ui@1/dist/ui.browser.js";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const TORCH_INTERVIEW_HANDOFF_KEY = "jack.torchInterviewHandoff";

function captureTorchInterviewHandoff() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("view") !== "interview" || params.get("source") !== "torch-command-centre") return;
  try {
    sessionStorage.setItem(TORCH_INTERVIEW_HANDOFF_KEY, params.toString().slice(0, 4000));
  } catch {
    // Storage can be blocked; signed-in users still consume the live URL.
  }
}

captureTorchInterviewHandoff();

function readTorchInterviewPreload(): TorchInterviewPreload | undefined {
  const liveParams = new URLSearchParams(window.location.search);
  let params = liveParams;
  if (liveParams.get("source") !== "torch-command-centre") {
    try {
      params = new URLSearchParams(sessionStorage.getItem(TORCH_INTERVIEW_HANDOFF_KEY) ?? "");
    } catch {
      return undefined;
    }
  }
  if (params.get("view") !== "interview" || params.get("source") !== "torch-command-centre") {
    return undefined;
  }

  const value = (key: string, maxLength: number) => (params.get(key) ?? "").trim().slice(0, maxLength);
  const preload = {
    starvingPointId: value("starvingPointId", 120),
    title: value("title", 180),
    trade: value("trade", 100),
    category: value("category", 100),
    description: value("description", 800),
    priority: value("priority", 40),
    evidence: value("evidence", 800),
  };

  if (!preload.starvingPointId || !preload.title || !preload.trade) return undefined;
  try {
    sessionStorage.removeItem(TORCH_INTERVIEW_HANDOFF_KEY);
  } catch {
    // Best-effort cleanup only.
  }
  return preload;
}

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
  const [interviewPreload] = useState<TorchInterviewPreload | undefined>(readTorchInterviewPreload);
  const [view, setView] = useState<JackView>(() => interviewPreload ? "interview" : "graph");
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
  const [testingGate, setTestingGate] = useState<{
    accepted: boolean;
    restricted: boolean;
  }>(() => ({
    accepted: false,
    restricted: false,
  }));

  // Signed-in identity (for the sidebar) + sign-out. Every user reaching this
  // component is authenticated; `isAdmin` only tunes which controls appear.
  const { data: me } = useGetMe();
  const { signOut, openUserProfile } = useClerk();
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

  const handleStartUserTest = () => {
    setTestingGate((prev) => ({ ...prev, restricted: false }));
    testingOverlayRef.current?.open();
  };

  const handleTestingEvent = (event: TestingOverlayEvent) => {
    if (event === "declined") {
      setTestingGate({ accepted: false, restricted: true });
      return;
    }
    if (event === "started" || event === "unavailable" || event === "cancelled") {
      setTestingGate({ accepted: true, restricted: false });
      return;
    }
  };

  // Resume an interrupted interview from a mentor node in the Living Memory
  // graph. We stash the session id under the SAME localStorage key Interview
  // Mode reads on mount ("jack.interview.activeSessionId") and switch to that
  // view — Interview Mode's existing resume-on-mount logic then reconnects to
  // exactly where the mentor left off. Kept as a literal (not imported from
  // InterviewMode) so this path stays decoupled from that component's internals.
  const handleResumeInterview = (sessionId: string) => {
    try {
      sessionStorage.setItem("jack.interview.activeSessionId", sessionId);
      localStorage.removeItem("jack.interview.activeSessionId");
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
        onOpenSettings={() => openUserProfile()}
        onSignOut={() => void signOut({ redirectUrl: basePath || "/" })}
        onStartUserTest={me?.isAdmin === false ? handleStartUserTest : undefined}
        userTestingRequired={me?.isAdmin === false && testingGate.restricted}
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
          <InterviewMode preload={interviewPreload} />
        ) : view === "review" ? (
          <KnowledgeReview />
        ) : (
          <Library onSelectVideo={handleSelectVideo} />
        )}
      </JackShell>

      <UserTestingGate
        open={me?.isAdmin === false && testingGate.restricted && !testingGate.accepted}
        onStart={handleStartUserTest}
      />

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

      <TestingOverlay ref={testingOverlayRef} autoPrompt={me?.isAdmin === false} onEvent={handleTestingEvent} />
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
        forceRedirectUrl={isLocalClerkHost ? `${window.location.origin}${basePath}/app` : undefined}
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
        forceRedirectUrl={isLocalClerkHost ? `${window.location.origin}${basePath}/app` : undefined}
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

function AuthBootstrapBoundary() {
  const { isLoaded } = useAuth();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (isLoaded) {
      setTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setTimedOut(true), 8000);
    return () => window.clearTimeout(timer);
  }, [isLoaded]);

  if (!isLoaded) {
    // The public home page must remain presentable even if the auth provider is
    // slow or blocked. Auth resolution will redirect signed-in users afterward.
    if (window.location.pathname === `${basePath}/` || window.location.pathname === basePath) {
      return <Landing />;
    }
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-background px-6 text-center text-foreground">
        <div className="max-w-sm space-y-4">
          <div className="mx-auto h-9 w-9 animate-spin rounded-full border-4 border-white/15 border-t-primary" />
          <h1 className="text-xl font-bold">Connecting securely</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {timedOut
              ? "Your secure session did not finish loading. Retry the connection or return to Jack’s overview."
              : "Restoring your Jack session…"}
          </p>
          {timedOut && (
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button className="min-h-11 rounded-lg bg-primary px-5 font-semibold text-primary-foreground" onClick={() => window.location.reload()}>
                Retry connection
              </button>
              <a className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-5 font-semibold" href={`${basePath}/`}>
                Open overview
              </a>
            </div>
          )}
        </div>
      </main>
    );
  }

  return (
    <Switch>
      <Route path="/" component={HomeRedirect} />
      <Route path="/app" component={ProtectedApp} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route><Redirect to="/" /></Route>
    </Switch>
  );
}

function AuthReadySignal({ onReady }: { onReady: () => void }) {
  const { isLoaded } = useAuth();
  useEffect(() => {
    if (isLoaded) onReady();
  }, [isLoaded, onReady]);
  return null;
}

function ClerkProviderWithRoutes({ onAuthReady }: { onAuthReady: () => void }) {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      __internal_clerkJSUrl={localClerkJsUrl}
      __internal_clerkUIUrl={localClerkUiUrl}
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
        <AuthReadySignal onReady={onAuthReady} />
        <ClerkQueryClientCacheInvalidator />
        <AuthBootstrapBoundary />
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  const [authReady, setAuthReady] = useState(false);
  const [authTimedOut, setAuthTimedOut] = useState(false);

  useEffect(() => {
    if (authReady) return;
    const timer = window.setTimeout(() => setAuthTimedOut(true), 8000);
    return () => window.clearTimeout(timer);
  }, [authReady]);

  return (
    <>
      {!authReady && (
        <main className="fixed inset-0 z-[9999] flex min-h-[100dvh] items-center justify-center bg-background px-6 text-center text-foreground">
          <div className="max-w-sm space-y-4">
            <div className="text-xl font-extrabold">JACK <span className="text-primary">CORE</span></div>
            <div className="mx-auto h-9 w-9 animate-spin rounded-full border-4 border-white/15 border-t-primary" />
            <p className="text-sm text-muted-foreground">
              {authTimedOut ? "The secure session is taking too long to respond." : "Connecting securely…"}
            </p>
            {authTimedOut && (
              <button className="min-h-11 rounded-lg bg-primary px-5 font-semibold text-primary-foreground" onClick={() => window.location.reload()}>
                Retry connection
              </button>
            )}
          </div>
        </main>
      )}
      <WouterRouter base={basePath}>
        <ClerkProviderWithRoutes onAuthReady={() => setAuthReady(true)} />
      </WouterRouter>
    </>
  );
}

export default App;
