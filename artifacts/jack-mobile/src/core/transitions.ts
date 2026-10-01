/** Native prepare/record/stop transitions must not race, even after a JS request is cancelled. */
export class SerialTransitions {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(task);
    this.tail = operation.catch(() => {});
    return operation;
  }
}

export function isOwnedRecordingName(name: string) {
  return /^recording-[a-f0-9-]{36}\.m4a$/i.test(name);
}

/**
 * Tracks ownership of the native recorder independently from React's polled
 * isRecording state. A recorder can hold Android MediaRecorder resources after
 * prepareToRecordAsync() but before the next status poll sees "recording".
 */
export class NativeRecorderLease {
  private held = false;

  markPrepared() {
    this.held = true;
  }

  markStopped() {
    this.held = false;
  }

  get shouldStop() {
    return this.held;
  }
}
