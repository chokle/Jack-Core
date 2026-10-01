import { DurableObject } from 'cloudflare:workers';

// One coordinator per [agent ID, task ID]. No global object or model loop.
export class RuntimeTaskState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS state (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), status TEXT NOT NULL,
      attempts INTEGER NOT NULL, fence INTEGER NOT NULL, owner TEXT,
      expires INTEGER, operation TEXT, version INTEGER NOT NULL, updated INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS receipts (
      operation TEXT PRIMARY KEY, result TEXT NOT NULL, reference TEXT NOT NULL,
      recorded INTEGER NOT NULL
    )`);
  }

  read() { return this.sql.exec('SELECT * FROM state WHERE singleton=1').toArray()[0] ?? null; }
  status() { this.recover(); return { state: this.read(), receipts: this.sql.exec('SELECT * FROM receipts ORDER BY recorded').toArray() }; }
  recover() {
    const row = this.read();
    if (row?.status === 'running' && row.expires <= Date.now()) {
      this.sql.exec("UPDATE state SET status='awaiting_reconciliation', owner=NULL, expires=NULL, version=version+1, updated=? WHERE singleton=1", Date.now());
    }
  }
  async alarm() { this.recover(); }

  async command(input) {
    const result = this.ctx.storage.transactionSync(() => {
      this.recover();
      const now = Date.now();
      let row = this.read();
      const reject = (error) => ({ ok: false, error, state: row });
      if (input.action === 'create') {
        if (!row) this.sql.exec("INSERT INTO state VALUES(1,'queued',0,0,NULL,NULL,NULL,1,?)", now);
        return { ok: true, state: this.read() };
      }
      if (!row) return reject('not_found');
      if (input.action === 'claim') {
        if (!['queued', 'retryable'].includes(row.status)) return reject('not_claimable');
        if (row.attempts >= 3) return reject('attempt_budget_exhausted');
        if (this.sql.exec('SELECT operation FROM receipts WHERE operation=?', input.operation).toArray().length) return reject('operation_already_recorded');
        // Intent and attempt are committed before an executor may perform a side effect.
        this.sql.exec("UPDATE state SET status='running', attempts=attempts+1, fence=fence+1, owner=?, expires=?, operation=?, version=version+1, updated=? WHERE singleton=1", input.owner, now + input.leaseMs, input.operation, now);
        return { ok: true, state: this.read() };
      }
      if (input.action === 'finish' || input.action === 'reconcile') {
        const old = this.sql.exec('SELECT * FROM receipts WHERE operation=?', input.operation).toArray()[0];
        if (old) return old.result === input.result && old.reference === input.reference ? { ok: true, alreadyRecorded: true, state: row } : reject('receipt_conflict');
      }
      if (input.action === 'finish') {
        if (row.status !== 'running' || row.owner !== input.owner || row.fence !== input.fence || row.operation !== input.operation) return reject('stale_owner');
      } else if (input.action === 'reconcile') {
        // Only the privileged operator API may submit checked provider evidence.
        if (row.status !== 'awaiting_reconciliation' || row.operation !== input.operation || row.fence !== input.fence) return reject('not_reconcilable');
      } else return reject('unknown_action');
      this.sql.exec('INSERT INTO receipts VALUES(?,?,?,?)', input.operation, input.result, input.reference, now);
      const status = input.result === 'succeeded' ? 'completed' : row.attempts >= 3 ? 'blocked' : 'retryable';
      this.sql.exec('UPDATE state SET status=?, owner=NULL, expires=NULL, version=version+1, updated=? WHERE singleton=1', status, now);
      return { ok: true, state: this.read() };
    });
    if (result.ok && result.state.status === 'running') await this.ctx.storage.setAlarm(result.state.expires);
    return result;
  }
}
