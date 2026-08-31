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
import { PilotActivityReports } from "./components/PilotActivityReports";
import { EndOfShiftCloseout } from "./components/EndOfShiftCloseout";
import { MemoryGraphView } from "./components/MemoryGraphView";
import { Landing } from "./components/Landing";
import {
  TestingOverlay,
  type TestingOverlayEvent,
  type TestingOverlayHandle,
} from "./components/testing/TestingOverlay";
import { UserTestingGate } from "./components/testing/UserTestingGate";
import {
  TelemetryConsentModal,
  type TelemetryConsentChoices,
} from "./components/testing/TelemetryConsentModal";
import {
  UserTestFeedback,
  type UserTestFeedbackHandle,
} from "./components/testing/UserTestFeedback";
import { useMemoryGraphData } from "./lib/use-memory-graph";
import { timeAgo } from "./lib/memory-graph";
import {
  cacheTestSession,
  exportTelemetry,
  initializeTelemetryRetry,
  loadTelemetryContext,
  saveTelemetryConsents,
  setTelemetryIdentity,
  startTestSession,
  trackTestEvent,
  withdrawTelemetry,
  type TelemetryContext,
} from "./lib/user-testing/test-session-service";
import { setFeedbackSessionId } from "./lib/user-testing/feedback-service";
import { handoffInterviewResume } from "./lib/interview-resume";
import { setAuthTokenGetter, useGetMe, type Citation, type ParkedThought } from "@workspace/api-client-react";

const queryClient = new QueryClient();

const configuredClerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const pilotAuthBypass = import.meta.env.VITE_PILOT_AUTH_BYPASS === "true";
const isLocalClerkHost =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.hostname === "[::1]";
const isRailwayPreviewHost = window.location.hostname.endsWith(".up.railway.app");
const useDirectClerkAssets = isLocalClerkHost || isRailwayPreviewHost;
const clerkProxyEnabled =
  import.meta.env.VITE_ENABLE_CLERK_PROXY === "true" &&
  import.meta.env.VITE_DISABLE_CLERK_PROXY !== "true";
const useClerkAssetsFromProxy =
  clerkProxyEnabled && !useDirectClerkAssets;

// Local IP hosts are not valid Clerk custom domains. Resolving 127.0.0.1 through
// publishableKeyFromHost produces clerk.127.0.0.1 and prevents ClerkJS loading.
// Deployed hosts still use host-aware resolution for Torch's custom domains.
const clerkPubKey = configuredClerkPubKey;

// Production auth can be routed through Jack's same-origin server proxy so
// privacy tools and restrictive networks do not need direct Clerk FAPI access.
const clerkProxyUrl =
  isLocalClerkHost
    ? `${window.location.origin}/api/__clerk`
    : clerkProxyEnabled
    ? import.meta.env.VITE_CLERK_PROXY_URL
    : undefined;

const localClerkJsUrl = useDirectClerkAssets
  ? "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6/dist/clerk.browser.js"
  : useClerkAssetsFromProxy
  ? `${window.location.origin}/api/__clerk/npm/@clerk/clerk-js@6/dist/clerk.browser.js`
  : "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6/dist/clerk.browser.js";
// Clerk UI is served by the instance Frontend API, not the public npm CDN.
// Derive that origin from the configured publishable key as Clerk documents.
const clerkFrontendApiOrigin = (() => {
  const encodedFrontendApi = clerkPubKey?.split("_")[2];
  if (!encodedFrontendApi) return undefined;

  try {
    const frontendApiHost = atob(encodedFrontendApi).slice(0, -1);
    return frontendApiHost ? `https://${frontendApiHost}` : undefined;
  } catch {
    return undefined;
  }
})();
const localClerkUiUrl = useClerkAssetsFromProxy
  ? `${window.location.origin}/api/__clerk/npm/@clerk/ui@1/dist/ui.browser.js`
  : `${clerkFrontendApiOrigin ?? window.location.origin}/npm/@clerk/ui@1/dist/ui.browser.js`;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const TORCH_INTERVIEW_HANDOFF_KEY = "jack.torchInterviewHandoff";
const USER_TESTING_DECLINED_KEY = "jack.userTesting.declinedWithoutRecording.v1";
const USER_TESTING_ACCEPTED_KEY = "jack.userTesting.acceptedWithoutRecording.v1";
const AUTH_STARTUP_TIMEOUT_MS = 6_000;

function userTestingDeclinedKey(userId: string) {
  return `${USER_TESTING_DECLINED_KEY}:${userId}`;
}

function readUserTestingDeclined(userId?: string | null): boolean {
  if (!userId) return false;
  try {
    return localStorage.getItem(userTestingDeclinedKey(userId)) === "true";
  } catch {
    return false;
  }
}

function persistUserTestingDeclined(userId?: string | null) {
  if (!userId) return;
  try {
    localStorage.setItem(userTestingDeclinedKey(userId), "true");
  } catch {
    // Local storage may be unavailable; keep current session behavior.
  }
}

function clearUserTestingDeclined(userId?: string | null) {
  if (!userId) return;
  try {
    localStorage.removeItem(userTestingDeclinedKey(userId));
  } catch {
    // Storage can be unavailable; preserve current session state.
  }
}

function userTestingAcceptedKey(userId: string) {
  return `${USER_TESTING_ACCEPTED_KEY}:${userId}`;
}

function readUserTestingAccepted(userId?: string | null): boolean {
  if (!userId) return false;
  try {
    return localStorage.getItem(userTestingAcceptedKey(userId)) === "true";
  } catch {
    return false;
  }
}

function persistUserTestingAccepted(userId?: string | null) {
  if (!userId) return;
  try {
    localStorage.setItem(userTestingAcceptedKey(userId), "true");
  } catch {
    // Local storage may be unavailable; keep current session behavior.
  }
}

function clearUserTestingAccepted(userId?: string | null) {
  if (!userId) return;
  try {
    localStorage.removeItem(userTestingAcceptedKey(userId));
  } catch {
    // Storage can be unavailable; preserve current session state.
  }
}

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

if (!pilotAuthBypass && !clerkPubKey) {
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
    if (requested === "review") return "review";
    if (requested === "closeout") return "closeout";
    return "graph";
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
  const testingAcceptanceInProgress = useRef(false);

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
  const shouldAutoPromptUserTesting = new URLSearchParams(window.location.search).get("test") === "true";
  const testingOverlayRef = useRef<TestingOverlayHandle>(null);
  const feedbackRef = useRef<UserTestFeedbackHandle>(null);
  const testStartPendingRef = useRef(false);
  const testStartOwnerRef = useRef<string | null>(null);
  const [testStartPending, setTestStartPending] = useState(false);
  const [telemetryContext, setTelemetryContext] = useState<TelemetryContext | null>(null);
  const telemetryContextUserIdRef = useRef<string | null>(null);
  const [telemetryConsentOpen, setTelemetryConsentOpen] = useState(false);
  const [testingGate, setTestingGate] = useState<{
    accepted: boolean;
    restricted: boolean;
  }>(() => ({
    accepted: false,
    restricted: true,
  }));
  useEffect(() => {
    if (testingGate.accepted) {
      testingAcceptanceInProgress.current = false;
    }
  }, [testingGate.accepted]);

  // Signed-in identity (for the sidebar) + sign-out. Every user reaching this
  // component is authenticated; `isAdmin` only tunes which controls appear.
  const { data: me } = useGetMe();
  const isSignedIn = Boolean(me?.userId);
  const userLabel = me?.name ?? me?.email ?? "Account";
  const userSubLabel = me?.isAdmin ? "Administrator" : "Signed in";

  useEffect(() => {
    testingAcceptanceInProgress.current = false;
    testStartPendingRef.current = false;
    testStartOwnerRef.current = null;
    setTestStartPending(false);

    if (me?.isAdmin !== false || !me?.userId) {
      setTestingGate({ accepted: false, restricted: true });
      return;
    }

    const accepted = readUserTestingAccepted(me.userId);
    setTestingGate({
      accepted,
      restricted: accepted ? false : !readUserTestingDeclined(me.userId),
    });
  }, [me?.userId, me?.isAdmin]);

  useEffect(() => {
    if (testingOverlayRef.current == null) return;
    if (!shouldAutoPromptUserTesting) return;
    if (me?.isAdmin !== false) return;
    if (testingGate.accepted || testingGate.restricted === false) return;
    const markerUser = me?.userId ? readUserTestingDeclined(me.userId) : false;
    if (markerUser) return;
    const timer = window.setTimeout(() => {
      testingOverlayRef.current?.open();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [me?.userId, me?.isAdmin]);

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
      reports: null,
      closeout: null,
    } as const;
    if (feature[next]) {
      feedbackRef.current?.markFeature(feature[next]);
      void trackTestEvent("feature_viewed", { feature: feature[next] });
    }
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

  const launchTestSession = async (pilotId?: string) => {
    const requestUserId = me?.userId;
    if (
      !requestUserId ||
      (testStartPendingRef.current && testStartOwnerRef.current === requestUserId)
    ) {
      return;
    }

    testStartPendingRef.current = true;
    testStartOwnerRef.current = requestUserId;
    setTestStartPending(true);
    try {
      const session = await startTestSession(pilotId, {
        requestKey: requestUserId,
        shouldCache: () => telemetryContextUserIdRef.current === requestUserId,
      });
      if (telemetryContextUserIdRef.current !== requestUserId) return;

      setFeedbackSessionId(session.id);
      setTelemetryContext((current) =>
        current ? { ...current, session } : current,
      );
      handleNavigate("graph");
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent("jack:test-session-started", { detail: session }));
      }, 0);
    } catch (error) {
      if (telemetryContextUserIdRef.current === requestUserId) {
        window.alert(error instanceof Error ? error.message : "Test could not start. Please try again.");
      }
    } finally {
      if (testStartOwnerRef.current === requestUserId) {
        testStartPendingRef.current = false;
        testStartOwnerRef.current = null;
        setTestStartPending(false);
      }
    }
  };

  const handleStartUserTest = async () => {
    const requestUserId = me?.userId;
    if (
      !requestUserId ||
      (testStartPendingRef.current && testStartOwnerRef.current === requestUserId)
    ) {
      return;
    }

    setTestingGate((prev) => ({ ...prev, restricted: false }));
    let context = telemetryContext;
    if (!context) {
      try {
        context = await loadTelemetryContext(undefined, {
          shouldCache: () => telemetryContextUserIdRef.current === requestUserId,
        });
      } catch {
        if (telemetryContextUserIdRef.current === requestUserId) {
          testingOverlayRef.current?.open();
        }
        return;
      }
      if (telemetryContextUserIdRef.current !== requestUserId) return;
      setTelemetryContext(context);
    }
    if (
      telemetryContextUserIdRef.current !== requestUserId ||
      !context ||
      !context.enrolled ||
      !context.scope
    ) {
      testingOverlayRef.current?.open();
      return;
    }
    if (context.session) {
      setFeedbackSessionId(context.session.id);
      testingOverlayRef.current?.open();
      return;
    }
    if (
      context.consents.telemetry?.state === "granted" &&
      context.consents.telemetry.privacyNoticeVersion === context.privacyNoticeVersion &&
      context.consents.telemetry.consentVersion === context.consentVersion
    ) {
      await launchTestSession(context.scope.pilotId);
      if (telemetryContextUserIdRef.current === requestUserId) {
        testingOverlayRef.current?.open();
      }
      return;
    }
    setTelemetryConsentOpen(true);
  };

  const handleTestingEvent = (event: TestingOverlayEvent) => {
    if (event === "declined") {
      // A late decline can arrive after "started" or "unavailable" in the same
      // batched transition; keep the unlocked state once the gate has opened.
      if (testingGate.accepted || testingAcceptanceInProgress.current) return;
      persistUserTestingDeclined(me?.userId);
      clearUserTestingAccepted(me?.userId);
      setTestingGate((prev) => {
        if (prev.accepted) return prev;
        return { accepted: false, restricted: false };
      });
      return;
    }
    if (event === "started") {
      clearUserTestingDeclined(me?.userId);
      persistUserTestingAccepted(me?.userId);
      testingAcceptanceInProgress.current = true;
      setTestingGate({ accepted: true, restricted: false });
      return;
    }
    if (event === "unavailable" || event === "cancelled") {
      if (testingGate.accepted || testingAcceptanceInProgress.current) return;
      clearUserTestingDeclined(me?.userId);
      setTestingGate((prev) => {
        if (prev.accepted) return prev;
        return { accepted: false, restricted: false };
      });
      return;
    }
  };

  const handleTelemetryConsent = async (choices: TelemetryConsentChoices) => {
    const requestUserId = me?.userId;
    const consentScope = telemetryContext?.scope;
    if (
      !requestUserId ||
      !consentScope ||
      (testStartPendingRef.current && testStartOwnerRef.current === requestUserId)
    ) {
      return;
    }

    const consentContext = telemetryContext;
    testStartPendingRef.current = true;
    testStartOwnerRef.current = requestUserId;
    setTestStartPending(true);
    try {
      const context = await saveTelemetryConsents({
        pilotId: consentScope.pilotId,
        ...choices,
        privacyNoticeVersion: consentContext.privacyNoticeVersion,
        consentVersion: consentContext.consentVersion,
      });
      if (telemetryContextUserIdRef.current !== requestUserId) return;

      setTelemetryContext(context);
      setTelemetryConsentOpen(false);
      if (choices.telemetry !== "granted") {
        persistUserTestingDeclined(requestUserId);
        clearUserTestingAccepted(requestUserId);
        setTestingGate({ accepted: false, restricted: false });
      }
    } catch (error) {
      if (telemetryContextUserIdRef.current === requestUserId) {
        window.alert(error instanceof Error ? error.message : "Consent choices could not be saved.");
      }
    } finally {
      if (testStartOwnerRef.current === requestUserId) {
        testStartPendingRef.current = false;
        testStartOwnerRef.current = null;
        setTestStartPending(false);
      }
    }
  };

  const handleTelemetryWithdrawal = async (
    scopes: Array<"telemetry" | "screen" | "microphone">,
  ) => {
    const requestUserId = me?.userId;
    const pilotId = telemetryContext?.scope?.pilotId;
    if (!requestUserId || !pilotId) return;

    try {
      await withdrawTelemetry(pilotId, scopes);
      if (telemetryContextUserIdRef.current !== requestUserId) return;

      const context = await loadTelemetryContext(pilotId, {
        shouldCache: () => telemetryContextUserIdRef.current === requestUserId,
      });
      if (telemetryContextUserIdRef.current === requestUserId) {
        setTelemetryContext(context);
      }
    } catch (error) {
      if (telemetryContextUserIdRef.current === requestUserId) {
        window.alert(error instanceof Error ? error.message : "Consent could not be withdrawn.");
      }
    }
  };

  useEffect(() => {
    telemetryContextUserIdRef.current = null;
    setTelemetryContext(null);
    setTelemetryConsentOpen(false);
    if (!me) return;

    const contextUserId =
      me.isAdmin === false && me.userId ? me.userId : null;
    telemetryContextUserIdRef.current = contextUserId;
    setTelemetryIdentity(contextUserId);
    if (!contextUserId) return;

    const stopRetry = initializeTelemetryRetry();
    const abortController = new AbortController();
    let cancelled = false;

    void loadTelemetryContext(undefined, {
      signal: abortController.signal,
      shouldCache: () =>
        !cancelled && telemetryContextUserIdRef.current === contextUserId,
    })
      .then((context) => {
        if (
          cancelled ||
          telemetryContextUserIdRef.current !== contextUserId
        ) {
          return;
        }
        setTelemetryContext(context);
      })
      .catch(() => {
        if (
          !cancelled &&
          telemetryContextUserIdRef.current === contextUserId
        ) {
          setTelemetryContext(null);
        }
      });

    return () => {
      cancelled = true;
      abortController.abort();
      stopRetry();
    };
  }, [me?.userId, me?.isAdmin]);

  useEffect(() => {
    if (
      me?.isAdmin !== false ||
      !me?.userId ||
      !telemetryContext ||
      telemetryContextUserIdRef.current !== me.userId
    ) {
      return;
    }

    const context = telemetryContext;
    const session = context.session;
    if (session) {
      setFeedbackSessionId(session.id);
      if (session.onboardingStatus !== "completed") {
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent("jack:test-session-started", { detail: session }));
        }, 0);
      }
      return;
    }

    if (!context.enrolled || !context.scope) return;

    const telemetryConsent = context.consents.telemetry;
    if (
      !telemetryConsent ||
      telemetryConsent.privacyNoticeVersion !== context.privacyNoticeVersion ||
      telemetryConsent.consentVersion !== context.consentVersion
    ) {
      setTelemetryConsentOpen(true);
      return;
    }

    if (telemetryConsent.state !== "granted") return;

    const contextUserId = me.userId;
    const pilotId = context.scope.pilotId;
    const retryDelays = [500, 1_500, 3_000, 10_000, 30_000] as const;
    const abortController = new AbortController();
    let cancelled = false;
    let completed = false;
    let starting = false;
    let retryAttempt = 0;
    let retryTimer: number | undefined;

    const startScopedSession = async () => {
      if (cancelled || starting) return;
      starting = true;
      try {
        const startedSession = await startTestSession(pilotId, {
          signal: abortController.signal,
          requestKey: contextUserId,
          shouldCache: () =>
            !cancelled &&
            telemetryContextUserIdRef.current === contextUserId,
        });
        if (
          cancelled ||
          telemetryContextUserIdRef.current !== contextUserId
        ) {
          return;
        }
        completed = true;
        setFeedbackSessionId(startedSession.id);
        setTelemetryContext({ ...context, session: startedSession });
      } catch {
        if (cancelled) return;
        const delay =
          retryDelays[Math.min(retryAttempt, retryDelays.length - 1)] ??
          30_000;
        retryAttempt += 1;
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined;
          void startScopedSession();
        }, delay);
      } finally {
        starting = false;
      }
    };

    const retryOnReconnect = () => {
      if (cancelled || starting) return;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      retryAttempt = 0;
      void startScopedSession();
    };

    const cancelBootstrap = () => {
      cancelled = true;
      if (!completed) {
        abortController.abort();
        cacheTestSession(null);
      }
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    };

    window.addEventListener("online", retryOnReconnect);
    window.addEventListener("jack:telemetry-withdrawn", cancelBootstrap);
    void startScopedSession();

    return () => {
      cancelBootstrap();
      window.removeEventListener("online", retryOnReconnect);
      window.removeEventListener("jack:telemetry-withdrawn", cancelBootstrap);
    };
  }, [me?.userId, me?.isAdmin, telemetryContext]);

  useEffect(() => {
    const continueTest = () => testingOverlayRef.current?.open();
    window.addEventListener("jack:test-onboarding-completed", continueTest);
    return () => window.removeEventListener("jack:test-onboarding-completed", continueTest);
  }, []);

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
  // graph. Browser storage is only the handoff; Interview Mode reconstructs the
  // owner-scoped server session on mount. If the handoff cannot be stored, stay
  // on the graph so the durable mentor action remains available.
  const handleResumeInterview = (sessionId: string) => {
    handoffInterviewResume(sessionId, () => {
      setSelectedVideoId(null);
      setView("interview");
    });
  };

  const inGraph = view === "graph" && !selectedVideoId;
  const activeNav: JackView = selectedVideoId ? "library" : view;
  const canViewCloseout = me?.isAdmin === false && !!(telemetryContext?.scope?.pilotId);

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
        onOpenSettings={() => {
          if (isSignedIn) {
            setAccountSettingsOpen(true);
            return;
          }
          // Defensive fallback while identity is loading.
          window.location.assign(`${basePath}/sign-in`);
        }}
        onSignOut={isSignedIn && onSignOut ? handleSignOut : undefined}
        onStartUserTest={
          me?.isAdmin === false
            ? handleStartUserTest
            : undefined
        }
        userTestStarting={testStartPending}
        canViewPilotReports={me?.canViewPilotReports === true}
        canUseParticipantCloseout={canViewCloseout}
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
        ) : view === "reports" ? (
          <PilotActivityReports />
        ) : view === "closeout" ? (
          <EndOfShiftCloseout
            participantId={me?.userId ?? "participant"}
            participantName={me?.name || me?.email}
            organizationName={telemetryContext?.scope?.organizationName}
            pilotName={telemetryContext?.scope?.pilotName}
            organizationId={telemetryContext?.scope?.organizationId}
            pilotId={telemetryContext?.scope?.pilotId}
          />
        ) : (
          <Library onSelectVideo={handleSelectVideo} />
        )}
      </JackShell>

      <TelemetryConsentModal
        open={telemetryConsentOpen}
        saving={testStartPending}
        onSave={(choices) => void handleTelemetryConsent(choices)}
        onClose={() => setTelemetryConsentOpen(false)}
      />
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
        onEvent={handleTestingEvent}
      />
      <UserTestFeedback
        ref={feedbackRef}
        consented={testingGate.accepted}
        userId={isSignedIn ? me?.userId : null}
        pilotId={telemetryContext?.scope?.pilotId}
      />

      <AlertDialog open={accountSettingsOpen} onOpenChange={setAccountSettingsOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Account & privacy</AlertDialogTitle>
            <AlertDialogDescription>
              You control your participation. Ask Jack conversations are stored as product history separately from optional activity telemetry.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {telemetryContext?.scope && (
            <div className="rounded-lg border border-border p-4">
              <p className="font-semibold">Pilot telemetry</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Export your activity data or withdraw consent. Withdrawal stops future collection and active recording immediately and schedules attributable telemetry for deletion within 30 days.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outline" onClick={exportTelemetry}>Export telemetry</Button>
                {telemetryContext.consents.microphone?.state === "granted" && (
                  <Button
                    variant="outline"
                    onClick={() => void handleTelemetryWithdrawal(["microphone"])}
                  >
                    Withdraw microphone
                  </Button>
                )}
                {telemetryContext.consents.screen?.state === "granted" && (
                  <Button
                    variant="outline"
                    onClick={() => void handleTelemetryWithdrawal(["screen"])}
                  >
                    Withdraw screen recording
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={() => void handleTelemetryWithdrawal(["telemetry"])}
                >
                  Withdraw telemetry
                </Button>
              </div>
            </div>
          )}
          <div className="rounded-lg border border-destructive/35 bg-destructive/10 p-4">
            <p className="font-semibold text-destructive">Delete account</p>
            <p className="mt-1 text-sm text-muted-foreground">This removes your sign-in, uploaded videos, interviews, Ask Jack history, parked thoughts, feedback, pilot sessions, activity events, and test recordings. It cannot be undone.</p>
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

function AuthenticatedAppSurface() {
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

function PilotBypassApp() {
  useEffect(() => {
    setAuthTokenGetter(null);
    window.__JACK_MARK_READY__?.();
    return () => setAuthTokenGetter(null);
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <AppSurface />
    </QueryClientProvider>
  );
}

function App() {
  return pilotAuthBypass ? <PilotBypassApp /> : <ManagedAppEntry />;
}

export default App;
