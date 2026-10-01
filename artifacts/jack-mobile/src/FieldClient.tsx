import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAuth, useClerk } from "@clerk/clerk-expo";
import NetInfo from "@react-native-community/netinfo";
import {
  AudioModule,
  setAudioModeAsync,
  createAudioPlayer,
  type AudioPlayer,
} from "expo-audio";
import { File } from "expo-file-system";
import { randomUUID } from "expo-crypto";
import { useVideoPlayer, VideoView, type VideoPlayer } from "expo-video";
import { Action, BrandLockup, styles, theme } from "./ui";
import {
  JackApi,
  authorizedMediaUrl,
  officialSourceUrl,
  type ChatResponse,
  type Citation,
  type SourceDetail,
} from "./core/api";
import { encodeContext, type Surface } from "./core/context";
import { CapabilityBus } from "./core/capabilities";
import { RequestScope } from "./core/request-scope";
import { audioDirectory } from "./media-store";
import {
  createNativeRecorderOwner,
  useRecorderStatus,
} from "./native-recorder";
import { disposePlayback } from "./core/playback-owner";

type OpenSource = SourceDetail & {
  id: string;
  kind: "video" | "knowledge";
  startTime: number;
  media?: { uri: string; headers: Record<string, string>; useCaching: false };
};

function SourceVideo({
  source,
  onPlayback,
  bindPlayer,
}: {
  source: OpenSource;
  onPlayback: (playing: boolean) => void;
  bindPlayer: (player: VideoPlayer | null) => void;
}) {
  const [error, setError] = useState("");
  const initiallySought = useRef(false);
  const player = useVideoPlayer(source.media!);
  useEffect(() => {
    bindPlayer(player);
    const seekInitialCitation = () => {
      if (!initiallySought.current) {
        player.currentTime = source.startTime;
        initiallySought.current = true;
      }
    };
    if (player.status === "readyToPlay") seekInitialCitation();
    const listener = player.addListener("statusChange", (event) => {
      if (event.status === "readyToPlay") seekInitialCitation();
      if (event.status === "error")
        setError(
          "Source playback failed. Reopen the citation to refresh access, or check your connection.",
        );
    });
    const playing = player.addListener("playingChange", (event) =>
      onPlayback(event.isPlaying),
    );
    return () => {
      try {
        listener.remove();
      } catch {
        /* The SDK still owns release when its player unmounts. */
      }
      try {
        playing.remove();
      } catch {
        /* An already-detached listener cannot retain the bound player. */
      }
      bindPlayer(null);
    };
  }, [player, bindPlayer, onPlayback]);
  return (
    <View>
      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <VideoView
          player={player}
          style={{ width: "100%", height: 220 }}
          nativeControls
          allowsPictureInPicture={false}
        />
      )}
    </View>
  );
}

export function FieldClient() {
  const { getToken, sessionId, orgId } = useAuth();
  const { signOut } = useClerk();
  const api = useMemo(
    () =>
      new JackApi(
        process.env.EXPO_PUBLIC_JACK_API_URL ?? "https://jack.torchlabs.ca",
        getToken,
      ),
    [getToken],
  );
  const scope = useRef(new RequestScope()).current;
  const speechScope = useRef(new RequestScope()).current;
  const bus = useRef(new CapabilityBus()).current;
  const player = useRef<AudioPlayer | null>(null);
  const playerListener = useRef<{ remove(): void } | null>(null);
  const [playback, setPlayback] = useState({
    playing: false,
    didJustFinish: false,
  });
  const recorderError = useRef<() => void>(() => {});
  const [recorder] = useState(() =>
    createNativeRecorderOwner(() => recorderError.current()),
  );
  const recording = useRecorderStatus(recorder);
  const [surface, setSurface] = useState<Surface>("ask");
  const [source, setSource] = useState<OpenSource | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<ChatResponse | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [access, setAccess] = useState<"checking" | "granted" | "denied">(
    "checking",
  );
  const accessRef = useRef(access);
  accessRef.current = access;
  const [online, setOnline] = useState<boolean | null>(null);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const [radio, setRadio] = useState(false);
  const radioRef = useRef(false);
  const foregroundRef = useRef(foreground);
  const busyRef = useRef(false);
  const stopping = useRef(false);
  const audioFile = useRef<File | null>(null);
  const sourcePlayer = useRef<VideoPlayer | null>(null);
  const videoPlaying = useRef(false);
  const heardSpeech = useRef(false);
  const lastSpeechAt = useRef(0);
  const mounted = useRef(true);
  const lastOrg = useRef(orgId);
  const context = useRef({ surface, source });
  context.current = { surface, source };
  const contextHeader = () =>
    encodeContext(context.current.surface, context.current.source);

  async function checkAccess() {
    const request = scope.begin(20_000);
    setAccess("checking");
    try {
      await api.authorize(request.signal);
      if (request.current()) {
        setAccess("granted");
        setError("");
      }
    } catch (cause) {
      if (request.owns()) {
        void invalidate();
        setAccess("denied");
        setAnswer(null);
        setQuestion("");
        setError(
          cause instanceof Error
            ? cause.message
            : "Jack access could not be verified. Check your connection and retry.",
        );
      }
    } finally {
      request.finish();
    }
  }

  function deleteFile(uri: string | null) {
    if (!uri) return;
    const file = new File(uri);
    if (file.exists) file.delete();
  }

  const stopAudio = useCallback(async () => {
    speechScope.invalidate();
    const active = player.current;
    const listener = playerListener.current;
    playerListener.current = null;
    // Never replace(null): SDK55 Android requires a non-null source. Dispose each utterance instead.
    try {
      if (active) {
        disposePlayback({
          disconnect: () => listener?.remove(),
          pause: () => active.pause(),
          remove: () => active.remove(),
          release: () => active.release(),
        });
        // Keep ownership if release throws, so a new capture cannot bypass an unknown live player.
        player.current = null;
      }
    } finally {
      if (mounted.current)
        setPlayback({ playing: false, didJustFinish: false });
      const file = audioFile.current;
      audioFile.current = null;
      if (file?.exists) file.delete();
    }
  }, [player, speechScope]);

  const stopMicrophone = useCallback(() => recorder.discard(), [recorder]);

  const pauseSource = useCallback(() => {
    try {
      sourcePlayer.current?.pause();
      videoPlaying.current = false;
      return true;
    } catch {
      // Keep capture blocked until this source is stopped or released.
      videoPlaying.current = true;
      return false;
    }
  }, []);

  const invalidate = useCallback(
    (message = "", preserveRadio = false, preserveSource = false) => {
      scope.invalidate();
      if (!preserveRadio) {
        radioRef.current = false;
        setRadio(false);
      }
      busyRef.current = false;
      setBusy(false);
      setStatus(message);
      const sourcePaused = pauseSource();
      const stop = preserveSource
        ? Promise.all([bus.get("microphone")?.stop(), bus.get("audio")?.stop()])
        : bus.stopAll();
      return stop
        .then(() => {
          if (sourcePaused) return true;
          radioRef.current = false;
          setRadio(false);
          setError(
            "Source playback could not pause. Stop or close the video before starting Radio. You can still type your question.",
          );
          return false;
        })
        .catch(() => {
          setError(
            "Microphone recovery could not finish. You can still type your question.",
          );
          radioRef.current = false;
          setRadio(false);
          return false;
        });
    },
    [scope, bus, pauseSource],
  );

  recorderError.current = () => {
    if (!mounted.current) return;
    void invalidate(
      "Radio interrupted. Tap the microphone to try again.",
      false,
      true,
    );
    setError(
      "This recording was interrupted. Try the microphone again or type your question.",
    );
  };

  useEffect(() => {
    mounted.current = true;
    bus.attach({
      id: "microphone",
      permission: async () =>
        (await AudioModule.getRecordingPermissionsAsync()).granted
          ? "granted"
          : "denied",
      stop: stopMicrophone,
    });
    bus.attach({
      id: "audio",
      permission: async () => "granted",
      stop: stopAudio,
    });
    bus.attach({
      id: "source",
      permission: async () => "granted",
      stop: async () => {
        if (mounted.current) setSource(null);
      },
    });
    return () => {
      mounted.current = false;
      scope.invalidate();
      void recorder.dispose().catch(() => {});
      // No unhandled native release errors or updates to an unmounted private UI. Cold-start purge covers leftovers.
      void bus.detach("microphone").catch(() => {});
      void bus.detach("audio").catch(() => {});
      void bus.detach("source").catch(() => {});
    };
  }, [bus, scope, stopMicrophone, stopAudio]);

  useEffect(
    () =>
      NetInfo.addEventListener((state) =>
        setOnline(
          state.isConnected === false || state.isInternetReachable === false
            ? false
            : state.isConnected,
        ),
      ),
    [],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const active = next === "active";
      foregroundRef.current = active;
      setForeground(active);
      if (!active) {
        invalidate(
          "Radio paused. Return to Jack and start the microphone to resume.",
        );
        setAnswer(null);
        setQuestion("");
        setSource(null);
        setError("");
      }
    });
    return () => subscription.remove();
  }, [invalidate]);

  useEffect(() => {
    if (online === false)
      invalidate(
        "Offline. Questions and recording require a connection. Reconnect, then retry; nothing is queued.",
      );
  }, [online, invalidate]);

  useEffect(() => {
    if (orgId !== lastOrg.current) {
      lastOrg.current = orgId;
      invalidate("Organization changed. Ask your question again.");
      setAnswer(null);
      setQuestion("");
      setSource(null);
      setSurface("ask");
    }
  }, [orgId, invalidate]);

  // Run after organization invalidation so a new membership probe cannot be cancelled by the old scope.
  useEffect(() => {
    if (foreground && online !== false) void checkAccess();
  }, [api, orgId, foreground, online]);

  function navigate(next: Surface) {
    context.current = { surface: next, source: null };
    const stopped = invalidate("", true);
    const current = scope.capture();
    void stopped.then((success) => {
      if (!success || !current() || !mounted.current) return;
      if (accessRef.current !== "granted") void checkAccess();
      if (radioRef.current) void beginRecording();
    });
    setSource(null);
    setSurface(next);
    setError("");
  }

  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      if (surface === "ask") return false;
      navigate("ask");
      return true;
    });
    return () => listener.remove();
  }, [surface, invalidate]);

  async function speak(text: string) {
    const request = scope.begin(40_000);
    try {
      await stopAudio();
      if (!pauseSource())
        throw new Error(
          "Source playback could not pause. Stop or close the video before playing Jack's answer.",
        );
    } catch (cause) {
      request.finish();
      throw cause;
    }
    if (!request.current()) {
      request.finish();
      return;
    }
    speechScope.invalidate();
    const speechRequest = speechScope.begin(40_000);
    const current = () => request.current() && speechRequest.current();
    try {
      const bytes = await api.speech(
        text,
        contextHeader(),
        speechRequest.signal,
      );
      if (!current() || !foregroundRef.current) return;
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      });
      if (!current()) return;
      const file = new File(
        audioDirectory(),
        `jack-speech-${randomUUID()}.mp3`,
      );
      audioFile.current = file;
      file.create();
      file.write(bytes);
      const active = createAudioPlayer(file.uri);
      player.current = active;
      playerListener.current = active.addListener(
        "playbackStatusUpdate",
        (event) => {
          if (mounted.current && player.current === active)
            setPlayback({
              playing: event.playing,
              didJustFinish: event.didJustFinish,
            });
        },
      );
      active.play();
      setStatus("Jack is speaking. Replay is available below the answer.");
    } catch (cause) {
      if (!request.owns() || !speechRequest.owns()) return;
      // A native player/listener/play failure must dispose this utterance immediately.
      await stopAudio().catch(() => {});
      throw cause;
    } finally {
      if (
        request.owns() &&
        (request.signal.aborted || speechRequest.signal.aborted) &&
        speechRequest.owns()
      ) {
        radioRef.current = false;
        setRadio(false);
        setError("Voice playback timed out. Read Jack's answer or try replay.");
      }
      request.finish();
      speechRequest.finish();
    }
  }

  async function replay() {
    if (!answer || busyRef.current || radioRef.current) return;
    const request = scope.begin(45_000);
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await speak(answer.answer);
    } catch (cause) {
      if (request.owns())
        setError(cause instanceof Error ? cause.message : "Replay failed.");
    } finally {
      if (request.owns()) {
        busyRef.current = false;
        setBusy(false);
      }
      request.finish();
    }
  }

  async function ask(text: string) {
    if (
      busyRef.current ||
      access !== "granted" ||
      online === false ||
      !foregroundRef.current
    )
      return;
    if (!pauseSource()) {
      radioRef.current = false;
      setRadio(false);
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    setStatus("Jack is finding a grounded answer…");
    const request = scope.begin();
    try {
      // Keyboard/text is always usable: stop our own capture before sending, rather than silently rejecting the tap.
      const stopped = await Promise.allSettled([stopMicrophone(), stopAudio()]);
      if (stopped.some((result) => result.status === "rejected")) {
        radioRef.current = false;
        setRadio(false);
      }
      if (!request.current()) return;
      const result = await api.ask(text, contextHeader(), request.signal);
      if (!request.current()) return;
      setAnswer(result);
      setQuestion("");
      setStatus("Answer received.");
      request.finish();
      try {
        if (!recorder.available)
          throw new Error(
            "Audio is unavailable. Your answer is still readable.",
          );
        await speak(result.answer);
      } catch (cause) {
        if (request.owns()) {
          radioRef.current = false;
          setRadio(false);
          setError(
            cause instanceof Error
              ? `${cause.message} You can still read Jack's answer.`
              : "Voice is unavailable. You can still read the answer.",
          );
        }
      }
    } catch (cause) {
      if (request.owns()) {
        setError(
          request.signal.aborted
            ? "Request interrupted or timed out. Try again."
            : cause instanceof Error
              ? cause.message
              : "Connection failed. Try again.",
        );
        radioRef.current = false;
        setRadio(false);
      }
    } finally {
      if (request.owns()) {
        busyRef.current = false;
        setBusy(false);
      }
      request.finish();
    }
  }

  async function beginRecording() {
    if (
      !mounted.current ||
      !foregroundRef.current ||
      accessRef.current !== "granted" ||
      online === false ||
      videoPlaying.current ||
      stopping.current ||
      busyRef.current
    )
      return;
    const request = scope.begin(15_000);
    try {
      await stopAudio();
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!request.current()) return;
      if (!permission.granted) {
        radioRef.current = false;
        setRadio(false);
        setError(
          "Microphone permission denied. You can type a question or enable the microphone in Android Settings.",
        );
        return;
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      });
      if (!request.current()) return;
      const started = await recorder.start(
        () =>
          request.current() &&
          mounted.current &&
          foregroundRef.current &&
          radioRef.current,
      );
      if (started) {
        heardSpeech.current = false;
        lastSpeechAt.current = Date.now();
        setStatus(
          "Listening. Pause after your question, or tap Send voice now. Stop Radio ends the conversation.",
        );
      }
    } catch (cause) {
      if (request.owns()) {
        await recorder.discard().catch(() => {});
        radioRef.current = false;
        setRadio(false);
        setError(
          "Jack couldn't start the microphone. Tap Radio to try again, or type your question.",
        );
      }
    } finally {
      if (request.owns() && request.signal.aborted) {
        radioRef.current = false;
        setRadio(false);
        setError("Microphone start timed out. Start Radio again when ready.");
      }
      request.finish();
    }
  }

  async function sendRecording() {
    if (stopping.current || !recorder.isRecording) return;
    if (!heardSpeech.current) {
      void invalidate(
        "No speech heard. Radio paused; start it again or type a question.",
        false,
        true,
      );
      return;
    }
    stopping.current = true;
    const request = scope.begin(45_000);
    let uri: string | null = null;
    try {
      uri = await recorder.finish();
      if (!request.current() || !uri) return;
      setStatus("Transcribing your question…");
      busyRef.current = true;
      setBusy(true);
      const audio = new FormData();
      // React Native FormData supports native file descriptors, unlike browser FormData.
      audio.append("audio", {
        uri,
        name: "question.m4a",
        type: "audio/mp4",
      } as unknown as Blob);
      const text = await api.transcribe(audio, contextHeader(), request.signal);
      if (!request.current()) return;
      request.finish();
      setQuestion(text);
      busyRef.current = false;
      setBusy(false);
      await ask(text);
    } catch (cause) {
      if (request.owns()) {
        radioRef.current = false;
        setRadio(false);
        setError(
          cause instanceof Error
            ? cause.message
            : "Transcription failed. Type your question or try again.",
        );
      }
    } finally {
      try {
        deleteFile(uri);
      } catch {
        if (request.owns()) {
          radioRef.current = false;
          setRadio(false);
          setError(
            "Temporary recording cleanup failed. Radio is paused; you can still type your question.",
          );
        }
      } finally {
        stopping.current = false;
        if (request.owns()) {
          busyRef.current = false;
          setBusy(false);
        }
        request.finish();
      }
    }
  }

  useEffect(() => {
    if (!recording.isRecording || stopping.current) return;
    const now = Date.now();
    if ((recording.metering ?? -160) > -38) {
      heardSpeech.current = true;
      lastSpeechAt.current = now;
    }
    if (recording.durationMillis >= 55_000 && !heardSpeech.current) {
      void invalidate(
        "No speech heard. Radio paused; start it again or type a question.",
        false,
        true,
      );
      return;
    }
    if (
      (heardSpeech.current && now - lastSpeechAt.current > 1400) ||
      recording.durationMillis >= 55_000
    )
      void sendRecording();
    // Recorder metering owns turn detection; request scope guards all asynchronous completions.
  }, [recording.isRecording, recording.metering, recording.durationMillis]);

  useEffect(() => {
    if (!playback.didJustFinish) return;
    const current = scope.capture();
    void stopAudio()
      .then(() => {
        if (
          current() &&
          mounted.current &&
          radioRef.current &&
          foregroundRef.current
        )
          void beginRecording();
      })
      .catch(() => {
        if (!current() || !mounted.current) return;
        radioRef.current = false;
        setRadio(false);
        setError(
          "Voice playback could not stop. Radio is paused; you can still type your question.",
        );
      });
  }, [playback.didJustFinish]);

  const bindSourcePlayer = useCallback((video: VideoPlayer | null) => {
    sourcePlayer.current = video;
    videoPlaying.current = video?.playing ?? false;
  }, []);
  const onSourcePlayback = useCallback(
    (playing: boolean) => {
      videoPlaying.current = playing;
      if (playing) {
        scope.invalidate();
        busyRef.current = false;
        setBusy(false);
        setStatus(
          "Source video is playing. Radio capture pauses until playback stops.",
        );
        void Promise.all([stopMicrophone(), stopAudio()]).catch(() => {
          radioRef.current = false;
          setRadio(false);
          setError(
            "Audio could not stop. Stop playback and restart Radio Jack.",
          );
        });
      } else if (
        radioRef.current &&
        foregroundRef.current &&
        !busyRef.current
      ) {
        void beginRecording();
      }
    },
    [scope, stopMicrophone, stopAudio, access, online],
  );

  async function openCitation(citation: Citation) {
    if (citation.sourceType === "authority") {
      try {
        if (!citation.officialSourceUrl)
          throw new Error("This authority citation has no public source link.");
        invalidate("Opening the official source. Radio paused.");
        await Linking.openURL(officialSourceUrl(citation.officialSourceUrl));
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The official source could not open.",
        );
      }
      return;
    }
    context.current = { surface: "source", source: null };
    await invalidate("", true);
    setSurface("source");
    setSource(null);
    setStatus("Opening authorized source…");
    setError("");
    const kind: "knowledge" | "video" =
      citation.sourceType === "knowledge" ? "knowledge" : "video";
    const id = kind === "knowledge" ? citation.entryId : citation.videoId;
    const request = scope.begin(30_000);
    try {
      if (!id) throw new Error("This citation has no source ID.");
      const detail = await api.source(kind, id, request.signal);
      if (!request.current()) return;
      const media = detail.videoUrl
        ? {
            uri: authorizedMediaUrl(api.origin, detail.videoUrl, id),
            headers: await api.mediaHeaders(request.signal),
            useCaching: false as const,
          }
        : undefined;
      if (!request.current()) return;
      const opened: OpenSource = {
        ...detail,
        id,
        kind,
        startTime: citation.startTime,
        media,
      };
      context.current = { surface: "source", source: opened };
      setSource(opened);
      setStatus("Source opened.");
      if (radioRef.current) void beginRecording();
    } catch (cause) {
      if (request.owns()) {
        setError(
          cause instanceof Error ? cause.message : "Source could not open.",
        );
        if (radioRef.current) void beginRecording();
      }
    } finally {
      request.finish();
    }
  }

  async function logout() {
    invalidate();
    setAnswer(null);
    setQuestion("");
    setSource(null);
    try {
      await bus.stopAll();
      await signOut();
    } catch {
      setError(
        "Sign-out could not finish. Try again before sharing this device.",
      );
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={local.header}>
        <BrandLockup />
        <Action
          variant="secondary"
          title={surface === "ask" ? "Settings" : "Back to Ask"}
          onPress={() => navigate(surface === "ask" ? "settings" : "ask")}
        />
      </View>
      <Text style={local.signal}>
        {online === false
          ? "OFFLINE · no requests queued"
          : online === null
            ? "Checking connection…"
            : "ONLINE"}
        {!foreground ? " · Radio paused" : ""}
      </Text>
      <ScrollView
        contentContainerStyle={local.content}
        keyboardShouldPersistTaps="handled"
      >
        {surface === "settings" ? (
          <View style={local.card}>
            <Text style={local.heading}>Account & permissions</Text>
            <Text style={styles.body}>
              Microphone access is requested only when you start Radio Jack.
              Spoken questions are sent for transcription; recording consent
              does not approve publishing a recording to Living Memory.
            </Text>
            <Text style={styles.body}>
              Radio stays available across Jack's screens. It pauses when you
              leave Jack or lose the connection. Return and start it again.
              Answers and sources stay in memory only and clear when Jack
              backgrounds or you sign out. No offline answers or queued writes
              are stored.
            </Text>
            <Action
              title="Android app permissions"
              onPress={() => void Linking.openSettings()}
            />
            <Action title="Sign out" onPress={() => void logout()} />
          </View>
        ) : (
          <>
            {surface === "source" && (
              <View style={local.card}>
                <Text style={local.heading}>{source?.title ?? "Source"}</Text>
                {source?.media && (
                  <SourceVideo
                    key={`${sessionId}:${source.id}`}
                    source={source}
                    onPlayback={onSourcePlayback}
                    bindPlayer={bindSourcePlayer}
                  />
                )}
                {source && (
                  <Text selectable style={styles.body}>
                    {source.text}
                  </Text>
                )}
              </View>
            )}
            {answer ? (
              <View style={local.card}>
                <Text style={local.heading}>Jack's answer</Text>
                <Text selectable style={styles.body}>
                  {answer.answer}
                </Text>
                {answer.usedInternalKnowledge === false && (
                  <Text style={local.signal}>
                    No matching internal knowledge was found. Check Jack's
                    stated limits and sources.
                  </Text>
                )}
                <Action
                  variant="secondary"
                  title="Replay Jack's answer"
                  disabled={busy || radio || online === false}
                  onPress={() => void replay()}
                />
                <Text style={local.heading}>Sources</Text>
                {answer.citations.length === 0 ? (
                  <Text style={styles.body}>
                    This answer returned no source citations.
                  </Text>
                ) : (
                  answer.citations.map((citation, index) => (
                    <View
                      key={`${citation.entryId ?? citation.videoId}:${index}`}
                      style={local.citation}
                    >
                      <Text style={styles.body}>
                        {citation.videoTitle ||
                          citation.documentTitle ||
                          "Source"}
                        {citation.sourceType !== "knowledge" &&
                        citation.sourceType !== "authority"
                          ? ` · ${Math.floor(citation.startTime / 60)}:${String(Math.floor(citation.startTime % 60)).padStart(2, "0")}`
                          : ""}
                      </Text>
                      {!!citation.text && (
                        <Text selectable style={styles.body}>
                          {citation.text}
                        </Text>
                      )}
                      {!!citation.sourceStatus && (
                        <Text style={local.signal}>
                          {citation.sourceStatus.replaceAll("_", " ")}
                        </Text>
                      )}
                      {citation.verified && (
                        <Text style={local.signal}>
                          Mentor verified
                          {(citation.sourceCount ?? 0) > 1
                            ? ` · ${citation.sourceCount} corroborating sources`
                            : ""}
                        </Text>
                      )}
                      <Action
                        variant="secondary"
                        title="Open source"
                        onPress={() => void openCitation(citation)}
                        disabled={online === false}
                      />
                    </View>
                  ))
                )}
              </View>
            ) : (
              surface === "ask" && (
                <View style={local.card}>
                  <Text style={styles.title}>What do you need to know?</Text>
                  <Text style={styles.body}>
                    Ask by voice or text. Jack brings back the knowledge and the
                    sources behind it.
                  </Text>
                </View>
              )
            )}
          </>
        )}
      </ScrollView>
      <View style={local.composer}>
        {access === "checking" && (
          <Text style={local.signal}>Checking account access…</Text>
        )}
        {access === "denied" && (
          <Action
            title="Retry Jack access"
            onPress={() => void checkAccess()}
            disabled={online === false}
          />
        )}
        {!!status && (
          <Text accessibilityLiveRegion="polite" style={local.signal}>
            {status}
          </Text>
        )}
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <TextInput
          accessibilityLabel="Ask Jack a question"
          placeholder="Ask Jack…"
          placeholderTextColor={theme.muted}
          style={styles.input}
          value={question}
          onChangeText={setQuestion}
          multiline
          maxLength={2000}
          editable={!busy}
          onFocus={() => {
            if (radioRef.current || recorder.isRecording || playback.playing)
              void invalidate("Type your question.", false, true);
          }}
        />
        <View style={local.actions}>
          <View style={{ flex: 1 }}>
            <Action
              variant="secondary"
              title={busy ? "Working…" : "Ask Jack"}
              disabled={
                busy ||
                access !== "granted" ||
                !question.trim() ||
                online === false ||
                !foreground
              }
              onPress={() => {
                // Cancel a pending voice turn even if Radio started while this keyboard was already focused.
                const text = question;
                const stopped = invalidate("", false, true);
                const current = scope.capture();
                void stopped.then(() => {
                  if (mounted.current && current()) void ask(text);
                });
              }}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Action
              title={radio ? "Stop Radio" : "Start Radio"}
              disabled={
                !radio &&
                (access !== "granted" || online === false || !foreground)
              }
              onPress={() => {
                if (radioRef.current) {
                  void invalidate("Radio stopped.", false, true);
                  return;
                }
                const currentIntent = scope.capture();
                Alert.alert(
                  "Start Radio Jack",
                  "Jack will record your questions and send them for transcription. Pause after each question; Jack answers aloud, then listens again. Stop Radio ends the conversation.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Start",
                      onPress: () => {
                        if (
                          !currentIntent() ||
                          !mounted.current ||
                          !foregroundRef.current ||
                          accessRef.current !== "granted"
                        )
                          return;
                        const stopped = invalidate("", false, true);
                        const current = scope.capture();
                        void stopped.then((success) => {
                          if (
                            !success ||
                            !current() ||
                            !mounted.current ||
                            !foregroundRef.current ||
                            accessRef.current !== "granted"
                          )
                            return;
                          radioRef.current = true;
                          setRadio(true);
                          setError("");
                          void beginRecording();
                        });
                      },
                    },
                  ],
                );
              }}
            />
          </View>
        </View>
        {recording.isRecording && (
          <Action title="Send voice now" onPress={() => void sendRecording()} />
        )}
        {radio && playback.playing && (
          <Action
            title="Interrupt Jack"
            onPress={() => {
              const current = scope.capture();
              void stopAudio()
                .then(() => {
                  if (current() && mounted.current) void beginRecording();
                })
                .catch(() => {
                  if (!current() || !mounted.current) return;
                  radioRef.current = false;
                  setRadio(false);
                  setError(
                    "Voice playback could not stop. Radio is paused; you can still type your question.",
                  );
                });
            }}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const local = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
  },
  heading: { color: theme.text, fontSize: 20, fontWeight: "700" },
  signal: {
    color: theme.muted,
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 4,
  },
  content: { padding: 16, gap: 16 },
  card: {
    padding: 20,
    gap: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.panel,
  },
  citation: {
    gap: 10,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  composer: {
    padding: 12,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.background,
  },
  actions: { flexDirection: "row", gap: 10 },
});
