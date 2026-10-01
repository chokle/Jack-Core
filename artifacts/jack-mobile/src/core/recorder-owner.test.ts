import { test } from "node:test";
import assert from "node:assert/strict";
import { RecorderOwner, type DisposableRecorder } from "./recorder-owner";

function fixture({
  failPrepare = false,
  failRecord = false,
  failStop = false,
  failDisconnect = false,
  failFirstUri = false,
  pausePrepare = false,
} = {}) {
  const calls: string[] = [];
  let id = 0;
  let hardware = 0;
  let resume = () => {};
  const owner = new RecorderOwner(
    () => {
      const current = ++id;
      let recording = false;
      let held = false;
      let uriReads = 0;
      const recorder: DisposableRecorder = {
        async prepare() {
          calls.push(`prepare${current}`);
          hardware += 1;
          held = true;
          if (pausePrepare)
            await new Promise<void>((resolve) => {
              resume = resolve;
            });
          if (failPrepare) throw new Error("prepare failed");
        },
        record() {
          calls.push(`record${current}`);
          if (failRecord) throw new Error("start failed");
          recording = true;
        },
        async stop() {
          calls.push(`stop${current}`);
          recording = false;
          if (failStop) throw new Error("permission revoked");
        },
        release() {
          calls.push(`release${current}`);
          if (held) hardware -= 1;
          held = false;
        },
        disconnect() {
          calls.push(`disconnect${current}`);
          if (failDisconnect) throw new Error("listener already detached");
        },
        uri() {
          uriReads += 1;
          if (failFirstUri && uriReads === 1)
            throw new Error("URI unavailable during capture");
          return `file://recording-${current}.m4a`;
        },
        status() {
          return { isRecording: recording, durationMillis: 1000 };
        },
      };
      return recorder;
    },
    (uri) => calls.push(`delete:${uri}`),
  );
  return { owner, calls, hardware: () => hardware, resume: () => resume() };
}

test("first, second and third voiced turns release hardware before the next recorder is created", async () => {
  const { owner, calls, hardware } = fixture();
  for (let turn = 1; turn <= 3; turn += 1) {
    assert.equal(await owner.start(() => true), true);
    assert.equal(hardware(), 1);
    assert.equal(await owner.finish(), `file://recording-${turn}.m4a`);
    assert.equal(hardware(), 0);
    assert.ok(
      calls.indexOf(`disconnect${turn}`) < calls.indexOf(`stop${turn}`),
    );
    assert.ok(calls.includes(`release${turn}`));
  }
});

test("rapid repeated start requests cannot prepare two simultaneous native captures", async () => {
  const { owner, hardware, calls } = fixture();
  const results = await Promise.all([
    owner.start(() => true),
    owner.start(() => true),
    owner.start(() => true),
  ]);
  assert.deepEqual(results, [true, false, false]);
  assert.equal(hardware(), 1);
  assert.equal(calls.filter((call) => call.startsWith("prepare")).length, 1);
  await owner.discard();
  assert.equal(hardware(), 0);
});

test("prepare and record failures release even when isRecording was never true", async () => {
  for (const failure of [{ failPrepare: true }, { failRecord: true }]) {
    const { owner, calls, hardware } = fixture(failure);
    await assert.rejects(owner.start(() => true));
    assert.equal(hardware(), 0);
    assert.ok(calls.includes("release1"));
    assert.ok(calls.includes("delete:file://recording-1.m4a"));
  }
});

test("permission-revoked stop still releases and next turn receives a fresh recorder", async () => {
  const { owner, hardware, calls } = fixture({ failStop: true });
  await owner.start(() => true);
  await owner.discard();
  assert.equal(hardware(), 0);
  await owner.start(() => true);
  assert.equal(hardware(), 1);
  await owner.discard();
  assert.equal(hardware(), 0);
  assert.ok(calls.includes("release2"));
});

test("listener or initial URI failure cannot skip stopping the native capture or deleting its audio", async () => {
  for (const failure of [{ failDisconnect: true }, { failFirstUri: true }]) {
    const { owner, hardware, calls } = fixture(failure);
    await owner.start(() => true);
    await owner.discard();
    assert.equal(hardware(), 0);
    assert.ok(calls.includes("stop1"));
    assert.ok(calls.includes("release1"));
    assert.ok(calls.includes("delete:file://recording-1.m4a"));
    assert.equal(await owner.start(() => true), true);
    await owner.discard();
    assert.equal(hardware(), 0);
  }
});

test("cancellation during prepared state releases before a later start can run", async () => {
  const { owner, hardware, calls, resume } = fixture({ pausePrepare: true });
  let current = true;
  const start = owner.start(() => current);
  await Promise.resolve();
  await Promise.resolve();
  current = false;
  const stop = owner.discard();
  resume();
  assert.equal(await start, false);
  await stop;
  assert.equal(hardware(), 0);
  assert.equal(calls.includes("record1"), false);
});

test("unmount rejects queued starts and releases an in-flight prepare", async () => {
  const { owner, hardware, resume } = fixture({ pausePrepare: true });
  const start = owner.start(() => true);
  await Promise.resolve();
  await Promise.resolve();
  const dispose = owner.dispose();
  resume();
  assert.equal(await start, false);
  await dispose;
  assert.equal(hardware(), 0);
  assert.equal(await owner.start(() => true), false);
});

test("stop without active capture is safe repeatedly and does not create hardware", async () => {
  const { owner, calls, hardware } = fixture();
  await owner.discard();
  await owner.discard();
  await owner.dispose();
  assert.equal(hardware(), 0);
  assert.deepEqual(calls, []);
});

test("hung native stop has a finite deadline and still releases the microphone", async () => {
  let released = 0;
  const owner = new RecorderOwner(
    () => ({
      prepare: async () => {},
      record: () => {},
      stop: () => new Promise(() => {}),
      release: () => {
        released += 1;
      },
      disconnect: () => {},
      uri: () => "file://question.m4a",
      status: () => ({ isRecording: false, durationMillis: 0 }),
    }),
    () => {},
    { prepareMs: 5, stopMs: 5 },
  );
  await owner.start(() => true);
  await owner.discard();
  assert.equal(released, 1);
});

test("hung native preparation releases without starting capture or retrying indefinitely", async () => {
  let created = 0;
  let released = 0;
  let recorded = 0;
  const owner = new RecorderOwner(
    () => {
      created += 1;
      return {
        prepare: () => new Promise(() => {}),
        record: () => {
          recorded += 1;
        },
        stop: async () => {},
        release: () => {
          released += 1;
        },
        disconnect: () => {},
        uri: () => null,
        status: () => ({ isRecording: false, durationMillis: 0 }),
      };
    },
    () => {},
    { prepareMs: 5, stopMs: 5 },
  );
  await assert.rejects(
    owner.start(() => true),
    /timed out/,
  );
  assert.equal(created, 1);
  assert.equal(recorded, 0);
  assert.equal(released, 1);
});
