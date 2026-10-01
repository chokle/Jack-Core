import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const persistPath = resolve(process.env.RUNTIME_TEST_ARTIFACT_DIR ?? '.wrangler/local-recovery-proof', randomBytes(8).toString('hex'));
const readToken = randomBytes(32).toString('hex');
const writeToken = randomBytes(32).toString('hex');
const children = new Set();
async function start() {
  const child = fork(new URL('./host.mjs', import.meta.url), [], { detached: process.platform !== 'win32', env: { ...process.env, TEST_PERSIST_PATH: persistPath, TEST_READ_TOKEN: readToken, TEST_WRITE_TOKEN: writeToken }, stdio: ['ignore','ignore','pipe','ipc'] });
  children.add(child);
  let errors = ''; child.stderr.on('data', (chunk) => { errors += chunk; });
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(([code]) => { throw new Error(`Host exited ${code}: ${errors}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Local runtime readiness timeout')), 30000); timer.unref(); }),
  ]);
  return { child, url: ready.ready };
}
function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
  else process.kill(-child.pid, 'SIGKILL');
}
async function request(host, method, body, token = writeToken, task = 'task1') {
  const response = await fetch(new URL(`/v1/agents/dex/tasks/${task}`, host.url), { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.json() };
}

test('real SQLite DO survives killed workerd; unknown outcomes require reconciliation; leases fence and attempts stop at three', { timeout: 90000 }, async () => {
  await mkdir(persistPath, { recursive: true });
  let host;
  try {
    host = await start();
    assert.equal((await request(host, 'GET', undefined, 'wrong-token')).status, 401);
    assert.equal((await request(host, 'POST', { action: 'create' }, readToken)).status, 401);
    assert.equal((await request(host, 'POST', { action: 'create', unexpected: 'payload' })).status, 400);
    assert.equal((await request(host, 'POST', { action: 'claim', leaseMs: 1000 })).status, 400);
    assert.equal((await request(host, 'POST', { action: 'create', unexpected: 'x'.repeat(3000) })).status, 413);
    assert.equal((await request(host, 'GET', undefined, readToken, 'separate-task')).body.state, null);
    assert.equal((await request(host, 'POST', { action: 'create' })).body.state.status, 'queued');
    const claim = await request(host, 'POST', { action: 'claim', owner: 'executor1', operation: 'provider-op1', leaseMs: 1000 });
    assert.equal(claim.body.state.attempts, 1);
    assert.equal((await request(host, 'POST', { action: 'claim', owner: 'executor2', operation: 'provider-op2', leaseMs: 1000 })).status, 409);
    const killed = once(host.child, 'exit'); killTree(host.child); await killed;
    // Actual runtime process tree terminated. A new Miniflare/workerd opens the same disk SQLite.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    host = await start();
    const recovered = await request(host, 'GET', undefined, readToken);
    assert.equal(recovered.body.state.status, 'awaiting_reconciliation');
    assert.equal(recovered.body.state.attempts, 1);
    assert.equal(recovered.body.state.operation, 'provider-op1');
    assert.equal((await request(host, 'POST', { action: 'finish', owner: 'executor1', operation: 'provider-op1', fence: 1, result: 'succeeded', reference: 'receipt1' })).body.error, 'stale_owner');
    assert.equal((await request(host, 'POST', { action: 'claim', owner: 'executor2', operation: 'provider-op2', leaseMs: 1000 })).body.error, 'not_claimable');
    const reconciled = await request(host, 'POST', { action: 'reconcile', operation: 'provider-op1', fence: 1, result: 'succeeded', reference: 'checked-provider-receipt1' });
    assert.equal(reconciled.body.state.status, 'completed');
    host.child.send('stop'); await once(host.child, 'exit');
    host = await start();
    const persisted = await request(host, 'GET', undefined, readToken);
    assert.equal(persisted.body.receipts[0].reference, 'checked-provider-receipt1');
    // A caller that lost the committed reconciliation response can retry after restart.
    const reconciliationRetry = await request(host, 'POST', { action: 'reconcile', operation: 'provider-op1', fence: 1, result: 'succeeded', reference: 'checked-provider-receipt1' });
    assert.equal(reconciliationRetry.status, 200);
    assert.equal(reconciliationRetry.body.alreadyRecorded, true);
    assert.deepEqual(reconciliationRetry.body.state, persisted.body.state);
    for (const conflict of [{ result: 'verified_failed', reference: 'checked-provider-receipt1' }, { result: 'succeeded', reference: 'different-provider-receipt' }]) {
      const denied = await request(host, 'POST', { action: 'reconcile', operation: 'provider-op1', fence: 1, ...conflict });
      assert.equal(denied.status, 409);
      assert.equal(denied.body.error, 'receipt_conflict');
    }
    assert.deepEqual((await request(host, 'GET', undefined, readToken)).body, persisted.body);
    await request(host, 'POST', { action: 'create' }, writeToken, 'budget');
    for (let attempt = 1; attempt <= 3; attempt++) {
      const operation = `failed-op${attempt}`;
      const result = await request(host, 'POST', { action: 'claim', owner: 'executor', operation, leaseMs: 30000 }, writeToken, 'budget');
      assert.equal(result.body.state.attempts, attempt);
      const finished = await request(host, 'POST', { action: 'finish', owner: 'executor', operation, fence: attempt, result: 'verified_failed', reference: `verified-failure${attempt}` }, writeToken, 'budget');
      assert.equal(finished.body.state.status, attempt === 3 ? 'blocked' : 'retryable');
    }
    assert.equal((await request(host, 'POST', { action: 'claim', owner: 'executor', operation: 'fourth-op', leaseMs: 1000 }, writeToken, 'budget')).status, 409);
    const duplicate = await request(host, 'POST', { action: 'finish', owner: 'executor', operation: 'failed-op3', fence: 3, result: 'verified_failed', reference: 'verified-failure3' }, writeToken, 'budget');
    assert.equal(duplicate.body.alreadyRecorded, true);
    assert.equal((await request(host, 'POST', { action: 'finish', owner: 'executor', operation: 'failed-op3', fence: 3, result: 'succeeded', reference: 'different-receipt' }, writeToken, 'budget')).body.error, 'receipt_conflict');
    await writeFile(resolve(persistPath, 'receipt.json'), JSON.stringify({ acceptedAt: new Date().toISOString(), environment: 'local Miniflare 4.20260730.0 / workerd SQLite', actualProcessTreeKilled: true, recovery: 'unknown operation blocked until reconciled', receiptRestartPersistence: true, reconciliationRetryIdempotentAfterRestart: true, reconciliationConflictsRejectedWithoutMutation: true, staleOwnerRejected: true, maxAttempts: 3, readWriteAuthorization: true, scopeIsolation: true, hostedAcceptance: false }, null, 2));
    console.log(`LOCAL_WORKERD_SQLITE_KILL_RECOVERY_PASS persist=${persistPath}; no hosted deployment acceptance`);
  } finally {
    for (const child of children) { if (child.exitCode === null) { try { killTree(child); } catch {} } }
  }
});
