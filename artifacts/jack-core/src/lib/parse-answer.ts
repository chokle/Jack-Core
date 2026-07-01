export interface Run {
  text: string;
  bold?: boolean;
}

export interface KV {
  label: string;
  value: Run[];
}

export type ListItem = { kv: KV } | { runs: Run[] };

export type Block =
  | { type: "para"; runs: Run[] }
  | { type: "kv"; kv: KV }
  | { type: "list"; items: ListItem[] };

export interface AnswerSection {
  title: string;
  key: string;
  canonical: boolean;
  blocks: Block[];
}

export interface ParsedAnswer {
  shortAnswer: string;
  sections: AnswerSection[];
  hasDetail: boolean;
}

const SHORT_ANSWER_MAX = 240;

const HR = /^\s*([-*_])\1{2,}\s*$/;
const ATX = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/;
const BOLD_HEADING = /^\s*(\*\*|__)(.+?)\1\s*:?\s*$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;

function canonicalSection(raw: string): { title: string; key: string; canonical: boolean } {
  const norm = raw.toLowerCase().replace(/[^a-z]/g, "");
  const has = (...ks: string[]) => ks.some((k) => norm.includes(k));
  if (has("overview", "summary", "tldr", "background", "introduction"))
    return { title: "Overview", key: "overview", canonical: true };
  if (has("safety", "precaution", "warning", "hazard", "ppe"))
    return { title: "Safety", key: "safety", canonical: true };
  if (has("equipment", "tools", "tooling"))
    return { title: "Equipment", key: "equipment", canonical: true };
  if (has("materials", "supplies", "consumables"))
    return { title: "Materials", key: "materials", canonical: true };
  if (has("fieldtip", "protip", "tips", "tip", "tricks"))
    return { title: "Field Tips", key: "fieldtips", canonical: true };
  if (has("commonmistake", "mistake", "pitfall", "avoid", "errors"))
    return { title: "Common Mistakes", key: "mistakes", canonical: true };
  if (has("code", "standard", "regulation", "requirement", "redseal", "compliance"))
    return { title: "Code / Procedure Requirements", key: "code", canonical: true };
  if (has("procedure", "steps", "step", "instructions", "howto", "process", "method"))
    return { title: "Procedure", key: "procedure", canonical: true };
  if (has("related", "seealso", "furtherreading"))
    return { title: "Related Topics", key: "related", canonical: true };
  if (has("source", "reference", "citation"))
    return { title: "Sources", key: "sources", canonical: true };
  return { title: raw.trim().replace(/:$/, ""), key: "custom", canonical: false };
}

function clean(t: string): string {
  return t
    .replace(/[*`]/g, "")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function toRuns(input: string): Run[] {
  const s = input
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
  const runs: Run[] = [];
  const re = /(\*\*|__)(.+?)\1/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) {
      const t = clean(s.slice(last, m.index));
      if (t) runs.push({ text: t });
    }
    const b = clean(m[2] ?? "");
    if (b) runs.push({ text: b, bold: true });
    last = re.lastIndex;
  }
  if (last < s.length) {
    const t = clean(s.slice(last));
    if (t) runs.push({ text: t });
  }
  return runs.filter((r) => r.text.length > 0);
}

export function runsToText(runs: Run[]): string {
  return runs.map((r) => r.text).join(" ").replace(/\s+/g, " ").trim();
}

function asKV(text: string): KV | null {
  const plain = text.replace(/\*\*/g, "").replace(/__/g, "").replace(/`/g, "").trim();
  const m = plain.match(/^([A-Za-z][A-Za-z0-9 /()\-.]{0,38}?):\s+(\S.*)$/);
  if (!m) return null;
  const label = m[1].trim();
  if (label.split(/\s+/).length > 6) return null;
  const value = toRuns(m[2]);
  if (value.length === 0) return null;
  return { label, value };
}

function isHeading(line: string): string | null {
  const atx = line.match(ATX);
  if (atx) return atx[1];
  const bold = line.match(BOLD_HEADING);
  if (bold) return bold[2];
  const bare = line.trim().replace(/:$/, "");
  if (bare.length > 0 && bare.length <= 40 && /^[A-Za-z][A-Za-z ()/\-]*$/.test(bare)) {
    const c = canonicalSection(bare);
    if (c.canonical) return bare;
  }
  return null;
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let bullets: ListItem[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    const joined = para.join(" ");
    const kv = asKV(joined);
    if (kv) blocks.push({ type: "kv", kv });
    else {
      const runs = toRuns(joined);
      if (runs.length > 0) blocks.push({ type: "para", runs });
    }
    para = [];
  };
  const flushBullets = () => {
    if (bullets.length === 0) return;
    blocks.push({ type: "list", items: bullets });
    bullets = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") {
      flushPara();
      flushBullets();
      continue;
    }
    const bulletMatch = line.match(BULLET);
    if (bulletMatch) {
      flushPara();
      const item = bulletMatch[1];
      const kv = asKV(item);
      bullets.push(kv ? { kv } : { runs: toRuns(item) });
      continue;
    }
    flushBullets();
    const kv = asKV(line.trim());
    if (kv) {
      flushPara();
      blocks.push({ type: "kv", kv });
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  flushBullets();
  return blocks;
}

function trimLead(text: string): string {
  const t = text.trim();
  if (t.length <= SHORT_ANSWER_MAX) return t;
  const window = t.slice(0, SHORT_ANSWER_MAX);
  const lastStop = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (lastStop > 80) return t.slice(0, lastStop + 1).trim();
  const lastSpace = window.lastIndexOf(" ");
  return (lastSpace > 80 ? t.slice(0, lastSpace) : window).trim() + "…";
}

function mergeSections(sections: AnswerSection[]): AnswerSection[] {
  const out: AnswerSection[] = [];
  const byKey = new Map<string, AnswerSection>();
  for (const sec of sections) {
    if (sec.key !== "custom" && byKey.has(sec.key)) {
      byKey.get(sec.key)!.blocks.push(...sec.blocks);
      continue;
    }
    out.push(sec);
    if (sec.key !== "custom") byKey.set(sec.key, sec);
  }
  return out;
}

function firstTextFromSections(sections: AnswerSection[]): string {
  for (const sec of sections) {
    for (let i = 0; i < sec.blocks.length; i++) {
      const b = sec.blocks[i];
      if (b.type === "para") {
        const text = runsToText(b.runs);
        sec.blocks.splice(i, 1);
        return text;
      }
      if (b.type === "kv") {
        const text = `${b.kv.label}: ${runsToText(b.kv.value)}`;
        sec.blocks.splice(i, 1);
        return text;
      }
      if (b.type === "list" && b.items.length > 0) {
        const it = b.items[0];
        const text = "kv" in it ? `${it.kv.label}: ${runsToText(it.kv.value)}` : runsToText(it.runs);
        b.items.splice(0, 1);
        if (b.items.length === 0) sec.blocks.splice(i, 1);
        return text;
      }
    }
  }
  return "";
}

export function parseAnswer(content: string): ParsedAnswer {
  const raw = (content ?? "").replace(/\r\n/g, "\n").split("\n").filter((l) => !HR.test(l));

  const leadLines: string[] = [];
  const rawSections: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } | null = null;

  for (const line of raw) {
    const heading = isHeading(line);
    if (heading !== null) {
      current = { title: heading, lines: [] };
      rawSections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else leadLines.push(line);
  }

  const leadBlocks = parseBlocks(leadLines);
  let shortAnswer = "";
  const leadOverflow: Block[] = [];
  for (const b of leadBlocks) {
    if (!shortAnswer && b.type === "para") {
      const text = runsToText(b.runs);
      shortAnswer = trimLead(text);
      if (shortAnswer !== text.trim()) {
        const remainder = text.trim().slice(shortAnswer.replace(/…$/, "").length).trim();
        if (remainder) leadOverflow.push({ type: "para", runs: toRuns(remainder) });
      }
      continue;
    }
    leadOverflow.push(b);
  }

  let sections: AnswerSection[] = [];
  if (leadOverflow.length > 0) {
    sections.push({ title: "Overview", key: "overview", canonical: true, blocks: leadOverflow });
  }
  for (const rs of rawSections) {
    const c = canonicalSection(rs.title);
    const blocks = parseBlocks(rs.lines);
    if (blocks.length === 0) continue;
    sections.push({ title: c.title, key: c.key, canonical: c.canonical, blocks });
  }

  sections = mergeSections(sections);

  if (!shortAnswer) {
    shortAnswer = trimLead(firstTextFromSections(sections));
    sections = sections.filter((s) => s.blocks.length > 0);
  }

  if (!shortAnswer) shortAnswer = trimLead(clean((content ?? "").replace(/\n+/g, " ")));

  if (!shortAnswer) shortAnswer = "No answer is available for this question yet.";

  return { shortAnswer, sections, hasDetail: sections.length > 0 };
}
