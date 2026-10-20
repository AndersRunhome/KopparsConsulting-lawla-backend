/**
 * Strukturmedveten chunkning. Tar block från parsern (shared/sourceDoc.ts) och bygger chunkar
 * med sökväg, förälder och kontext – det som gör att en paragraf blir hittbar på vad den handlar
 * om, inte bara på sina egna ord. Se docs/ARCHITECTURE.md §5.
 */
import type { SourceBlock } from "../../shared/sourceDoc.js";

export interface ChunkDraft {
  anchor: string;
  kind: "paragraf" | "avsnitt" | "kommentar" | "domskal" | "rubrik" | "text";
  label: string | null;
  /** Rubrikerna ovanför, från dokumentets rot: ["5 kap. Uppehållstillstånd", "Anknytning"]. */
  path: string[];
  /** Index i listan för föräldern (rubriken närmast ovanför), eller null. */
  parentIndex: number | null;
  context: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface ChunkOptions {
  /** Dokumentets titel – första ledet i kontexten. */
  title: string;
  /** Största chunk innan långa textblock delas (tecken). Paragrafer delas aldrig. */
  maxChars?: number;
  /** Överlapp vid delning av långa block (tecken). */
  overlap?: number;
}

const DEFAULT_MAX = 2400;
const DEFAULT_OVERLAP = 200;

/** Bygger "Titel › Kapitel › Rubrik › Etikett". */
export function contextLine(title: string, path: string[], label: string | null): string {
  const parts = [title, ...path];
  if (label && label !== path[path.length - 1]) parts.push(label);
  return parts.join(" › ");
}

/**
 * Block → chunkar. Rubriker blir egna (små) chunkar så att innehållsförteckning och
 * förälderkedja finns i databasen; textblock får rubrikkedjan som path.
 */
export function chunkBlocks(blocks: SourceBlock[], opts: ChunkOptions): ChunkDraft[] {
  const max = opts.maxChars ?? DEFAULT_MAX;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;
  const out: ChunkDraft[] = [];
  /** Rubrikstack: [nivå, text, index i out]. */
  const stack: { level: number; text: string; index: number }[] = [];
  const used = new Set<string>();
  const unique = (a: string) => {
    let s = a;
    for (let n = 2; used.has(s); n++) s = `${a}-${n}`;
    used.add(s);
    return s;
  };

  for (const b of blocks) {
    if (b.kind === "heading") {
      while (stack.length && stack[stack.length - 1]!.level >= b.level) stack.pop();
      const path = stack.map((s) => s.text);
      const parent = stack[stack.length - 1];
      const index = out.length;
      out.push({
        anchor: unique(b.anchor),
        kind: "rubrik",
        label: b.label,
        path,
        parentIndex: parent ? parent.index : null,
        context: contextLine(opts.title, path, b.label),
        content: b.text,
        metadata: { level: b.level },
      });
      stack.push({ level: b.level, text: b.text, index });
      continue;
    }
    const path = stack.map((s) => s.text);
    const parent = stack[stack.length - 1];
    const kind: ChunkDraft["kind"] = b.lagrum ? "paragraf" : "avsnitt";
    const base = {
      kind,
      label: b.label,
      path,
      parentIndex: parent ? parent.index : null,
      context: contextLine(opts.title, path, b.label),
      metadata: b.lagrum ? lagrumMeta(b.label) : {},
    };
    if (b.lagrum || b.text.length <= max) {
      out.push({ ...base, anchor: unique(b.anchor), content: b.text });
    } else {
      splitWithOverlap(b.text, max, overlap).forEach((part, i) => {
        out.push({ ...base, anchor: unique(i === 0 ? b.anchor : `${b.anchor}-${i + 1}`), content: part, metadata: { ...base.metadata, part: i + 1 } });
      });
    }
  }
  return out;
}

function lagrumMeta(label: string | null): Record<string, unknown> {
  const m = label?.match(/^(?:(\d{1,3}(?:\s?[a-z])?) kap\. )?(\d{1,3}(?:\s?[a-z])?) §$/);
  if (!m) return {};
  return { chapter: m[1] ?? null, paragraph: m[2] };
}

/** Delar vid styckegränser, annars vid meningar, med överlapp så att inget sammanhang tappas. */
export function splitWithOverlap(text: string, max: number, overlap: number): string[] {
  const units = text.split(/\n\n+/).flatMap((p) => (p.length <= max ? [p] : splitSentences(p, max)));
  const out: string[] = [];
  let buf = "";
  for (const u of units) {
    if (buf && buf.length + u.length + 2 > max) {
      out.push(buf);
      const tail = buf.slice(Math.max(0, buf.length - overlap));
      const cut = tail.search(/[.!?]\s/);
      buf = (cut >= 0 ? tail.slice(cut + 2) : tail).trim();
      buf = buf ? `${buf}\n\n${u}` : u;
    } else buf = buf ? `${buf}\n\n${u}` : u;
  }
  if (buf) out.push(buf);
  return out;
}

function splitSentences(p: string, max: number): string[] {
  const sentences = p.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [p];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf && buf.length + s.length > max) {
      out.push(buf.trim());
      buf = s;
    } else buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
