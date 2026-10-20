/**
 * Hänvisningar i svensk juridisk text → kanonisk form. Används vid ingest (referensgrafen),
 * vid frågeförståelse (exakt uppslag) och för att kontrollera citeringar i analyser.
 *
 * Kanoniska former:
 *   lagrum     sfs:2005:716#K5P16c   (lag känd via SFS-nummer eller förkortning/namn → sfs; annars law:<namn>#…)
 *   rättsfall  nja:2015:899 · rh:2012:34 · hfd:2016:ref:21 · mig:2017:3 · ad:2019:12 · mod:2020:5
 *   förarbete  prop:2005/06:77 · sou:2020:54 · ds:2019:7 · bet:2005/06:SfU9
 */

export type ReferenceType = "lagrum" | "rattsfall" | "forarbete";

export interface Reference {
  type: ReferenceType;
  text: string;
  canonical: string;
  start: number;
  end: number;
  /** För lagrum: kapitel/paragraf och lagens benämning som den stod i texten. */
  lagrum?: { chapter: string | null; paragraph: string; law: string | null; anchor: string; /** Hänvisning utan lagnamn, tolkad som det egna dokumentet. */ internal: boolean };
}

/** Vedertagna förkortningar → SFS-nummer. Kompletteras med korpusens egna titlar vid uppslag. */
export const LAW_SFS: Record<string, string> = {
  UtlL: "2005:716",
  AvtL: "1915:218",
  ÄktB: "1987:230",
  FB: "1949:381",
  ÄB: "1958:637",
  JB: "1970:994",
  BrB: "1962:700",
  RB: "1942:740",
  MB: "1998:808",
  UB: "1981:774",
  SamboL: "2003:376",
  KöpL: "1990:931",
  KKL: "2022:260",
  KtjL: "1985:716",
  SkL: "1972:207",
  ABL: "2005:551",
  LAS: "1982:80",
  MBL: "1976:580",
  DL: "2008:567",
  SoL: "2001:453",
  LSS: "1993:387",
  IL: "1999:1229",
  OSL: "2009:400",
  FL: "2017:900",
  FPL: "1971:291",
  HSL: "2017:30",
  PBL: "2010:900",
  RF: "1974:152",
  TF: "1949:105",
  YGL: "1991:1469",
};

export const LAW_NAMES: Record<string, string> = {
  utlänningslagen: "2005:716",
  avtalslagen: "1915:218",
  äktenskapsbalken: "1987:230",
  föräldrabalken: "1949:381",
  ärvdabalken: "1958:637",
  jordabalken: "1970:994",
  brottsbalken: "1962:700",
  rättegångsbalken: "1942:740",
  miljöbalken: "1998:808",
  socialtjänstlagen: "2001:453",
  förvaltningslagen: "2017:900",
  regeringsformen: "1974:152",
};

const LAW_WORD = String.raw`(?:\(?(\d{4}:\d{1,5})\)?|([A-ZÅÄÖ][A-Za-zÅÄÖåäö]*[A-ZÅÄÖ][A-Za-zÅÄÖåäö]*)|([a-zåäö]+(?:lagen|balken|förordningen|formen)))`;
const PAR = String.raw`(\d{1,3}(?:\s?[a-z])?)`;

/** Paragraflista: "2 §", "2, 3 eller 4 §§", "16 a–16 c §§". */
const PAR_LIST = String.raw`(\d{1,3}(?:\s?[a-z])?(?:\s*(?:,|och|eller|–|-)\s*\d{1,3}(?:\s?[a-z])?)*)`;
const LAGRUM_KAP = new RegExp(String.raw`\b(\d{1,3}(?:\s?[a-z])?)\s*kap\.?\s*${PAR_LIST}\s*§§?(?:\s+(?:i\s+)?${LAW_WORD})?`, "g");
const LAGRUM_PAR = new RegExp(String.raw`(?<![\d:])\b${PAR_LIST}\s*§§?\s+(?:i\s+)?${LAW_WORD}`, "g");
/** Bara "1 §" / "17–17 b §§" utan lag – intern hänvisning i det egna dokumentet. */
const LAGRUM_BARE = new RegExp(String.raw`(?<![\d:])\b${PAR_LIST}\s*§§?(?!\s+(?:i\s+)?${LAW_WORD})`, "g");
const RATTSFALL = /\b(NJA)\s+(\d{4})\s+s\.?\s*(\d+)|\b(RH|MIG|AD|MÖD|MOD|RÅ|HFD)\s+(\d{4})\s*(?:ref\.?\s*)?(?::|not\.?\s*)?\s*(\d+)/g;
const FORARBETE = /\b(?:(Prop\.?|Proposition)\s*(\d{4}\/\d{2,4}:\d{1,4})|(SOU)\s*(\d{4}:\d{1,4})|(Ds)\s*(\d{4}:\d{1,4})|(Bet\.?|Betänkande)\s*(\d{4}\/\d{2,4}:[A-Za-zÅÄÖ]+\d+))/gi;

function lawToSfs(sfs: string | undefined, abbr: string | undefined, name: string | undefined): { sfs: string | null; law: string | null } {
  if (sfs) return { sfs, law: sfs };
  if (abbr) return { sfs: LAW_SFS[abbr] ?? null, law: abbr };
  if (name) return { sfs: LAW_NAMES[name.toLowerCase()] ?? null, law: name };
  return { sfs: null, law: null };
}

/** "2, 3 eller 4" → ["2","3","4"]; "16 a–16 c" → ["16 a","16 c"] (ändpunkterna; intervallet fylls vid uppslag). */
export function splitParagraphList(list: string): string[] {
  return list.split(/\s*(?:,|och|eller|–|-)\s*/).map((p) => p.trim().replace(/\s+/g, " ")).filter(Boolean);
}

export function lagrumAnchor(chapter: string | null, paragraph: string): string {
  const p = paragraph.replace(/\s+/g, "");
  return `${chapter ? `K${chapter.replace(/\s+/g, "")}` : ""}P${p}`;
}

/** Hittar alla hänvisningar i en text. Överlappande träffar avgörs till den längsta. */
export function extractReferences(text: string, defaultSfs: string | null = null, defaultChapter: string | null = null): Reference[] {
  const found: Reference[] = [];
  const push = (r: Reference) => found.push(r);

  const pushLagrum = (m: RegExpMatchArray, chapter: string | null, list: string, lawSfs: string | null, law: string | null, internal: boolean) => {
    const base = lawSfs ?? (law ? null : defaultSfs);
    for (const paragraph of splitParagraphList(list)) {
      const anchor = lagrumAnchor(chapter, paragraph);
      push({
        type: "lagrum",
        text: m[0],
        canonical: base ? `sfs:${base}#${anchor}` : `law:${(law ?? "?").toLowerCase()}#${anchor}`,
        start: m.index!,
        end: m.index! + m[0].length,
        lagrum: { chapter, paragraph, law, anchor, internal },
      });
    }
  };
  for (const m of text.matchAll(LAGRUM_KAP)) {
    const { sfs, law } = lawToSfs(m[3], m[4], m[5]);
    pushLagrum(m, m[1]!.replace(/\s+/g, " "), m[2]!, sfs, law, !sfs && !law);
  }
  for (const m of text.matchAll(LAGRUM_PAR)) {
    const { sfs, law } = lawToSfs(m[2], m[3], m[4]);
    pushLagrum(m, null, m[1]!, sfs, law, false);
  }
  if (defaultSfs) {
    for (const m of text.matchAll(LAGRUM_BARE)) pushLagrum(m, defaultChapter, m[1]!, defaultSfs, null, true);
  }
  for (const m of text.matchAll(RATTSFALL)) {
    const canonical = m[1]
      ? `nja:${m[2]}:${m[3]}`
      : `${m[4]!.toLowerCase().replace("ö", "o").replace("å", "a")}:${m[5]}:${m[6]}`;
    push({ type: "rattsfall", text: m[0], canonical, start: m.index!, end: m.index! + m[0].length });
  }
  for (const m of text.matchAll(FORARBETE)) {
    const canonical = m[2] ? `prop:${m[2]}` : m[4] ? `sou:${m[4]}` : m[6] ? `ds:${m[6]}` : `bet:${m[8]}`;
    push({ type: "forarbete", text: m[0], canonical, start: m.index!, end: m.index! + m[0].length });
  }

  // Ta bort överlapp (kapitelformen vinner över paragrafformen).
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Reference[] = [];
  let lastEnd = -1;
  let lastStart = -1;
  for (const r of found) {
    if (r.start < lastEnd && !(r.start === lastStart && r.end === lastEnd)) continue;
    out.push(r);
    lastStart = r.start;
    lastEnd = r.end;
  }
  return out;
}

/** Tolkar en fristående hänvisning ("5 kap. 16 c § UtlL", "NJA 2015 s. 899", "prop. 2005/06:77"). */
export function parseReference(q: string, defaultSfs: string | null = null): Reference | null {
  const refs = extractReferences(q.trim(), defaultSfs);
  return refs[0] ?? null;
}
