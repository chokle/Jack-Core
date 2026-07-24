import { useEffect, useRef, useState } from "react";
import { AuthenticateWithRedirectCallback, SignUp, Show, useAuth, useClerk } from "@clerk/react";
import { InternalClerkProvider as ClerkProvider } from "@clerk/react/internal";
import { dark } from "@clerk/themes";
import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { EmailCodeSignIn } from "@/components/EmailCodeSignIn";
import { Library } from "./components/Library";
import { VideoDetail } from "./components/VideoDetail";
import { InterviewMode, type FieldNoteInterviewPreload, type TorchInterviewPreload } from "./components/InterviewMode";
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
import {
  UserTestFeedback,
  type UserTestFeedbackHandle,
} from "./components/testing/UserTestFeedback";
import { useMemoryGraphData } from "./lib/use-memory-graph";
import { timeAgo } from "./lib/memory-graph";
import { setAuthTokenGetter, useGetMe, type Citation, type ParkedThought } from "@workspace/api-client-react";

const queryClient = new QueryClient();

const configuredClerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const isLocalClerkHost =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.hostname === "[::1]";
const isRailwayPreviewHost = window.location.hostname.endsWith(".up.railway.app");
const useDirectClerkAssets = isLocalClerkHost || isRailwayPreviewHost;

// Local IP hosts are not valid Clerk custom domains. Resolving 127.0.0.1 through
// publishableKeyFromHost produces clerk.127.0.0.1 and prevents ClerkJS loading.
// Deployed hosts still use host-aware resolution for Torch's custom domains.
const clerkPubKey = configuredClerkPubKey;

// Production auth can be routed through Jack's same-origin server proxy so
// privacy tools and restrictive networks do not need direct Clerk FAPI access.
const clerkProxyUrl =
  isLocalClerkHost
    ? `${window.location.origin}/api/__clerk`
    : import.meta.env.VITE_ENABLE_CLERK_PROXY === "true"
    ? import.meta.env.VITE_CLERK_PROXY_URL
    : undefined;

const localClerkJsUrl = useDirectClerkAssets
  ? "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6/dist/clerk.browser.js"
  : `${window.location.origin}/api/__clerk/npm/@clerk/clerk-js@6/dist/clerk.browser.js`;
const localClerkUiUrl = useDirectClerkAssets
  ? "https://cdn.jsdelivr.net/npm/@clerk/ui@1/dist/ui.browser.js"
  : `${window.location.origin}/api/__clerk/npm/@clerk/ui@1/dist/ui.browser.js`;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const TORCH_INTERVIEW_HANDOFF_KEY = "jack.torchInterviewHandoff";
const AUTH_STARTUP_TIMEOUT_MS = 6_000;

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

function JackApp({ onSignOut }: { onSignOut?: () => void | Promise<void> }) {
  const [interviewPreload, setInterviewPreload] = useState<TorchInterviewPreload | undefined>(readTorchInterviewPreload);
  const [fieldNotePreload, setFieldNotePreload] = useState<FieldNoteInterviewPreload | undefined>();
  const fieldNoteHandoffToken = useRef(0);
  const [view, setView] = useState<JackView>(() => {
    if (interviewPreload) return "interview";
    const requested = new URLSearchParams(window.location.search).get("view");
    return requested === "review" ? "review" : "graph";
  });
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatContext, setChatContext] = useState<string | undefined>();
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [accountDeleteOpen, setAccountDeleteOpen] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [accountDeleteError, setAccountDeleteError] = useState<string | null>(null);
  // Set when the drawer is opened via "Resume" on a parked chat thought — shows
  // a reorientation banner atop the conversation. Cleared on close so the next
  // plain "Ask Jack" open (no resume) doesn't show a stale banner.
  const [resumedThought, setResumedThought] = useState<ParkedThought | null>(null);
  // A monotonically-increasing token so clicking the *same* citation twice still
  // re-triggers a seek; `time` is the target position in seconds.
  const [seek, setSeek] = useState<{ time: number; token: number } | undefined>();

  const graph = useMemoryGraphData();

  useEffect(() => {
    if (!graph.isLoading) {
      window.__JACK_MARK_READY__?.();
    }
  }, [graph.isLoading]);

  // Keep the Torch handoff for the initial interview, then consume it before
  // navigation can unmount InterviewMode. A later remount must resume the real
  // active session instead of treating this stale handoff as a fresh interview.
  useEffect(() => {
    if (!interviewPreload) return;
    if (view === "interview" && !selectedVideoId && !fieldNotePreload) return;
    setInterviewPreload(undefined);
  }, [fieldNotePreload, interviewPreload, selectedVideoId, view]);

  // Beta user-testing mode: the "Start User Test" button in JackShell opens
  // the consent modal via this imperative handle; TestingOverlay also opens
  // itself on `?test=true`. See components/testing/TestingOverlay.tsx.
  const testingOverlayRef = useRef<TestingOverlayHandle>(null);
  const feedbackRef = useRef<UserTestFeedbackHandle>(null);
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
  const isPresentationDemo = me?.userId === "presentation-demo";
  const isSignedIn = Boolean(me?.userId);
  const hasAuthenticatedSession = isSignedIn && !isPresentationDemo;
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
    feedbackRef.current?.markFeature("video_detail");
    setSeek(undefined);
    setSelectedVideoId(videoId);
  };

  const handleNavigate = (next: JackView) => {
    const feature = {
      graph: "memory_graph",
      library: "library",
      interview: "interview_mode",
      review: "knowledge_review",
    } as const;
    feedbackRef.current?.markFeature(feature[next]);
    setSelectedVideoId(null);
    setFieldNotePreload(undefined);
    setView(next);
  };

  const handleFieldNoteClick = (citation: Citation) => {
    setIsChatOpen(false);
    setResumedThought(null);
    setSelectedVideoId(null);
    setInterviewPreload(undefined);
    fieldNoteHandoffToken.current += 1;
    setFieldNotePreload({ title: citation.videoTitle, text: citation.text });
    setView("interview");
  };

  const deleteAccount = async () => {
    if (deletePhrase !== "DELETE" || deletingAccount) return;
    setDeletingAccount(true);
    setAccountDeleteError(null);
    try {
      const response = await fetch("/api/account", { method: "DELETE", credentials: "include" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not delete your account.");
      }
      window.location.assign("/api/auth/reset-session");
    } catch (error) {
      setAccountDeleteError(error instanceof Error ? error.message : "Could not delete your account.");
      setDeletingAccount(false);
    }
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

  const handleSignOut = () => {
    if (!onSignOut) return;
    if (feedbackRef.current) {
      feedbackRef.current.request("logout", onSignOut);
      return;
    }
    void onSignOut();
  };

  const handleInterviewComplete = () => {
    feedbackRef.current?.markFeature("interview_mode");
    feedbackRef.current?.request("interview_complete");
  };

  const handleAskJackComplete = () => {
    feedbackRef.current?.markFeature("ask_jack");
    feedbackRef.current?.request("ask_jack_complete");
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
        onOpenSettings={
          hasAuthenticatedSession
            ? () => {
                setAccountSettingsOpen(true);
                return;
              }
            : undefined
        }
        onSignOut={
          hasAuthenticatedSession && onSignOut ? handleSignOut : undefined
        }
        onStartUserTest={!isPresentationDemo && me?.isAdmin === false ? handleStartUserTest : undefined}
        userTestingRequired={!isPresentationDemo && me?.isAdmin === false && testingGate.restricted}
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
          <InterviewMode
            key={fieldNotePreload ? `field-note-${fieldNoteHandoffToken.current}` : "interview"}
            preload={interviewPreload}
            fieldNote={fieldNotePreload}
            onComplete={handleInterviewComplete}
          />
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
        onFieldNoteClick={handleFieldNoteClick}
        onMeaningfulSessionComplete={handleAskJackComplete}
      />

      <TestingOverlay
        ref={testingOverlayRef}
        autoPrompt={me?.isAdmin === false}
        onEvent={handleTestingEvent}
      />
      <UserTestFeedback
        ref={feedbackRef}
        consented={testingGate.accepted}
        userId={isSignedIn && !isPresentationDemo ? me?.userId : null}
      />

      <AlertDialog open={accountSettingsOpen} onOpenChange={setAccountSettingsOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Account & privacy</AlertDialogTitle>
            <AlertDialogDescription>
              You control your participation. You can remove videos you uploaded from the Library, or permanently delete your account and its associated Jack data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg border border-destructive/35 bg-destructive/10 p-4">
            <p className="font-semibold text-destructive">Delete account</p>
            <p className="mt-1 text-sm text-muted-foreground">This removes your sign-in, uploaded videos, interviews, chat history, parked thoughts, and test recordings. It cannot be undone.</p>
            <Button className="mt-3" variant="destructive" onClick={() => { setAccountDeleteError(null); setDeletePhrase(""); setAccountDeleteOpen(true); }}>
              Delete my account
            </Button>
          </div>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setAccountSettingsOpen(false)}>Done</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={accountDeleteOpen} onOpenChange={setAccountDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Permanently delete your account?</AlertDialogTitle>
            <AlertDialogDescription>Type DELETE to confirm. This cannot be reversed.</AlertDialogDescription>
          </AlertDialogHeader>
          <Input value={deletePhrase} onChange={(event) => setDeletePhrase(event.target.value)} placeholder="Type DELETE" aria-label="Account deletion confirmation" autoComplete="off" />
          {accountDeleteError && <p className="text-sm text-destructive">{accountDeleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingAccount}>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={deletePhrase !== "DELETE" || deletingAccount} onClick={(event) => { event.preventDefault(); void deleteAccount(); }}>
              {deletingAccount ? "Deleting..." : "Delete account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// The authenticated app surface. Only mounted for signed-in users, so its
// data-fetching hooks (useMemoryGraphData, useGetMe, …) never fire for anon.
function AppSurface({ onSignOut }: { onSignOut?: () => void | Promise<void> }) {
  return (
    <TooltipProvider>
      <JackApp onSignOut={onSignOut} />
      <Toaster />
    </TooltipProvider>
  );
}

export function AuthenticatedAppSurface() {
  const { signOut } = useClerk();
  return <AppSurface onSignOut={() => signOut({ redirectUrl: `${basePath}/sign-in` })} />;
}

function StartupReady() {
  useEffect(() => {
    window.__JACK_MARK_READY__?.();
  }, []);
  return null;
}

function SignInPage() {
  if (window.location.pathname.endsWith("/sso-callback")) {
    return <AuthenticateWithRedirectCallback />;
  }
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <StartupReady />
      <EmailCodeSignIn />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <StartupReady />
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        forceRedirectUrl={useDirectClerkAssets ? `${window.location.origin}${basePath}/app` : undefined}
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
        <StartupReady />
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
        <AuthenticatedAppSurface />
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

function AuthBridge({ onReady }: { onReady: () => void }) {
  const { isLoaded, getToken } = useAuth();
  useEffect(() => {
    setAuthTokenGetter(() => getToken());
    return () => setAuthTokenGetter(null);
  }, [getToken]);
  useEffect(() => {
    if (isLoaded) onReady();
  }, [isLoaded, onReady]);
  return null;
}

function ClerkProviderWithRoutes({ onReady }: { onReady: () => void }) {
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
        <AuthBridge onReady={onReady} />
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

function AuthStartupScreen() {
  return (
    <div
      className="fixed inset-0 z-[100] flex min-h-[100dvh] items-center justify-center bg-background px-6 text-center"
      role="status"
      aria-live="polite"
    >
      <div>
        <img className="mx-auto h-16 w-16" src={`${basePath}/logo.svg`} alt="" />
        <p className="mt-5 text-lg font-semibold text-foreground">Starting Jack…</p>
        <p className="mt-1 text-sm text-muted-foreground">Connecting your secure session</p>
      </div>
    </div>
  );
}

function AuthUnavailableScreen() {
  useEffect(() => {
    window.__JACK_MARK_READY__?.();
  }, []);

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6 text-center">
      <div className="max-w-md rounded-2xl border border-border bg-card p-8 shadow-2xl">
        <img className="mx-auto h-14 w-14" src={`${basePath}/logo.svg`} alt="" />
        <h1 className="mt-5 text-2xl font-semibold text-foreground">Sign-in is temporarily unavailable</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Jack stays locked until the secure session service reconnects.
        </p>
        <Button className="mt-6" onClick={() => window.location.reload()}>Try again</Button>
      </div>
    </div>
  );
}

function ManagedAppEntry() {
  const [authReady, setAuthReady] = useState(false);
  const [authTimedOut, setAuthTimedOut] = useState(false);

  useEffect(() => {
    if (authReady) return;
    const timeout = window.setTimeout(() => setAuthTimedOut(true), AUTH_STARTUP_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [authReady]);

  if (authTimedOut && !authReady) {
    return <AuthUnavailableScreen />;
  }

  return (
    <>
      {!authReady && <AuthStartupScreen />}
      <ClerkProviderWithRoutes onReady={() => setAuthReady(true)} />
    </>
  );
}

function App() {
  return <ManagedAppEntry />;
}

export default App;
