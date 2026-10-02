export type CapabilityId = "microphone" | "audio" | "source";
export type PermissionState = "unknown" | "granted" | "denied" | "unavailable";
export interface Capability {
  id: CapabilityId;
  permission(): Promise<PermissionState>;
  stop(): Promise<void>;
}

/** Only attached hardware/runtime modules are available. Camera, GPS and peers have no fabricated manifests. */
export class CapabilityBus {
  private modules = new Map<CapabilityId, Capability>();
  attach(module: Capability) {
    if (this.modules.has(module.id))
      throw new Error(`Capability already attached: ${module.id}`);
    this.modules.set(module.id, module);
  }
  get(id: CapabilityId) {
    return this.modules.get(id);
  }
  async detach(id: CapabilityId) {
    const module = this.modules.get(id);
    this.modules.delete(id);
    await module?.stop();
  }
  async stopAll() {
    await Promise.all(
      [...this.modules.values()].map((module) => module.stop()),
    );
  }
}
