import { WorkflowEntrypoint } from 'cloudflare:workers';
import { z } from 'zod/v4';
export { RuntimeTaskState } from './ledger.mjs';

const opaqueId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const resultFields = { operation: opaqueId, fence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), result: z.enum(['succeeded','verified_failed']), reference: opaqueId };
const commandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create') }),
  z.strictObject({ action: z.literal('claim'), owner: opaqueId, operation: opaqueId, leaseMs: z.number().int().min(1000).max(300000) }),
  z.strictObject({ action: z.literal('finish'), owner: opaqueId, ...resultFields }),
  z.strictObject({ action: z.literal('reconcile'), ...resultFields }),
]);
const workflowSchema = z.strictObject({ agent: opaqueId, task: opaqueId });
const projectionSchema = z.strictObject({ scope: z.string().min(1).max(200), version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), status: z.enum(['queued','running','awaiting_reconciliation','retryable','completed','blocked']), attempts: z.number().int().min(0).max(3), updated: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
async function matches(actual, expected) {
  if (!actual || !expected || expected.length < 32) return false;
  const hash = async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([hash(actual), hash(expected)]);
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
function scopeStub(env, agent, task) { return env.TASK_STATE.getByName(JSON.stringify([agent, task])); }
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') return reply({ service: 'runtime-persistence-foundation', runtime: 'responding' });
    if (!env.RUNTIME_READ_TOKEN || !env.RUNTIME_WRITE_TOKEN || env.RUNTIME_READ_TOKEN.length < 32 || env.RUNTIME_WRITE_TOKEN.length < 32 || env.RUNTIME_READ_TOKEN === env.RUNTIME_WRITE_TOKEN) return reply({ error: 'control_plane_unconfigured' }, 503);
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
    const write = await matches(bearer, env.RUNTIME_WRITE_TOKEN);
    if (!write && !(request.method === 'GET' && await matches(bearer, env.RUNTIME_READ_TOKEN))) return reply({ error: 'unauthorized' }, 401);
    const route = /^\/v1\/agents\/([a-zA-Z0-9_-]{1,80})\/tasks\/([a-zA-Z0-9_-]{1,80})$/.exec(url.pathname);
    if (!route) return reply({ error: 'not_found' }, 404);
    const stub = scopeStub(env, route[1], route[2]);
    try {
      if (request.method === 'GET') return reply(await stub.status());
      if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
      const reader = request.body?.getReader();
      let length = 0;
      const chunks = [];
      if (reader) {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 2048) { await reader.cancel(); return reply({ error: 'body_too_large' }, 413); }
          chunks.push(chunk.value);
        }
      }
      const bytes = new Uint8Array(length);
      let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return reply({ error: 'invalid_json' }, 400); }
      const parsed = commandSchema.safeParse(body);
      if (!parsed.success) return reply({ error: 'invalid_command' }, 400);
      const result = await stub.command(parsed.data);
      return reply(result, result.ok ? 200 : result.error === 'not_found' ? 404 : 409);
    } catch { return reply({ error: 'runtime_unavailable' }, 503); }
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      const parsed = projectionSchema.safeParse(message.body);
      if (!parsed.success) { message.ack(); continue; }
      const value = parsed.data;
      try {
        await env.REPORTING_DB.prepare(`INSERT INTO runtime_task_projection VALUES(?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET version=excluded.version,status=excluded.status,attempts=excluded.attempts,updated_at=excluded.updated_at WHERE excluded.version>runtime_task_projection.version`).bind(value.scope, value.version, value.status, value.attempts, value.updated).run();
        message.ack();
      } catch { message.retry(); }
    }
  }
};

// Explicitly triggered recovery/reporting job, never an always-running executor.
// DO state is authoritative; step retries cannot replay provider side effects.
export class RecoveryWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { agent, task } = workflowSchema.parse(event.payload);
    const status = await step.do('recover-and-read', { retries: { limit: 2, delay: '1 second', backoff: 'exponential' }, timeout: '30 seconds' }, () => scopeStub(this.env, agent, task).status());
    if (!status.state) return { found: false };
    const state = status.state;
    const projection = { scope: JSON.stringify([agent, task]), version: state.version, status: state.status, attempts: state.attempts, updated: state.updated };
    await step.do('archive-operational-checkpoint', { retries: { limit: 2, delay: '1 second', backoff: 'exponential' }, timeout: '30 seconds' }, async () => {
      await this.env.ARTIFACTS.put(`operational/${agent}/${task}/${state.version}.json`, JSON.stringify(projection), { httpMetadata: { contentType: 'application/json' } });
      return { archivedVersion: state.version };
    });
    await step.do('publish-operational-projection', { retries: { limit: 2, delay: '1 second', backoff: 'exponential' }, timeout: '30 seconds' }, async () => {
      await this.env.REPORT_QUEUE.send(projection);
      return { publishedVersion: state.version };
    });
    return { found: true, version: state.version, status: state.status };
  }
}
