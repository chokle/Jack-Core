import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { supabase } from "../lib/supabase.js";
import { createEmbedding } from "../lib/openai.js";
import type { KnowledgeObjectMeta } from "../lib/knowledge-schema.js";

/**
 * Import a file of structured "Field Knowledge Objects" into the SAME
 * `knowledge_entries` table the seed script uses. Each numbered object in the
 * source becomes ONE separate, retrievable Knowledge Entry.
 *
 * This is ADDITIVE to (and deliberately mirrors) `seed-knowledge-entry.ts`: it
 * reuses the exact store path — deterministic id → embed(title+description+body)
 * → UPSERT — so re-running is idempotent, not duplicative. It does NOT change
 * the schema, ingestion, or retrieval.
 *
 * Robustness contract: every source field is optional. A missing OR extra field
 * NEVER fails the import — recognised fields map onto the Knowledge Object
 * schema, everything else is preserved verbatim in the body + metadata bag, and
 * each object is imported inside its own try/catch so one bad object cannot
 * abort the batch. Failures are counted and listed at the end.
 *
 * Searchability: trade, specialty (process), scenario, problem, root cause,
 * solution, field tip, safety note, tags and the supporting quote are all folded
 * into the embedded body, so the entry is retrievable by trade / problem /
 * symptom / process / keyword through the untouched `match_knowledge_entries`
 * RAG path.
 *
 * Run: pnpm --filter @workspace/api-server run import:knowledge
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SOURCE_FILE = "attached_assets/knowledge_objects_trade_specific.md";

/** The labelled fields, in the order they appear in each source object. */
const LABELS = [
  "Trade",
  "Specialty",
  "Scenario",
  "Problem",
  "Root Cause",
  "Solution",
  "Field Tip",
  "Common Mistake",
  "Safety Note",
  "When Not to Use",
  "Confidence",
  "Tags",
  "Source Link",
  "Supporting Quote",
] as const;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LABEL_RE = new RegExp(`^(${LABELS.map(escapeRe).join("|")}):\\s*(.*)$`);
const NUMBERED_RE = /^(\d+)\.\s+(.*)$/;
/** Standalone PDF page-number / inline-citation artifacts (digits, dots, spaces only). */
const ARTIFACT_RE = /^[\d.\s]+$/;
/** Trailing web-reference lines from the source's citation list. */
const REF_TITLE_RE = / : (?:r\/|Welding|Electrical|Plumbing|Carpentry|HVAC)/;
const SECTION_HEADERS = new Set([
  "Welding",
  "Electrical",
  "Plumbing",
  "Carpentry",
  "HVAC/R",
]);

/** Maps a source label to the parsed-object key it accumulates into. */
const KEY_OF: Record<string, string> = {
  Trade: "trade",
  Specialty: "specialty",
  Scenario: "scenario",
  Problem: "problem",
  "Root Cause": "rootCause",
  Solution: "solution",
  "Field Tip": "fieldTip",
  "Common Mistake": "commonMistake",
  "Safety Note": "safetyNote",
  "When Not to Use": "whenNotToUse",
  Confidence: "confidence",
  Tags: "tagsRaw",
  "Source Link": "sourceLink",
  "Supporting Quote": "supportingQuote",
};

interface ParsedObject {
  title?: string;
  trade?: string;
  specialty?: string;
  scenario?: string;
  problem?: string;
  rootCause?: string;
  solution?: string;
  fieldTip?: string;
  commonMistake?: string;
  safetyNote?: string;
  whenNotToUse?: string;
  confidence?: string;
  tagsRaw?: string;
  sourceLink?: string;
  supportingQuote?: string;
}

/** Read the source as UTF-8 text, transparently extracting a PDF if needed. */
function loadSourceText(absPath: string): string {
  const bytes = readFileSync(absPath);
  const isPdf = bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  if (isPdf) {
    // pdftotext is available in the Replit runtime; "-" streams to stdout.
    return execFileSync("pdftotext", ["-nopgbrk", absPath, "-"], {
      maxBuffer: 32 * 1024 * 1024,
    }).toString("utf8");
  }
  return bytes.toString("utf8");
}

/**
 * Parse the flat, numbered "N. Label: value" layout into discrete objects.
 * An object starts on a numbered line that is NOT a known label (its title) and
 * runs until the next such title. Values that wrap onto an unnumbered line are
 * appended; blank lines, section headers, page-number artifacts and the trailing
 * web-reference list are ignored.
 */
function parseObjects(text: string): ParsedObject[] {
  const objects: ParsedObject[] = [];
  let cur: (ParsedObject & Record<string, string>) | null = null;
  let field: string | null = null;

  const append = (value: string): void => {
    if (!cur || !field) return;
    const prev = cur[field];
    cur[field] = prev ? `${prev} ${value}` : value;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.includes("http")) break; // reached the reference/citation list
    const numbered = line.match(NUMBERED_RE);
    if (numbered) {
      const content = (numbered[2] ?? "").trim();
      const labelled = content.match(LABEL_RE);
      if (labelled) {
        const key = KEY_OF[labelled[1] as string];
        if (!cur) cur = {} as ParsedObject & Record<string, string>;
        if (key) {
          cur[key] = (labelled[2] ?? "").trim();
          field = key;
        }
      } else {
        // A numbered, non-label line is the title of a NEW object.
        if (cur) objects.push(cur);
        cur = { title: content } as ParsedObject & Record<string, string>;
        field = "title";
      }
    } else {
      if (line === "") continue;
      if (SECTION_HEADERS.has(line)) continue;
      if (ARTIFACT_RE.test(line)) continue;
      if (REF_TITLE_RE.test(line)) continue;
      append(line);
    }
  }
  if (cur) objects.push(cur);
  return objects;
}

/** Collapse whitespace and drop trailing inline-citation digits from prose. */
function cleanProse(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+\d+(?:\s+\d+)*\s*\.\s*$/, ".")
    .replace(/\s+\d+(?:\s+\d+)*\s*$/, "")
    .replace(/\.\.+$/, ".")
    .trim();
}

/** Canonical Red Seal trade label for the well-known trades; raw kept otherwise. */
function normalizeTrade(raw: string | undefined): string {
  const primary = (raw ?? "").split(/[/(]/)[0]?.trim() ?? "";
  const map: Record<string, string> = {
    welding: "Welder",
    electrical: "Electrician",
    plumbing: "Plumber",
    carpentry: "Carpenter",
    hvac: "HVAC/R Technician",
    "hvac/r": "HVAC/R Technician",
    pipefitting: "Steamfitter/Pipefitter",
  };
  return map[primary.toLowerCase()] || primary || "General Trades";
}

/** Deterministic, RFC-4122-shaped v5 id so re-imports upsert in place. */
function stableId(key: string): string {
  const h = createHash("sha1").update(`jack-ko-import|${key}`).digest("hex").split("");
  h[12] = "5"; // version
  h[16] = ((parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16); // variant
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

interface KnowledgeEntry {
  id: string;
  title: string;
  trade: string;
  category: string;
  tags: string[];
  description: string;
  body: string;
  metadata: KnowledgeObjectMeta;
}

/** Map one parsed object onto a Knowledge Entry row (no field is ever required). */
function toEntry(obj: ParsedObject, index: number): KnowledgeEntry {
  const title = cleanProse(obj.title) || `Knowledge Object ${index + 1}`;
  const specialty = cleanProse(obj.specialty);
  const scenario = cleanProse(obj.scenario);
  const problem = cleanProse(obj.problem);
  const rootCause = cleanProse(obj.rootCause);
  const solution = cleanProse(obj.solution);
  const fieldTip = cleanProse(obj.fieldTip);
  const commonMistake = cleanProse(obj.commonMistake);
  const safetyNote = cleanProse(obj.safetyNote);
  const whenNotToUse = cleanProse(obj.whenNotToUse);
  const supportingQuote = cleanProse(obj.supportingQuote);
  const confidence = (obj.confidence ?? "").trim();
  const sourceLink = (obj.sourceLink ?? "").trim();
  const trade = normalizeTrade(obj.trade);

  const tags = (obj.tagsRaw ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const description = scenario || problem || title;

  // Body carries EVERY field so semantic search can match on trade / process /
  // problem / symptom / keyword. Only present fields are emitted.
  const bodyParts: Array<[string, string]> = [
    ["Trade", obj.trade?.trim() ?? ""],
    ["Specialty", specialty],
    ["Scenario", scenario],
    ["Problem", problem],
    ["Root Cause", rootCause],
    ["Solution", solution],
    ["Field Tip", fieldTip],
    ["Common Mistake", commonMistake],
    ["Safety Note", safetyNote],
    ["When Not to Use", whenNotToUse],
    ["Confidence", confidence],
    ["Tags", tags.join(", ")],
    ["Supporting Quote", supportingQuote],
    ["Source", sourceLink],
  ];
  const body = bodyParts
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  // Recognised richer fields go into the typed metadata bag; unmapped source
  // context (raw trade, provenance) is preserved via the index signature.
  const metadata: KnowledgeObjectMeta = {
    origin: "import:knowledge-objects",
    sourceFile: SOURCE_FILE,
    entryNumber: index + 1,
  };
  const setMeta = (k: keyof KnowledgeObjectMeta, v: string): void => {
    if (v) (metadata[k] as unknown) = v;
  };
  setMeta("discipline", specialty);
  setMeta("scenario", scenario);
  setMeta("problem", problem);
  setMeta("rootCause", rootCause);
  setMeta("solution", solution);
  setMeta("fieldTip", fieldTip);
  setMeta("commonMistake", commonMistake);
  setMeta("safetyNote", safetyNote);
  setMeta("whenNotToUse", whenNotToUse);
  setMeta("confidence", confidence);
  setMeta("supportingQuote", supportingQuote);
  setMeta("originalSource", sourceLink);
  if (obj.trade?.trim()) metadata["sourceTrade"] = obj.trade.trim();

  const id = stableId(`${obj.trade ?? ""}|${title}|${scenario}`);
  return { id, title, trade, category: specialty || "General", tags, description, body, metadata };
}

async function importEntry(entry: KnowledgeEntry): Promise<void> {
  const embedInput = [entry.title, entry.description, entry.body].filter(Boolean).join("\n\n");
  const embedding = await createEmbedding(embedInput, { cache: false });
  if (embedding.length === 0) throw new Error("embedding came back empty");

  const { error } = await supabase.from("knowledge_entries").upsert({
    id: entry.id,
    title: entry.title,
    description: entry.description,
    trade: entry.trade,
    category: entry.category,
    tags: entry.tags,
    body: entry.body,
    images: [],
    related_video_ids: [],
    related_timestamps: [],
    attachments: [],
    metadata: entry.metadata,
    embedding: JSON.stringify(embedding),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

async function main(): Promise<void> {
  const absPath = `${REPO_ROOT}${SOURCE_FILE}`;
  const text = loadSourceText(absPath);
  const objects = parseObjects(text);
  console.log(`Parsed ${objects.length} knowledge objects from ${SOURCE_FILE}`);

  let imported = 0;
  const failed: Array<{ title: string; error: string }> = [];
  for (let i = 0; i < objects.length; i++) {
    let title = `Knowledge Object ${i + 1}`;
    try {
      const entry = toEntry(objects[i] as ParsedObject, i);
      title = entry.title;
      await importEntry(entry);
      imported++;
      console.log(`✅ [${imported}] ${entry.trade} — ${entry.title}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ title, error });
      console.error(`⚠️  Skipped "${title}": ${error}`);
    }
  }

  console.log(`\nDone — imported ${imported}/${objects.length} knowledge objects; ${failed.length} failed.`);
  if (failed.length) {
    console.log("Failed objects:");
    for (const f of failed) console.log(`  - ${f.title}: ${f.error}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ import:knowledge failed:", err);
    process.exit(1);
  });
