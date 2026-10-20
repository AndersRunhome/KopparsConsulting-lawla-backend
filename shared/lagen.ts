/**
 * Kontroll mot lagen.nu (https://lagen.nu/api/v1, öppet API utan nyckel).
 *
 * Används när en hänvisning i en analys inte finns i utredningens underlag: Workern
 * frågar lagen.nu om hänvisningen finns (verifiering) och hämtar textstället, så att
 * juristen kan lägga till det som rättskälla (komplettering). Typerna delas av Workern
 * (worker/lagen.ts) och klienten.
 */

/**
 * - `found`   – lagen.nu hittar dokumentet (och i förekommande fall paragrafen).
 * - `invalid` – lagen.nu känner igen formen men har fastställt att källan inte finns
 *               (t.ex. en paragraf som inte finns i lagen) – trolig felaktig hänvisning.
 * - `unknown` – lagen.nu kunde inte tolka hänvisningen (t.ex. "36 § lagen" utan lagnamn).
 * - `error`   – lagen.nu svarade inte; försök igen senare.
 */
export type LagenStatus = "found" | "invalid" | "unknown" | "error";

export interface LagenResolution {
  /** Hänvisningen som den skickades in. */
  query: string;
  status: LagenStatus;
  /** lagen.nu-URI, med fragment om lagen.nu pekar ut ett textställe (t.ex. …/1915:218#P36). */
  uri: string | null;
  /** Länk för att öppna källan på lagen.nu (samma som uri). */
  url: string | null;
  /** T.ex. "SFS 1915:218", "NJA 2015 s. 899", "Prop. 2016/17:180". */
  identifier: string | null;
  title: string | null;
  /** lagen.nu:s typ, t.ex. "Lag", "Rättsfall", "Proposition". */
  kindLabel: string | null;
  /** lagen.nu:s källa: "sfs", "dv", "forarbete", "eurlex" … */
  source: string | null;
  /** Utpekat textställe, t.ex. "36 §" eller "12 kap. 3 §". */
  pinLabel: string | null;
  /** Kort utdrag ur textstället. */
  excerpt: string | null;
}

export interface LagenText {
  uri: string;
  title: string | null;
  identifier: string | null;
  pinLabel: string | null;
  /** Textstället (eller dokumentets början) som markdown. */
  markdown: string;
  truncated: boolean;
  /** Officiell källa enligt lagen.nu, t.ex. Regeringskansliets rättsdatabas. */
  sourceUrl: string | null;
}

/** Hela dokumentet för arbetsytan (lagar kan vara över 500 000 tecken). */
export interface LagenDocument {
  uri: string;
  title: string | null;
  identifier: string | null;
  /** lagen.nu:s typ: "lag", "prop", "sou", "case" … */
  kind: string | null;
  source: string | null;
  markdown: string;
  truncated: boolean;
  sourceUrl: string | null;
}

export interface LagenSearchHit {
  uri: string;
  url: string;
  identifier: string | null;
  title: string | null;
  kindLabel: string | null;
  excerpt: string | null;
}

export interface LagenSearchResult {
  query: string;
  total: number;
  results: LagenSearchHit[];
}

export const LAGEN_BASE = "https://lagen.nu";
/** Max antal hänvisningar per verifieringsanrop. */
export const LAGEN_VERIFY_MAX = 40;
/** Max längd på en hänvisning eller sökfråga. */
export const LAGEN_QUERY_MAX = 300;
/** Längsta text som hämtas för ett textställe (tecken). Längre dokument kortas. */
export const LAGEN_TEXT_MAX = 12_000;
/** Längsta dokument som hämtas till arbetsytan (tecken). */
export const LAGEN_DOC_MAX = 3_000_000;

/** Bara riktiga lagen.nu-adresser accepteras som uri. */
export function isLagenUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" && u.hostname === "lagen.nu" && !u.username && !u.password && !u.port;
  } catch {
    return false;
  }
}

/** Etikett för en källa som läggs till från lagen.nu, så att hänvisningen i analysen matchar den. */
export function lagenEvidenceLabel(citation: string, r: Pick<LagenResolution, "identifier" | "title">): string {
  const doc = r.title && r.identifier && !r.title.includes(r.identifier.replace(/^SFS\s+/, "")) ? `${r.title} (${r.identifier})` : r.title || r.identifier;
  return doc && doc !== citation ? `${citation} – ${doc}` : citation;
}

/** Tar bort markdown-länkar och fetstil så att texten kan sparas som rent textställe. */
export function lagenPlainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
