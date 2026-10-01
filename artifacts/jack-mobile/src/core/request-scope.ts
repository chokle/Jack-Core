/** A response can only publish into the session, navigation context and foreground epoch that started it. */
export class RequestScope {
  private epoch = 0;
  private controllers = new Set<AbortController>();

  capture() {
    const epoch = this.epoch;
    return () => epoch === this.epoch;
  }

  invalidate() {
    this.epoch += 1;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  begin(timeoutMs = 60_000) {
    const epoch = this.epoch;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return {
      signal: controller.signal,
      owns: () => epoch === this.epoch,
      current: () => epoch === this.epoch && !controller.signal.aborted,
      finish: () => {
        clearTimeout(timer);
        this.controllers.delete(controller);
      },
    };
  }
}
