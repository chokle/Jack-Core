export interface DisposablePlayback {
  disconnect(): void;
  pause(): void;
  remove(): void;
  release(): void;
}

/** pause()/replace(null) is insufficient: remove the registry entry and release the native AudioTrack. */
export function disposePlayback(player: DisposablePlayback) {
  try {
    try {
      player.disconnect();
    } catch {
      /* release must run even if a listener is already detached. */
    }
    try {
      player.pause();
    } catch {
      /* an already-ended player can still be released. */
    }
    try {
      player.remove();
    } catch {
      /* registry failure must not retain native resources. */
    }
  } finally {
    player.release();
  }
}
