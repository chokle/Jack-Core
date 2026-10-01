import { test } from "node:test";
import assert from "node:assert/strict";
import { disposePlayback } from "./playback-owner";

test("every playback releases native resources without ever replacing with a null source", () => {
  const calls: string[] = [];
  disposePlayback({
    disconnect: () => {
      calls.push("disconnect");
    },
    pause: () => {
      calls.push("pause");
    },
    remove: () => {
      calls.push("remove");
    },
    release: () => {
      calls.push("release");
    },
  });
  assert.deepEqual(calls, ["disconnect", "pause", "remove", "release"]);
});

test("listener, pause or registry errors cannot skip native AudioTrack release", () => {
  for (const failure of ["disconnect", "pause", "remove"]) {
    let released = 0;
    const operation = (name: string) => {
      if (name === failure) throw new Error("already closed");
    };
    disposePlayback({
      disconnect: () => operation("disconnect"),
      pause: () => operation("pause"),
      remove: () => operation("remove"),
      release: () => {
        released += 1;
      },
    });
    assert.equal(released, 1);
  }
});
