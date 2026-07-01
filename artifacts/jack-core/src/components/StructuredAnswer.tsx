import { useState } from "react";
import {
  Film,
  PlayCircle,
  ChevronDown,
  ChevronUp,
  FileText,
  ShieldAlert,
  Wrench,
  Package,
  Lightbulb,
  AlertTriangle,
  BookMarked,
  ListOrdered,
  Link2,
  Layers,
  type LucideIcon,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { Citation } from "@workspace/api-client-react";
import { parseAnswer, type AnswerSection, type Block, type Run } from "@/lib/parse-answer";

interface StructuredAnswerProps {
  content: string;
  citations?: Citation[];
  usedInternalKnowledge?: boolean;
  onCitationClick: (videoId: string, startTime: number) => void;
}

const SECTION_ICONS: Record<string, LucideIcon> = {
  overview: FileText,
  procedure: ListOrdered,
  equipment: Wrench,
  materials: Package,
  safety: ShieldAlert,
  fieldtips: Lightbulb,
  mistakes: AlertTriangle,
  code: BookMarked,
  related: Link2,
  sources: Film,
  custom: Layers,
};

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function deriveConfidence(citations: Citation[], used?: boolean): { label: string; tone: string } {
  const n = citations.length;
  if (n >= 2) return { label: "High confidence", tone: "high" };
  if (n === 1) return { label: "Medium confidence", tone: "medium" };
  if (used === true) return { label: "Medium confidence", tone: "medium" };
  return { label: "General knowledge", tone: "low" };
}

const TONE_CLASSES: Record<string, string> = {
  high: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  medium: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  low: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
};

function Runs({ runs }: { runs: Run[] }) {
  return (
    <>
      {runs.map((r, i) =>
        r.bold ? (
          <strong key={i} className="font-semibold text-white">
            {r.text}
          </strong>
        ) : (
          <span key={i}>{r.text}</span>
        )
      )}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  if (block.type === "para") {
    return (
      <p className="text-sm leading-relaxed text-foreground/90">
        <Runs runs={block.runs} />
      </p>
    );
  }
  if (block.type === "kv") {
    return (
      <p className="text-sm leading-relaxed">
        <span className="font-semibold text-primary">{block.kv.label}: </span>
        <span className="text-white">
          <Runs runs={block.kv.value} />
        </span>
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {block.items.map((item, i) => (
        <li key={i} className="flex gap-2 text-sm leading-relaxed">
          <span className="mt-[2px] text-primary flex-shrink-0">•</span>
          <span className="text-foreground/90">
            {"kv" in item ? (
              <>
                <span className="font-semibold text-primary">{item.kv.label}: </span>
                <span className="text-white">
                  <Runs runs={item.kv.value} />
                </span>
              </>
            ) : (
              <Runs runs={item.runs} />
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SectionCard({ section }: { section: AnswerSection }) {
  const Icon = SECTION_ICONS[section.key] ?? Layers;
  return (
    <div className="rounded-lg border border-card-border bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-primary flex-shrink-0" />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-primary">{section.title}</h4>
      </div>
      <div className="space-y-2">
        {section.blocks.map((b, i) => (
          <BlockView key={i} block={b} />
        ))}
      </div>
    </div>
  );
}

export function StructuredAnswer({
  content,
  citations,
  usedInternalKnowledge,
  onCitationClick,
}: StructuredAnswerProps) {
  const [open, setOpen] = useState(false);
  const parsed = parseAnswer(content);
  const cites = citations ?? [];
  const confidence = deriveConfidence(cites, usedInternalKnowledge);
  const sections = cites.length > 0 ? parsed.sections.filter((s) => s.key !== "sources") : parsed.sections;
  const hasDetail = sections.length > 0;

  return (
    <div className="w-full space-y-2">
      <div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider ${TONE_CLASSES[confidence.tone]}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {confidence.label}
        </span>
      </div>

      <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
        <div className="mb-1.5 text-[10px] font-mono uppercase tracking-wider text-primary">Short Answer</div>
        <p className="text-[15px] font-medium leading-snug text-white break-words">{parsed.shortAnswer}</p>
      </div>

      {hasDetail && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex min-h-11 w-full items-center justify-between rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
          >
            <span className="text-sm font-semibold text-foreground">{open ? "Hide Details" : "Expand Details"}</span>
            {open ? (
              <ChevronUp className="h-4 w-4 text-primary" />
            ) : (
              <ChevronDown className="h-4 w-4 text-primary" />
            )}
          </button>
          <AnimatePresence initial={false}>
            {open && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="space-y-2">
                  {sections.map((s, i) => (
                    <SectionCard key={`${s.key}-${i}`} section={s} />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {cites.length > 0 && (
        <div className="rounded-xl border border-card-border bg-card p-3 space-y-3">
          <div className="flex items-center gap-1.5">
            <Film className="h-3.5 w-3.5 text-primary flex-shrink-0" />
            <span className="text-[10px] font-mono uppercase tracking-wider text-primary">Source</span>
          </div>
          {cites.map((c, i) => (
            <div key={i} className={i > 0 ? "space-y-2 border-t border-border pt-3" : "space-y-2"}>
              <div className="flex gap-2">
                <div className="h-10 w-16 flex-shrink-0 overflow-hidden rounded bg-zinc-800">
                  {c.thumbnailUrl && (
                    <img src={c.thumbnailUrl} className="h-full w-full object-cover" alt="" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold leading-tight text-white">{c.videoTitle}</div>
                  <div className="font-mono text-xs text-primary">
                    {fmtTime(c.startTime)}–{fmtTime(c.endTime)}
                  </div>
                  {c.text && <div className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{c.text}</div>}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onCitationClick(c.videoId, c.startTime)}
                className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg bg-primary text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <PlayCircle className="h-4 w-4" />
                Jump to Clip
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
