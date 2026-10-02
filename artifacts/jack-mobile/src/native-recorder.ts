import { useEffect, useState } from "react";
import { AudioModule, RecordingPresets } from "expo-audio";
import { File } from "expo-file-system";
import { RecorderOwner } from "./core/recorder-owner";

export function createNativeRecorderOwner(onError: () => void) {
  const options = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };
  return new RecorderOwner(
    () => {
      const recorder = new AudioModule.AudioRecorder(options);
      let listening = true;
      let listener;
      try {
        listener = recorder.addListener("recordingStatusUpdate", (event) => {
          if (listening && event.hasError) onError();
        });
      } catch (cause) {
        recorder.release();
        throw cause;
      }
      return {
        prepare: () => recorder.prepareToRecordAsync(options),
        record: () => recorder.record(),
        stop: () => recorder.stop(),
        release: () => recorder.release(),
        disconnect: () => {
          listening = false;
          listener.remove();
        },
        uri: () => recorder.uri || null,
        status: () => recorder.getStatus(),
      };
    },
    (uri) => {
      const file = new File(uri);
      if (file.exists) file.delete();
    },
  );
}

export function useRecorderStatus(owner: RecorderOwner) {
  const [status, setStatus] = useState(() => owner.status());
  useEffect(() => {
    const timer = setInterval(() => setStatus(owner.status()), 100);
    return () => clearInterval(timer);
  }, [owner]);
  return status;
}
