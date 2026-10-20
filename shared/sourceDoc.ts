/**
 * Källmodell för arbetsytan: en rättskälla (ur Lawlas korpus eller från lagen.nu) som en lista
 * av block – rubriker och textstycken/paragrafer – med innehållsförteckning och etiketter.
 *
 * Etiketten för en markering anger lagrummet först ("4 kap. 1 § UtlL"), så att den blir
 * spårbar i analysen och läsbar i underlaget.
 */

/* ─── Källor och flikar ───────────────────────────────────────────────── */

export type SourceRef = { kind: "doc"; documentId: number } | { kind: "lagen"; uri: string } | { kind: "riksdagen"; dokId: string };

const LAGEN = "https://lagen.nu";

/** Kort, URL-vänlig nyckel för en flik: "d12" (korpus), "l/2005:716" (lagen.nu, utan fragment), "r/GS03170" (riksdagen.se). */
export function sourceKey(ref: SourceRef): string {
  if (ref.kind === "doc") return `d${ref.documentId}`;
  if (ref.kind === "riksdagen") return `r/${ref.dokId}`;
  return `l${stripFragment(ref.uri).slice(LAGEN.length)}`;
}

export function parseSourceKey(key: string): SourceRef | null {
  if (/^d\d+$/.test(key)) return { kind: "doc", documentId: Number(key.slice(1)) };
  if (/^l\/[^\s#?]+$/.test(key)) return { kind: "lagen", uri: LAGEN + key.slice(1) };
  if (/^r\/[A-Z0-9]{4,20}$/.test(key)) return { kind: "riksdagen", dokId: key.slice(2) };
  return null;
}

export function stripFragment(uri: string): string {
  const i = uri.indexOf("#");
  return i === -1 ? uri : uri.slice(0, i);
}

export function fragmentOf(uri: string): string | null {
  const i = uri.indexOf("#");
  return i === -1 ? null : uri.slice(i + 1) || null;
}

/** lagen.nu-adress i en text, t.ex. i en rättskällas kommentar ("Källa: lagen.nu https://lagen.nu/2005:716#K4P1"). */
export function lagenUriIn(text: string | null | undefined): string | null {
  const m = text?.match(/https:\/\/lagen\.nu\/[^\s)"'<>]+/);
  return m ? m[0].replace(/[.,;]+$/, "") : null;
}

/** Källa från riksdagen.se i en kommentar ("Källa: riksdagen.se https://data.riksdagen.se/dokument/GS03170#t12"). */
export function riksdagenRefIn(text: string | null | undefined): { dokId: string; anchor: string | null } | null {
  const m = text?.match(/https:\/\/data\.riksdagen\.se\/dokument\/([A-Z0-9]{4,20})(?:#([^\s)"'<>]+))?/);
  return m ? { dokId: m[1]!, anchor: m[2]?.replace(/[.,;]+$/, "") ?? null } : null;
}

/* ─── Block ───────────────────────────────────────────────────────────── */

export interface SourceBlock {
  /** Ankare inom källan: "K4P1", "P36", "chunk-345", "h3" … Unikt per källa. */
  anchor: string;
  kind: "heading" | "text";
  /** Rubriknivå 1–6; textblock har nivån för rubriken de står under + 1. */
  level: number;
  /** Lagrum ("4 kap. 1 §"), avsnittets namn eller rubrikens text. */
  label: string | null;
  /** Sant när etiketten är ett lagrum (paragraf). */
  lagrum: boolean;
  /** Ren text (radbrytningar bevarade). */
  text: string;
  /** Korpusens avsnitt, om blocket kommer därifrån. */
  chunkId?: number;
}

export interface TocEntry {
  anchor: string;
  label: string;
  level: number;
  /** Paragrafer listas under sin rubrik och kan fällas ihop. */
  leaf: boolean;
}

/** Tar bort markdown-syntax ur lagen.nu:s text: länkar, fetstil, kursiv. */
export function mdToText(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:]|$)/g, "$1$2")
    .replace(/\\([*_[\]()#.-])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const PARAGRAPH_START = /^\*\*(\d{1,3}(?:\s?[a-z])?)\s*§\*\*\s*(.*)$/;
const CHAPTER = /^(\d{1,3}(?:\s?[a-z])?)\s*kap\./i;
/** Långa stycken utan struktur (t.ex. domskäl) delas så att varje block hålls hanterbart. */
const MAX_BLOCK = 4000;

/**
 * Tolkar lagen.nu:s markdown (GET /api/v1/document?format=md) till block. Lagar får ett block
 * per paragraf med lagrum som etikett och lagen.nu:s egna ankare (K4P1); övriga dokument
 * delas efter rubriker.
 */
export function parseLagenMarkdown(md: string, docUri: string): SourceBlock[] {
  const base = stripFragment(docUri);
  const blocks: SourceBlock[] = [];
  const used = new Set<string>();
  const unique = (a: string) => {
    let out = a;
    for (let n = 2; used.has(out); n++) out = `${a}-${n}`;
    used.add(out);
    return out;
  };

  let chapter: string | null = null;
  let headingLevel = 0;
  let headingLabel: string | null = null;
  let current: { block: SourceBlock; lines: string[] } | null = null;
  let seenTitle = false;

  const flush = () => {
    if (!current) return;
    const text = mdToText(current.lines.join("\n"));
    if (text) {
      // Långa block utan paragrafindelning delas vid stycken.
      if (!current.block.lagrum && text.length > MAX_BLOCK) {
        const parts = splitLong(text);
        parts.forEach((t, i) => blocks.push({ ...current!.block, anchor: i === 0 ? current!.block.anchor : unique(`${current!.block.anchor}-${i + 1}`), text: t }));
      } else {
        // Stycken i en paragraf visas med enkel radbrytning, som i författningstext.
        blocks.push({ ...current.block, text: current.block.lagrum ? text.replace(/\n{2,}/g, "\n") : text });
      }
    }
    current = null;
  };

  md.split("\n").forEach((line, i) => {
    const h = line.match(HEADING);
    if (h) {
      flush();
      const level = h[1]!.length;
      const raw = h[2]!;
      const text = mdToText(raw);
      if (level === 1 && !seenTitle) {
        seenTitle = true; // dokumentets titel visas i fliken, inte som rubrik
        return;
      }
      const link = raw.match(/\]\((https:\/\/lagen\.nu\/[^)\s]+)\)/)?.[1];
      const frag = link && stripFragment(link) === base ? fragmentOf(link) : null;
      const chap = text.match(CHAPTER);
      if (chap) chapter = chap[1]!.replace(/\s+/g, " ");
      headingLevel = level;
      headingLabel = text;
      blocks.push({ anchor: unique(frag ?? `h${i}`), kind: "heading", level, label: text, lagrum: false, text });
      return;
    }
    // Kapitelrubrik i fetstil (författningskommentarer: "**5 kap. Uppehållstillstånd**").
    const boldChapter = line.match(/^\*\*(\d{1,3}(?:\s?[a-z])?)\s*kap\.[^§]*\*\*\s*$/);
    if (boldChapter) chapter = boldChapter[1]!.replace(/\s+/g, " ");
    const p = line.match(PARAGRAPH_START);
    if (p) {
      flush();
      const par = p[1]!.replace(/\s+/g, " ");
      const anchor = `${chapter ? `K${chapter.replace(/\s/g, "")}` : ""}P${par.replace(/\s/g, "")}`;
      current = {
        block: { anchor: unique(anchor), kind: "text", level: headingLevel + 1, label: `${chapter ? `${chapter} kap. ` : ""}${par} §`, lagrum: true, text: "" },
        lines: [`${par} § ${p[2]!}`],
      };
      return;
    }
    if (!current) {
      if (!line.trim()) return;
      current = { block: { anchor: unique(`t${i}`), kind: "text", level: headingLevel + 1, label: headingLabel, lagrum: false, text: "" }, lines: [] };
    }
    current.lines.push(line);
  });
  flush();
  return blocks;
}

function splitLong(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const para of text.split(/\n\n/)) {
    if (buf && buf.length + para.length > MAX_BLOCK) {
      out.push(buf);
      buf = para;
    } else buf = buf ? `${buf}\n\n${para}` : para;
  }
  if (buf) out.push(buf);
  return out;
}

/** Lawlas korpus: ett block per avsnitt. */
export function chunksToBlocks(chunks: { id: number; chunkIndex: number; displayLabel: string | null; content: string | null }[]): SourceBlock[] {
  return [...chunks]
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((c) => {
      const label = c.displayLabel?.trim() || null;
      return {
        anchor: `chunk-${c.id}`,
        kind: "text" as const,
        level: 1,
        label,
        lagrum: !!label && /\d\s*§/.test(label),
        text: (c.content ?? "").trim(),
        chunkId: c.id,
      };
    });
}

/** Innehållsförteckning: rubriker samt paragrafer/avsnitt med etikett. */
export function buildToc(blocks: SourceBlock[]): TocEntry[] {
  const out: TocEntry[] = [];
  let lastLabel: string | null = null;
  for (const b of blocks) {
    if (b.kind === "heading") {
      out.push({ anchor: b.anchor, label: b.label ?? "", level: b.level, leaf: false });
      lastLabel = b.label;
    } else if (b.label && (b.lagrum || b.label !== lastLabel)) {
      out.push({ anchor: b.anchor, label: b.label, level: b.level, leaf: true });
      lastLabel = b.label;
    }
  }
  return out;
}

/* ─── Förkortningar och etiketter ─────────────────────────────────────── */

/** Del av lagens titel → vedertagen förkortning. Mer specifika först. */
const ABBREVIATIONS: [string, string][] = [
  ["om avtal och andra rättshandlingar", "AvtL"],
  ["konsumentköplag", "KKL"],
  ["konsumenttjänstlag", "KtjL"],
  ["konsumentkreditlag", "KkrL"],
  ["försäkringsavtalslag", "FAL"],
  ["förvaltningsprocesslag", "FPL"],
  ["mervärdesskattelag", "ML"],
  ["äktenskapsbalk", "ÄktB"],
  ["föräldrabalk", "FB"],
  ["ärvdabalk", "ÄB"],
  ["jordabalk", "JB"],
  ["brottsbalk", "BrB"],
  ["rättegångsbalk", "RB"],
  ["handelsbalk", "HB"],
  ["miljöbalk", "MB"],
  ["utsökningsbalk", "UB"],
  ["sambolag", "SamboL"],
  ["köplag", "KöpL"],
  ["skadeståndslag", "SkL"],
  ["aktiebolagslag", "ABL"],
  ["bokföringslag", "BFL"],
  ["om anställningsskydd", "LAS"],
  ["om medbestämmande i arbetslivet", "MBL"],
  ["diskrimineringslag", "DL"],
  ["semesterlag", "SemL"],
  ["arbetstidslag", "ATL"],
  ["arbetsmiljölag", "AML"],
  ["socialtjänstlag", "SoL"],
  ["om stöd och service till vissa funktionshindrade", "LSS"],
  ["inkomstskattelag", "IL"],
  ["skatteförfarandelag", "SFL"],
  ["offentlighets- och sekretesslag", "OSL"],
  ["förvaltningslag", "FL"],
  ["plan- och bygglag", "PBL"],
  ["regeringsform", "RF"],
  ["tryckfrihetsförordning", "TF"],
  ["yttrandefrihetsgrundlag", "YGL"],
  ["om upphovsrätt till litterära och konstnärliga verk", "URL"],
  ["varumärkeslag", "VML"],
  ["patentlag", "PL"],
  ["konkurslag", "KL"],
  ["om unga lagöverträdare", "LUL"],
  ["om vård av unga", "LVU"],
  ["om vård av missbrukare", "LVM"],
  ["om psykiatrisk tvångsvård", "LPT"],
  ["utlänningslag", "UtlL"],
  ["hälso- och sjukvårdslag", "HSL"],
  ["patientsäkerhetslag", "PSL"],
  ["bostadsrättslag", "BRL"],
  ["om ekonomiska föreningar", "EFL"],
  ["dataskyddsförordning", "GDPR"],
];

export function lawAbbreviation(title: string | null | undefined): string | null {
  if (!title) return null;
  const lower = title.toLowerCase();
  for (const [needle, abbr] of ABBREVIATIONS) if (lower.includes(needle)) return abbr;
  return null;
}

/** Kort namn för en flik: förkortning, beteckning eller förkortad titel. */
export function shortSourceName(title: string | null | undefined, identifier: string | null | undefined): string {
  return lawAbbreviation(title) ?? identifier?.replace(/^SFS\s+/, "SFS ") ?? (title && title.length > 28 ? `${title.slice(0, 26)}…` : title) ?? "Källa";
}

/** "4 kap. 1 §" + "4 kap. 3 §" → "4 kap. 1–3 §§"; olika kapitel → "4 kap. 1 § – 5 kap. 2 §". */
export function lagrumRange(from: string, to: string): string {
  if (from === to) return from;
  const a = from.match(/^(?:(\d{1,3}(?:\s?[a-z])?) kap\. )?(\d{1,3}(?:\s?[a-z])?) §$/);
  const b = to.match(/^(?:(\d{1,3}(?:\s?[a-z])?) kap\. )?(\d{1,3}(?:\s?[a-z])?) §$/);
  if (a && b && (a[1] ?? null) === (b[1] ?? null)) return `${a[1] ? `${a[1]} kap. ` : ""}${a[2]}–${b[2]} §§`;
  return `${from} – ${to}`;
}

export interface SourceMeta {
  title: string | null;
  identifier: string | null;
  /** Falskt för förarbeten: paragrafer där är kommentarer till en lag, inte lagrum i källan. */
  isLaw?: boolean;
}

/**
 * Etikett för en markering. Lagrum först: "4 kap. 1 § UtlL", "36–38 §§ AvtL",
 * annars källans beteckning följd av avsnittet: "Prop. 2004/05:170 – 5.3 Verkställighet".
 */
export function selectionLabel(first: SourceBlock, last: SourceBlock, meta: SourceMeta): string {
  const abbr = lawAbbreviation(meta.title);
  const docName = abbr ?? meta.identifier ?? meta.title ?? "Källa";
  if (first.lagrum && last.lagrum && first.label && last.label && meta.isLaw === false) {
    return `${meta.identifier ?? meta.title ?? "Förarbete"}, kommentaren till ${lagrumRange(first.label, last.label)}`;
  }
  if (first.lagrum && last.lagrum && first.label && last.label) {
    // Korpusens etiketter kan redan innehålla lagens namn ("Äktenskapsbalk 12 kap. 3 §").
    const range = lagrumRange(first.label, last.label);
    const hasLaw = /[A-Za-zÅÄÖåäö]{3,}/.test(range.replace(/kap\./g, ""));
    return hasLaw ? range : `${range} ${docName}`;
  }
  const part = first.label && first.label !== last.label && last.label ? `${first.label} – ${last.label}` : first.label;
  return part && part !== docName ? `${docName} – ${part}` : docName;
}

/** Utdrag ur markerad text för visning: första raderna, förkortat vid ordgräns. */
export function excerpt(text: string, max = 180): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.lastIndexOf(" ", max);
  return `${t.slice(0, cut > max * 0.6 ? cut : max)}…`;
}

/* ─── Gå till lagrum ──────────────────────────────────────────────────── */

export interface LagrumQuery {
  chapter: string | null;
  paragraph: string | null;
}

const NUM = String.raw`(\d{1,3}(?:\s?[a-z](?![a-zåäö]))?)`;

/**
 * Tolkar en sökning som ett lagrum: "7 18", "7:18", "7 kap 18", "7 kap. 18 §", "3 a 2",
 * "7 18 a" → kapitel + paragraf; "7 kap" → kapitel; "18 §" → paragraf. Ett ensamt tal ("36")
 * tolkas av läsytan beroende på om källan har kapitel. Annan text ger null (vanlig fritextsökning).
 */
export function parseLagrumQuery(raw: string): LagrumQuery | null {
  const q = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (!q) return null;
  let m = q.match(new RegExp(`^${NUM}\\s*(?:kap(?:\\.|itlet)?\\s*|:\\s*|\\s)${NUM}\\s*(?:§§?|p\\.?)?$`));
  if (m) return { chapter: norm(m[1]!), paragraph: norm(m[2]!) };
  m = q.match(new RegExp(`^${NUM}\\s*kap(?:\\.|itlet)?$`));
  if (m) return { chapter: norm(m[1]!), paragraph: null };
  m = q.match(new RegExp(`^(?:§\\s*)?${NUM}\\s*(?:§§?)?$`));
  if (m && (q.includes("§") || /^\d{1,3}(?:\s?[a-z])?$/.test(q))) return { chapter: null, paragraph: norm(m[1]!) };
  return null;
}

/** "3a" → "3 a", "18" → "18". */
function norm(s: string): string {
  return s.replace(/\s+/g, "").replace(/^(\d+)([a-z])$/, "$1 $2");
}

/** Läsbar form: "7 kap. 18 §", "7 kap.", "36 §". */
export function lagrumText(q: LagrumQuery): string {
  return [q.chapter ? `${q.chapter} kap.` : null, q.paragraph ? `${q.paragraph} §` : null].filter(Boolean).join(" ");
}

/**
 * Blocket som ett lagrum pekar på. Matchas mot etiketten (fungerar för både lagen.nu och korpusens
 * avsnitt, vars etikett kan ha lagens namn före, "Äktenskapsbalk 12 kap. 3 §").
 * Ett ensamt tal tolkas som paragraf i lagar utan kapitel och som kapitel annars.
 */
export function findLagrum(blocks: SourceBlock[], q: LagrumQuery): SourceBlock | null {
  const hasChapters = blocks.some((b) => b.lagrum && /\bkap\./.test(b.label ?? ""));
  const { chapter, paragraph } = q;
  const clean = (s: string | null) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

  if (chapter && paragraph) {
    const want = `${chapter} kap. ${paragraph} §`;
    return blocks.find((b) => b.lagrum && (clean(b.label) === want || clean(b.label).endsWith(` ${want}`))) ?? null;
  }
  if (chapter) {
    const re = new RegExp(`(^|\\s)${escapeRe(chapter)} kap\\.(\\s|$)`);
    return blocks.find((b) => b.kind === "heading" && re.test(clean(b.label))) ?? blocks.find((b) => b.lagrum && re.test(clean(b.label))) ?? null;
  }
  if (paragraph) {
    const want = `${paragraph} §`;
    const exact = blocks.find((b) => b.lagrum && (clean(b.label) === want || (!/kap\./.test(clean(b.label)) && clean(b.label).endsWith(` ${want}`))));
    if (exact) return exact;
    return hasChapters ? (blocks.find((b) => b.lagrum && clean(b.label).endsWith(` ${want}`)) ?? null) : null;
  }
  return null;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Ett ensamt tal ("7") i en lag med kapitel betyder kapitel; utan kapitel betyder det paragraf. */
export function resolveBareNumber(blocks: SourceBlock[], q: LagrumQuery, raw: string): LagrumQuery {
  if (q.chapter || !q.paragraph || raw.includes("§")) return q;
  const hasChapters = blocks.some((b) => b.lagrum && /\bkap\./.test(b.label ?? ""));
  return hasChapters ? { chapter: q.paragraph, paragraph: null } : q;
}
