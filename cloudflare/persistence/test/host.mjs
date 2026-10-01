import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/worker.mjs', import.meta.url))], bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false });
const mf = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-07-01',
  host: '127.0.0.1', port: 0,
  bindings: { RUNTIME_READ_TOKEN: process.env.TEST_READ_TOKEN, RUNTIME_WRITE_TOKEN: process.env.TEST_WRITE_TOKEN },
  durableObjects: { TASK_STATE: { className: 'RuntimeTaskState', useSQLite: true } },
  durableObjectsPersist: process.env.TEST_PERSIST_PATH,
});
const address = await mf.ready;
process.send({ ready: address.toString() });
process.on('message', async (message) => { if (message === 'stop') { await mf.dispose(); process.exit(0); } });
