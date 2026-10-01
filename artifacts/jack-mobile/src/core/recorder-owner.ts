import { SerialTransitions } from "./transitions";

export interface RecorderStatus {
  isRecording: boolean;
  durationMillis: number;
  metering?: number;
}

export interface DisposableRecorder {
  prepare(): Promise<void>;
  record(): void;
  stop(): Promise<void>;
  release(): void;
  disconnect(): void;
  uri(): string | null;
  status(): RecorderStatus;
}

export class RecorderUnavailableError extends Error {
  constructor() {
    super("The microphone is unavailable. You can still type your question.");
  }
}

/** One native recorder per turn. Prepared, failed and revoked captures must release too. */
export class RecorderOwner {
  private transitions = new SerialTransitions();
  private active: DisposableRecorder | null = null;
  private closed = false;
  private unavailable = false;

  constructor(
    private create: () => DisposableRecorder,
    private removeFile: (uri: string) => void,
    private timeouts = { prepareMs: 12_000, stopMs: 3_000 },
  ) {}

  private async bounded<T>(
    operation: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Microphone operation timed out.")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  get isRecording() {
    return this.status().isRecording;
  }
  get available() {
    return !this.unavailable && !this.closed;
  }
  status(): RecorderStatus {
    if (this.active) {
      try {
        return this.active.status();
      } catch {
        /* Revocation must not break the typed client. */
      }
    }
    return { isRecording: false, durationMillis: 0, metering: -160 };
  }

  private async close(keepFile: boolean): Promise<string | null> {
    const recorder = this.active;
    if (!recorder) return null;
    this.active = null;
    // Disconnect before stop: Android reports prepared/empty stops as hasError.
    let uri: string | null = null;
    let stopped = false;
    let released = false;
    try {
      recorder.disconnect();
    } catch {
      /* A listener error must not skip native stop/release. */
    }
    try {
      uri = recorder.uri();
    } catch {
      /* Retry the URI after stopping; native release remains mandatory. */
    }
    try {
      await this.bounded(recorder.stop(), this.timeouts.stopMs);
      stopped = true;
      try {
        uri = recorder.uri() ?? uri;
      } catch {
        /* Preserve the earlier URI when querying a stopped recorder fails. */
      }
    } catch {
      /* stop can fail after permission revocation; release is still mandatory. */
    } finally {
      try {
        recorder.release();
        released = true;
      } catch {
        this.unavailable = true;
      }
      if (uri && (!keepFile || !stopped || !released)) this.removeFile(uri);
    }
    if (!released) throw new RecorderUnavailableError();
    if (keepFile && !stopped)
      throw new Error(
        "This recording was interrupted. Try the microphone again or type your question.",
      );
    return keepFile ? uri : null;
  }

  start(current: () => boolean): Promise<boolean> {
    return this.transitions.run(async () => {
      if (this.closed || !current()) return false;
      if (this.unavailable) throw new RecorderUnavailableError();
      if (this.isRecording) return false;
      await this.close(false);
      const recorder = this.create();
      this.active = recorder;
      try {
        await this.bounded(recorder.prepare(), this.timeouts.prepareMs);
        if (this.closed || !current()) {
          await this.close(false);
          return false;
        }
        recorder.record();
        return true;
      } catch (cause) {
        await this.close(false);
        throw cause;
      }
    });
  }

  finish(): Promise<string | null> {
    return this.transitions.run(() => this.close(true));
  }
  discard(): Promise<void> {
    return this.transitions.run(async () => {
      await this.close(false);
    });
  }
  dispose(): Promise<void> {
    this.closed = true; // Reject queued starts before awaiting an in-flight prepare.
    return this.discard();
  }
}
