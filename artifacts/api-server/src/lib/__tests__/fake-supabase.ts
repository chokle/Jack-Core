/**
 * In-memory fake of the tiny slice of the Supabase JS client that memory-graph.ts
 * and distillation.ts use. It supports the chainable query-builder surface the
 * graph code touches (select/eq/neq/in/order/maybeSingle, upsert with onConflict
 * + ignoreDuplicates, delete with filters) plus the `match_knowledge_nodes` RPC.
 *
 * It deliberately models the two DB behaviours the idempotency logic relies on:
 *   - partial upsert on conflict updates ONLY the provided columns (so a scaffold
 *     re-sync never clobbers an atomic node's description/confidence/status), and
 *   - deleting a knowledge_nodes row CASCADES to knowledge_edges referencing it
 *     (mirrors the ON DELETE CASCADE foreign keys), which pruneOrphanKnowledge and
 *     deleteVideoNode both depend on.
 */

type Row = Record<string, unknown>;

type Filter =
  | { kind: "eq"; col: string; val: unknown }
  | { kind: "neq"; col: string; val: unknown }
  | { kind: "in"; col: string; vals: unknown[] }
  | { kind: "is"; col: string; val: unknown }
  | { kind: "not-is"; col: string; val: unknown }
  | { kind: "lt"; col: string; val: unknown };

interface Result<T> {
  data: T;
  error: { message: string } | null;
}

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class FakeSupabase {
  tables: Record<string, Row[]> = {
    videos: [],
    competencies: [],
    transcript_segments: [],
    knowledge_nodes: [],
    knowledge_edges: [],
    chat_messages: [],
  };

  from(table: string): QueryBuilder {
    if (!this.tables[table]) this.tables[table] = [];
    return new QueryBuilder(this, table);
  }

  async rpc(name: string, params: Record<string, unknown>): Promise<Result<unknown>> {
    if (name === "match_knowledge_nodes") {
      const query = (params["query_embedding"] as number[]) ?? [];
      const category = params["filter_category"] as string;
      const threshold = params["match_threshold"] as number;
      const count = params["match_count"] as number;
      const exclude = new Set((params["exclude_ids"] as string[]) ?? []);

      const scored = (this.tables["knowledge_nodes"] ?? [])
        .filter((n) => n["embedding"] != null && n["kind"] === category && !exclude.has(n["id"] as string))
        .map((n) => {
          const emb = JSON.parse(n["embedding"] as string) as number[];
          return { id: n["id"] as string, label: n["label"] as string, similarity: cosine(query, emb) };
        })
        .filter((r) => r.similarity > threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, count);

      return { data: scored, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${name}` } };
  }
}

class QueryBuilder implements PromiseLike<Result<unknown>> {
  private op: "select" | "upsert" | "delete" | "update" | "insert" = "select";
  private filters: Filter[] = [];
  private upsertRows: Row[] = [];
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private updateValues: Row = {};
  private singleMode: "none" | "maybe" | "single" = "none";
  private orderBy: { col: string; ascending: boolean } | null = null;

  constructor(
    private db: FakeSupabase,
    private table: string,
  ) {}

  private get rows(): Row[] {
    return this.db.tables[this.table]!;
  }

  select(_cols?: string): this {
    // `.select()` is a return-columns modifier, not an op switch: after
    // `.update()`/`.upsert()`/`.delete()` it just asks for the affected rows
    // back. The default op is already "select", so we never need to set it here.
    return this;
  }

  upsert(rows: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}): this {
    this.op = "upsert";
    this.upsertRows = Array.isArray(rows) ? rows : [rows];
    this.upsertOpts = opts;
    return this;
  }

  update(values: Row): this {
    this.op = "update";
    this.updateValues = values;
    return this;
  }

  insert(rows: Row | Row[]): this {
    this.op = "insert";
    this.upsertRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  delete(): this {
    this.op = "delete";
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ kind: "eq", col, val });
    return this;
  }

  neq(col: string, val: unknown): this {
    this.filters.push({ kind: "neq", col, val });
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this.filters.push({ kind: "in", col, vals });
    return this;
  }

  // `.is(col, null)` — SQL "IS NULL" (also matches undefined, like a missing column).
  is(col: string, val: unknown): this {
    this.filters.push({ kind: "is", col, val });
    return this;
  }

  // Only the `.not(col, "is", null)` form is modeled (that's all the code uses).
  not(col: string, op: string, val: unknown): this {
    if (op !== "is") throw new Error(`fake-supabase: unsupported not() operator "${op}"`);
    this.filters.push({ kind: "not-is", col, val });
    return this;
  }

  lt(col: string, val: unknown): this {
    this.filters.push({ kind: "lt", col, val });
    return this;
  }

  order(col: string, opts: { ascending?: boolean } = {}): this {
    this.orderBy = { col, ascending: opts.ascending ?? true };
    return this;
  }

  maybeSingle(): this {
    this.singleMode = "maybe";
    return this;
  }

  single(): this {
    this.singleMode = "single";
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => {
      if (f.kind === "eq") return row[f.col] === f.val;
      if (f.kind === "neq") return row[f.col] !== f.val;
      if (f.kind === "is") return (row[f.col] ?? null) === f.val;
      if (f.kind === "not-is") return (row[f.col] ?? null) !== f.val;
      if (f.kind === "lt") return (row[f.col] as never) < (f.val as never);
      return f.vals.includes(row[f.col]);
    });
  }

  private run(): Result<unknown> {
    if (this.op === "upsert") return this.runUpsert();
    if (this.op === "insert") return this.runInsert();
    if (this.op === "update") return this.runUpdate();
    if (this.op === "delete") return this.runDelete();
    return this.runSelect();
  }

  private runInsert(): Result<unknown> {
    const now = new Date().toISOString();
    let n = 0;
    for (const incoming of this.upsertRows) {
      const row: Row = { created_at: now, ...incoming };
      if (row["id"] === undefined) row["id"] = `fake-${this.table}-${this.rows.length + n}`;
      this.rows.push(row);
      n++;
    }
    return { data: null, error: null };
  }

  private runUpdate(): Result<unknown> {
    const updated: Row[] = [];
    for (const r of this.rows) {
      if (!this.matches(r)) continue;
      Object.assign(r, this.updateValues);
      updated.push({ ...r });
    }
    if (this.singleMode !== "none") {
      return { data: updated[0] ?? null, error: null };
    }
    return { data: updated, error: null };
  }

  private runSelect(): Result<unknown> {
    let matched = this.rows.filter((r) => this.matches(r)).map((r) => ({ ...r }));
    if (this.orderBy) {
      const { col, ascending } = this.orderBy;
      matched = matched.sort((a, b) => {
        const av = a[col] as number;
        const bv = b[col] as number;
        return ascending ? av - bv : bv - av;
      });
    }
    if (this.singleMode !== "none") {
      return { data: matched[0] ?? null, error: null };
    }
    return { data: matched, error: null };
  }

  private runUpsert(): Result<unknown> {
    const now = new Date().toISOString();
    for (const incoming of this.upsertRows) {
      const id = incoming["id"];
      const existingIdx = this.rows.findIndex((r) => r["id"] === id);
      if (existingIdx >= 0) {
        if (this.upsertOpts.ignoreDuplicates) continue;
        // ON CONFLICT DO UPDATE only touches supplied columns.
        this.rows[existingIdx] = { ...this.rows[existingIdx], ...incoming };
      } else {
        this.rows.push({ created_at: now, ...incoming });
      }
    }
    return { data: null, error: null };
  }

  private runDelete(): Result<unknown> {
    const deleted: Row[] = [];
    const kept: Row[] = [];
    for (const r of this.rows) {
      if (this.matches(r)) deleted.push(r);
      else kept.push(r);
    }
    this.db.tables[this.table] = kept;

    // Emulate ON DELETE CASCADE from knowledge_nodes -> knowledge_edges.
    if (this.table === "knowledge_nodes" && deleted.length > 0) {
      const goneIds = new Set(deleted.map((r) => r["id"]));
      this.db.tables["knowledge_edges"] = (this.db.tables["knowledge_edges"] ?? []).filter(
        (e) => !goneIds.has(e["source_id"]) && !goneIds.has(e["target_id"]),
      );
    }

    // Emulate ON DELETE CASCADE from mentor_profiles -> interview_sessions and
    // interview_answers (both reference mentor_profile_id), mirroring the schema.
    if (this.table === "mentor_profiles" && deleted.length > 0) {
      const goneIds = new Set(deleted.map((r) => r["id"]));
      this.db.tables["interview_sessions"] = (this.db.tables["interview_sessions"] ?? []).filter(
        (s) => !goneIds.has(s["mentor_profile_id"]),
      );
      this.db.tables["interview_answers"] = (this.db.tables["interview_answers"] ?? []).filter(
        (a) => !goneIds.has(a["mentor_profile_id"]),
      );
    }
    return { data: null, error: null };
  }

  then<TResult1 = Result<unknown>, TResult2 = never>(
    onfulfilled?:
      | ((value: Result<unknown>) => TResult1 | PromiseLike<TResult1>)
      | undefined
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): PromiseLike<TResult1 | TResult2> {
    try {
      const result = this.run();
      return Promise.resolve(result).then(onfulfilled, onrejected);
    } catch (err) {
      return Promise.reject(err).then(onfulfilled, onrejected) as PromiseLike<TResult2>;
    }
  }
}
