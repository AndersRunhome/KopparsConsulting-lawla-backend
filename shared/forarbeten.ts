/**
 * Förarbeten till en enskild bestämmelse.
 *
 * 1. Historik: lagen.nu:s metadata om ändringsförfattningar ("ändr. 5 kap. 18 §; nya 5 kap.
 *    15 b, 16 a §§; nuvarande 5 kap. 16 a § betecknas 5 kap. 16 b §") följs bakåt från dagens
 *    lagrum. Byter bestämmelsen beteckning följer vi den gamla beteckningen vidare bakåt.
 * 2. Specialkommentar: i propositionens författningskommentar (äldre: specialmotivering) letas
 *    avsnittet för lagen och bestämmelsen upp ("**5 kap.**", "**3 § Rubrik**", "#### 1–3 §§").
 */

/* ─── Lagrum ──────────────────────────────────────────────────────────── */

export interface Lagrum {
  chapter: string | null;
  paragraph: string;
}

/** "3a" / "3 a" → "3 a". */
export function normNum(s: string): string {
  return s.replace(/\s+/g, "").replace(/^(\d+)([a-z])$/, "$1 $2");
}

export function lagrumLabel(l: Lagrum): string {
  return `${l.chapter ? `${l.chapter} kap. ` : ""}${l.paragraph} §`;
}

export function parseLagrumLabel(label: string): Lagrum | null {
  const m = label.trim().match(/^(?:(\d{1,3}\s?[a-z]?)\s*kap\.?\s*)?(\d{1,3}\s?[a-z]?)\s*§$/);
  return m ? { chapter: m[1] ? normNum(m[1]) : null, paragraph: normNum(m[2]!) } : null;
}

/** lagen.nu-ankare "K7P18", "K3aP2", "P36" → lagrum. */
export function lagrumFromAnchor(anchor: string): Lagrum | null {
  const m = anchor.match(/^(?:K(\d{1,3}[a-z]?))?P(\d{1,3}[a-z]?)$/);
  return m ? { chapter: m[1] ? normNum(m[1]) : null, paragraph: normNum(m[2]!) } : null;
}

const same = (a: Lagrum, b: Lagrum) => a.chapter === b.chapter && a.paragraph === b.paragraph;

/** Nummer i en uppräkning; "1–3" expanderas när båda är heltal. */
function expandRange(a: string, b: string): string[] {
  const x = Number(a);
  const y = Number(b);
  if (Number.isInteger(x) && Number.isInteger(y) && y >= x && y - x < 200) return Array.from({ length: y - x + 1 }, (_, i) => String(x + i));
  return [a, b];
}

const NUM_TOKEN = String.raw`\d{1,3}(?:\s?[a-z](?![a-zåäö]))?`;

/**
 * Läser ut lagrum ur en uppräkning, t.ex. "4 kap 1, 2 §§, 5 kap 1 §" eller "5 kap. 15 b, 16 a §§".
 * Ett kapitel utan paragrafer ("ny 3 a kap.") ger { chapter, paragraph: "*" }.
 */
export function parseLagrumList(text: string): Lagrum[] {
  const re = new RegExp(String.raw`(${NUM_TOKEN})\s*kap\.?|(${NUM_TOKEN})|(§§?)|(–|-)`, "gi");
  const out: Lagrum[] = [];
  let chapter: string | null = null;
  let chapterUsed = true;
  let pending: string[] = [];
  let range = false;
  for (const m of text.matchAll(re)) {
    if (m[1]) {
      if (!chapterUsed && chapter) out.push({ chapter, paragraph: "*" });
      chapter = normNum(m[1]);
      chapterUsed = false;
      pending = [];
    } else if (m[2]) {
      const n = normNum(m[2]);
      if (range && pending.length) {
        const from = pending.pop()!;
        pending.push(...expandRange(from, n));
      } else pending.push(n);
      range = false;
    } else if (m[3]) {
      for (const p of pending) out.push({ chapter, paragraph: p });
      if (pending.length) chapterUsed = true;
      pending = [];
    } else if (m[4]) {
      range = true;
    }
  }
  if (!chapterUsed && chapter) out.push({ chapter, paragraph: "*" });
  return out;
}

export interface AmendmentOps {
  changed: Lagrum[];
  added: Lagrum[];
  repealed: Lagrum[];
  /** Ny beteckning: from (gammal) → to (ny). */
  renamed: { from: Lagrum; to: Lagrum }[];
}

/** Tolkar lagen.nu:s "rpubl:andrar" för en ändringsförfattning. */
export function parseAndrar(text: string | null | undefined): AmendmentOps {
  const ops: AmendmentOps = { changed: [], added: [], repealed: [], renamed: [] };
  if (!text) return ops;
  for (const raw of text.split(";")) {
    const clause = raw.trim();
    // Ändringar i en annan författning ("ändr. 7 kap. 3 d § i 2026:1221") och övergångsbestämmelser hör inte hit.
    if (/\bi\s+\d{4}:\d+/.test(clause) || /övergångsbest|ikrafttr/i.test(clause)) continue;
    for (const part of splitClauses(clause)) {
      const rename = part.match(/^nuvarande\s+(.+?)\s+betecknas\s+(.+)$/i);
      if (rename) {
        const from = parseLagrumList(rename[1]!).filter((l) => l.paragraph !== "*");
        const to = parseLagrumList(rename[2]!).filter((l) => l.paragraph !== "*");
        from.forEach((f, i) => to[i] && ops.renamed.push({ from: f, to: to[i]! }));
        continue;
      }
      if (/^rubr/i.test(part)) continue;
      const kind = part.match(/^(ändr|nya?|upph|ändras|införs)\.?\s+(.*)$/i);
      if (!kind) continue;
      const list = parseLagrumList(kind[2]!);
      const k = kind[1]!.toLowerCase();
      if (k.startsWith("ändr")) ops.changed.push(...list);
      else if (k.startsWith("upph")) ops.repealed.push(...list);
      else ops.added.push(...list);
    }
  }
  return ops;
}

/** "nuvarande … betecknas …, rubr. närmast före … ; nya …" – delar vid komma före nytt nyckelord. */
function splitClauses(clause: string): string[] {
  return clause
    .split(/,\s*(?=(?:nuvarande|rubr|ändr|nya?|upph)\b)/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

const contains = (list: Lagrum[], l: Lagrum) => list.some((x) => same(x, l) || (x.paragraph === "*" && x.chapter === l.chapter));

/* ─── Historik ────────────────────────────────────────────────────────── */

export interface Amendment {
  /** "SFS 2010:533" */
  sfs: string;
  /** Förarbeten enligt lagen.nu, t.ex. ["Prop. 2009/10:190", "Bet. …", "Rskr. …"]. */
  forarbeten: string[];
  andrar: string | null;
  ikraft: string | null;
}

export type HistoryKind = "ursprunglig" | "införd" | "ändrad" | "ny beteckning";

export interface ProvisionHistoryEntry {
  sfs: string;
  kind: HistoryKind;
  /** Bestämmelsens beteckning efter ändringen. */
  label: string;
  /** Vid ny beteckning: beteckningen före ändringen. */
  previous: string | null;
  /** Propositionen bakom ändringen ("Prop. 2009/10:190"), om någon. */
  prop: string | null;
  ikraft: string | null;
}

function sfsKey(sfs: string): number {
  const m = sfs.match(/(\d{4}):(\d+)/);
  return m ? Number(m[1]) * 100000 + Number(m[2]) : 0;
}

/**
 * Bestämmelsens historia, nyast först. `baseSfs` är lagens egen beteckning ("SFS 2005:716").
 * `latestHint` är ändringsförfattningen som lagtexten anger efter paragrafen ("Lag (2021:765)"),
 * och tas med om metadatan inte nämner bestämmelsen.
 */
export function provisionHistory(target: Lagrum, amendments: Amendment[], baseSfs: string, latestHint?: string | null): ProvisionHistoryEntry[] {
  const sorted = [...amendments].sort((a, b) => sfsKey(b.sfs) - sfsKey(a.sfs));
  const out: ProvisionHistoryEntry[] = [];
  let cur = target;
  const propOf = (a: Amendment) => a.forarbeten.find((f) => /^prop\./i.test(f)) ?? null;
  const hint = latestHint ? `SFS ${latestHint.replace(/^SFS\s*/, "")}` : null;

  for (const a of sorted) {
    if (sfsKey(a.sfs) === sfsKey(baseSfs)) {
      out.push({ sfs: a.sfs, kind: "ursprunglig", label: lagrumLabel(cur), previous: null, prop: propOf(a), ikraft: a.ikraft });
      return out;
    }
    const ops = parseAndrar(a.andrar);
    const rename = ops.renamed.find((r) => same(r.to, cur));
    if (rename) {
      out.push({ sfs: a.sfs, kind: "ny beteckning", label: lagrumLabel(cur), previous: lagrumLabel(rename.from), prop: propOf(a), ikraft: a.ikraft });
      cur = rename.from;
      continue;
    }
    if (contains(ops.added, cur)) {
      out.push({ sfs: a.sfs, kind: "införd", label: lagrumLabel(cur), previous: null, prop: propOf(a), ikraft: a.ikraft });
      return out;
    }
    if (contains(ops.changed, cur) || (hint && sfsKey(hint) === sfsKey(a.sfs) && out.length === 0)) {
      out.push({ sfs: a.sfs, kind: "ändrad", label: lagrumLabel(cur), previous: null, prop: propOf(a), ikraft: a.ikraft });
    }
  }
  return out;
}

/** "Prop. 2004/05:170" → "https://lagen.nu/prop/2004/05:170" (även SOU och Ds). */
export function forarbeteUri(identifier: string): string | null {
  const m = identifier.trim().match(/^(prop|sou|ds)\.?\s+(\d{4}(?:\/\d{2,4})?:\d+)/i);
  return m ? `https://lagen.nu/${m[1]!.toLowerCase()}/${m[2]}` : null;
}

/* ─── Specialkommentar i en proposition ───────────────────────────────── */

export interface Commentary {
  /** Avsnittets rubrik, t.ex. "13.1 Förslaget till lag om ändring i utlänningslagen (2005:716)". */
  section: string;
  /** Bestämmelsens rubrikrad i kommentaren, t.ex. "3 § Uppehållstillstånd på grund av anknytning". */
  heading: string;
  markdown: string;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const stripMd = (s: string) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]/g, "")
    .trim();

/** Numrerad avsnittsrubrik ("13", "13.1", "24.4") som inte är ett lagrum. */
function sectionDepth(text: string): number | null {
  const m = text.match(/^(\d{1,2}(?:\.\d{1,2}){0,3})\s+(?!kap\.)[A-ZÅÄÖ]/);
  return m ? m[1]!.split(".").length : null;
}

const KOMMENTAR = /författningskommentar|specialmotivering/i;

/** Rad som inleder kommentaren till en eller flera paragrafer: "**3 § Rubrik**", "#### 1–3 §§", "**13 och 14 §§**". */
function provisionLine(line: string): { chapter: string | null; paragraphs: string[]; text: string; rest: string | null } | null {
  const h = line.match(HEADING);
  const bold = line.match(/^\*\*(.+?)\*\*\s*$/);
  const marked = h ? stripMd(h[2]!) : bold ? stripMd(bold[1]!) : null;
  const list = String.raw`^(?:(${NUM_TOKEN})\s*kap\.?\s+)?(${NUM_TOKEN}(?:\s*(?:,|och|–|-)\s*${NUM_TOKEN})*)\s*§§?`;
  let m: RegExpMatchArray | null;
  let raw: string;
  let rest: string | null = null;
  if (marked) {
    raw = marked;
    m = raw.match(new RegExp(`${list}(?:\\s|$)`));
  } else {
    // Äldre propositioner: "1 § Ändringen är föranledd av …" på en vanlig rad.
    raw = stripMd(line);
    m = raw.match(new RegExp(`${list}\\s+(?=[A-ZÅÄÖ])`));
    if (m) rest = raw.slice(m[0].length);
  }
  if (!m) return null;
  const paragraphs: string[] = [];
  const parts = m[2]!.split(/\s*(,|och|–|-)\s*/);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "," || p === "och") continue;
    if (p === "–" || p === "-") {
      const from = paragraphs.pop();
      const to = parts[++i];
      if (from && to) paragraphs.push(...expandRange(from, normNum(to)));
      continue;
    }
    paragraphs.push(normNum(p));
  }
  return { chapter: m[1] ? normNum(m[1]) : null, paragraphs, text: rest != null ? m[0].trim() : raw, rest };
}

/** "**5 kap. Uppehållstillstånd**" eller "## 12 kap. Verkställighet" (utan §). */
function chapterLine(line: string): string | null {
  const h = line.match(HEADING);
  const bold = line.match(/^\*\*(.+?)\*\*\s*$/);
  const raw = h ? stripMd(h[2]!) : bold ? stripMd(bold[1]!) : null;
  const m = raw?.match(new RegExp(String.raw`^(${NUM_TOKEN})\s*kap\.?(?:\s|$)(?!.*§)`));
  return m ? normNum(m[1]!) : null;
}

/**
 * Letar upp författningskommentaren till en bestämmelse i en propositions markdown.
 * `law` identifierar lagen i rubriken "Förslaget till …" – SFS-nummer ("2005:716") och/eller
 * namn ("utlänningslag"). Flera träffar (t.ex. två lagförslag om samma lag) returneras alla.
 */
export function findCommentary(md: string, law: { sfs: string | null; name: string | null }, target: Lagrum): Commentary[] {
  const lines = md.split("\n");
  const out: Commentary[] = [];

  // 1. Kommentaravsnittet(n).
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i]!.match(HEADING);
    if (!h || !KOMMENTAR.test(h[2]!)) continue;
    const depth = sectionDepth(stripMd(h[2]!)) ?? 1;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const hj = lines[j]!.match(HEADING);
      if (!hj) continue;
      const d = sectionDepth(stripMd(hj[2]!));
      if ((d != null && d <= depth) || /^(bilaga|utdrag ur protokoll|lagrådets yttrande|sammanfattning)/i.test(stripMd(hj[2]!))) {
        end = j;
        break;
      }
    }
    scanKommentar(lines, i + 1, end, depth, law, target, out);
    i = end - 1;
  }
  return out;
}

function scanKommentar(lines: string[], from: number, to: number, depth: number, law: { sfs: string | null; name: string | null }, target: Lagrum, out: Commentary[]) {
  // 2. Delavsnitt per lagförslag ("13.1 Förslaget till lag om ändring i utlänningslagen (2005:716)").
  const subs: { start: number; title: string }[] = [];
  for (let i = from; i < to; i++) {
    const h = lines[i]!.match(HEADING);
    if (!h) continue;
    const t = stripMd(h[2]!);
    const d = sectionDepth(t);
    if (d === depth + 1 || /^förslaget till/i.test(t.replace(/^\d+(\.\d+)*\s+/, ""))) subs.push({ start: i, title: t });
  }
  const matchesLaw = (title: string) => {
    const t = title.toLowerCase();
    // "lag om ändring i lagen (2026:000) om ändring i utlänningslagen" gäller en ändringslag, inte lagen själv.
    if (/om ändring i lagen \(\d{4}:\d+\) om ändring i/.test(t)) return false;
    return (!!law.sfs && t.includes(law.sfs)) || (!!law.name && t.includes(law.name.toLowerCase()));
  };
  const ranges =
    subs.length > 0
      ? subs.map((s, k) => ({ start: s.start + 1, end: subs[k + 1]?.start ?? to, title: s.title })).filter((r) => matchesLaw(r.title))
      : [{ start: from, end: to, title: "" }];
  // Ett enda lagförslag i propositionen: rubriken nämner ibland inte lagen exakt.
  const use = ranges.length > 0 ? ranges : subs.length === 1 ? [{ start: subs[0]!.start + 1, end: to, title: subs[0]!.title }] : [];

  for (const r of use) {
    let chapter: string | null = null;
    let collecting: { heading: string; buf: string[] } | null = null;
    const flush = () => {
      if (collecting) {
        const text = collecting.buf.join("\n").trim();
        if (text) out.push({ section: r.title, heading: collecting.heading, markdown: text });
      }
      collecting = null;
    };
    for (let i = r.start; i < r.end; i++) {
      const line = lines[i]!;
      const ch = chapterLine(line);
      if (ch) {
        flush();
        chapter = ch;
        continue;
      }
      const p = provisionLine(line);
      if (p) {
        flush();
        const c = p.chapter ?? chapter;
        if ((c ?? null) === (target.chapter ?? null) || (!target.chapter && !c)) {
          if (p.paragraphs.includes(target.paragraph)) collecting = { heading: p.text, buf: p.rest ? [p.rest] : [] };
        }
        continue;
      }
      // Annan rubrik (t.ex. en mellanrubrik före nästa paragraf) avslutar kommentaren.
      if (HEADING.test(line)) {
        flush();
        continue;
      }
      if (collecting) (collecting as { buf: string[] }).buf.push(line);
    }
    flush();
  }
}

/** Lagens namn som det står i propositionsrubriker: "Utlänningslag (2005:716)" → "utlänningslag". */
export function lawNameForMatch(title: string | null | undefined): string | null {
  if (!title) return null;
  const m = title.match(/^([A-Za-zÅÄÖåäö-]+(?:lag|balk|förordning|ordning|form))\b/i);
  if (m) return m[1]!.toLowerCase();
  const om = title.match(/^Lag \(\d{4}:\d+\) (om .+)$/i);
  return om ? om[1]!.toLowerCase() : null;
}

/* ─── API-svar (Worker → klient) ──────────────────────────────────────── */

export interface ProvisionForarbeten {
  /** Lagens uri på lagen.nu, utan fragment. */
  lawUri: string;
  lawTitle: string | null;
  lawSfs: string | null;
  /** Bestämmelsen idag, t.ex. "7 kap. 18 §". */
  lagrum: string;
  /** Nyast först. */
  history: (ProvisionHistoryEntry & { propUri: string | null })[];
}

export interface ProvisionCommentary {
  prop: string;
  propUri: string;
  propTitle: string | null;
  /** Beteckningen som kommentaren hittades under (kan vara en äldre beteckning). */
  lagrum: string | null;
  found: Commentary[];
}
