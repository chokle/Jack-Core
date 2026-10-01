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
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { File } from "expo-file-system";
import { randomUUID } from "expo-crypto";
import { useVideoPlayer, VideoView, type VideoPlayer } from "expo-video";
import { Action, styles } from "./App";
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
import { SerialTransitions } from "./core/transitions";
import { audioDirectory } from "./media-store";

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
      listener.remove();
      playing.remove();
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
  const microphoneTransitions = useRef(new SerialTransitions()).current;
  const bus = useRef(new CapabilityBus()).current;
  const player = useAudioPlayer(null);
  const playback = useAudioPlayerStatus(player);
  const recorder = useAudioRecorder(
    { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true },
    (event) => {
      if (event.hasError) {
        void invalidate(
          "Radio interrupted. Start it again when ready.",
          false,
          true,
        );
        setError(
          "The microphone was interrupted or its permission changed. Check Android permissions and retry.",
        );
      }
    },
  );
  const recording = useAudioRecorderState(recorder, 100);
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
  const recordingFile = useRef<string | null>(null);
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
    player.pause();
    player.replace(null);
    if (audioFile.current?.exists) audioFile.current.delete();
    audioFile.current = null;
  }, [player, speechScope]);

  const stopMicrophone = useCallback(
    () =>
      microphoneTransitions.run(async () => {
        if (recorder.isRecording) await recorder.stop();
        deleteFile(recordingFile.current ?? recorder.uri);
        recordingFile.current = null;
      }),
    [recorder, microphoneTransitions],
  );

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
      sourcePlayer.current?.pause();
      videoPlaying.current = false;
      const stop = preserveSource
        ? Promise.all([bus.get("microphone")?.stop(), bus.get("audio")?.stop()])
        : bus.stopAll();
      return stop
        .then(() => true)
        .catch(() => {
          setError(
            "A device capability could not stop. Close Jack before starting another recording.",
          );
          radioRef.current = false;
          setRadio(false);
          return false;
        });
    },
    [scope, bus],
  );

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
    await stopAudio();
    sourcePlayer.current?.pause();
    videoPlaying.current = false;
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
      file.create();
      file.write(bytes);
      audioFile.current = file;
      player.replace(file.uri);
      player.play();
      setStatus("Jack is speaking. Replay is available below the answer.");
    } catch (cause) {
      if (!request.owns() || !speechRequest.owns()) return;
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
      recorder.isRecording ||
      access !== "granted" ||
      online === false ||
      !foregroundRef.current
    )
      return;
    sourcePlayer.current?.pause();
    videoPlaying.current = false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setStatus("Jack is finding a grounded answer…");
    const request = scope.begin();
    try {
      const result = await api.ask(text, contextHeader(), request.signal);
      if (!request.current()) return;
      setAnswer(result);
      setQuestion("");
      setStatus("Answer received.");
      request.finish();
      try {
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
      await microphoneTransitions.run(async () => {
        if (
          !request.current() ||
          !mounted.current ||
          !foregroundRef.current ||
          recorder.isRecording ||
          !radioRef.current
        )
          return;
        await recorder.prepareToRecordAsync();
        if (!request.current()) {
          await recorder.stop();
          deleteFile(recorder.uri);
          return;
        }
        heardSpeech.current = false;
        lastSpeechAt.current = Date.now();
        recorder.record();
        recordingFile.current = recorder.uri;
        setStatus(
          "Listening. Pause after your question, or tap Send voice now. Stop Radio ends the conversation.",
        );
      });
    } catch (cause) {
      if (request.owns()) {
        radioRef.current = false;
        setRadio(false);
        setError(
          cause instanceof Error
            ? cause.message
            : "Microphone interrupted. Try again.",
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
      await microphoneTransitions.run(() => recorder.stop());
      uri = recorder.uri;
      recordingFile.current = uri;
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
      deleteFile(uri);
      recordingFile.current = null;
      stopping.current = false;
      if (request.owns()) {
        busyRef.current = false;
        setBusy(false);
      }
      request.finish();
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
    void stopAudio().then(() => {
      if (radioRef.current && foregroundRef.current) void beginRecording();
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
        <Text style={styles.title}>Jack</Text>
        <Action
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
                  <Text style={local.heading}>Ask Jack</Text>
                  <Text style={styles.body}>
                    Ask a field question. Jack searches the shared knowledge and
                    shows the sources behind his answer.
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
          placeholderTextColor="#92a4ac"
          style={styles.input}
          value={question}
          onChangeText={setQuestion}
          multiline
          maxLength={2000}
          editable={!busy && !recording.isRecording}
        />
        <View style={local.actions}>
          <View style={{ flex: 1 }}>
            <Action
              title={busy ? "Working…" : "Ask Jack"}
              disabled={
                busy ||
                radio ||
                access !== "granted" ||
                !question.trim() ||
                online === false ||
                !foreground
              }
              onPress={() => void ask(question)}
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
              void stopAudio().then(() => beginRecording());
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
  heading: { color: "#f1f7f8", fontSize: 20, fontWeight: "700" },
  signal: {
    color: "#a5c4ce",
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 4,
  },
  content: { padding: 16, gap: 16 },
  card: { padding: 16, gap: 14, borderRadius: 16, backgroundColor: "#1a2a32" },
  citation: {
    gap: 10,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "#49616b",
  },
  composer: {
    padding: 12,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: "#49616b",
    backgroundColor: "#10191e",
  },
  actions: { flexDirection: "row", gap: 10 },
});
