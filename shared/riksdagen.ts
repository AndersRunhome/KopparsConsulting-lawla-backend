/**
 * Förarbeten från riksdagen.se (Riksdagens öppna data, data.riksdagen.se).
 *
 * Dokumenten är PDF-konverterad HTML (ett <P> per textrad/stycke, sidor som <div id="page_N">).
 * De görs här om till samma markdown-form som lagen.nu använder – numrerade rubriker som
 * "##", kapitel/paragrafrubriker i fetstil – så att arbetsytan och sökningen efter
 * författningskommentarer fungerar likadant för båda källorna.
 */

export type ForarbeteTyp = "prop" | "sou" | "bet" | "ds";

export const FORARBETE_TYPER: { typ: ForarbeteTyp; label: string; example: string; prefix: string }[] = [
  { typ: "prop", label: "Proposition", example: "2004/05:170", prefix: "Prop." },
  { typ: "sou", label: "SOU", example: "2004:74", prefix: "SOU" },
  { typ: "bet", label: "Betänkande", example: "2004/05:SfU17", prefix: "Bet." },
  { typ: "ds", label: "Ds", example: "2019:1", prefix: "Ds" },
];

/** "2004/05:170" → { rm: "2004/05", bet: "170" }. Accepterar även "prop. 2004/05:170". */
export function parseBeteckning(input: string): { rm: string; bet: string } | null {
  const m = input
    .trim()
    .replace(/^(prop|sou|ds|bet)\.?\s*/i, "")
    .match(/^(\d{4}(?:\/\d{2,4})?)\s*:\s*([A-Za-zÅÄÖåäö]{0,6}\d{1,4}[a-z]?)$/);
  return m ? { rm: m[1]!, bet: m[2]! } : null;
}

/** Riksdagens dokument-id ur en adress, t.ex. …/proposition/ny-instans-och-processordning_gs03170/ → "GS03170". */
export function riksdagenIdFromUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)riksdagen\.se$/.test(u.hostname)) return null;
  const path = u.pathname.replace(/\/+$/, "");
  const data = path.match(/\/dokument(?:status)?\/([A-Za-z0-9]{4,20})(?:\.(?:html|text|json|xml))?$/);
  if (data && u.hostname.startsWith("data.")) return data[1]!.toUpperCase();
  const last = path.split("/").pop() ?? "";
  const m = last.match(/_([A-Za-z0-9]{4,20})$/) ?? last.match(/^([A-Za-z]{1,4}\d{2,}[A-Za-z0-9]*)$/);
  return m ? m[1]!.toUpperCase() : null;
}

export const isRiksdagenId = (id: string) => /^[A-Z0-9]{4,20}$/.test(id);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", shy: "" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** PDF-konverterad HTML → textrader i läsordning (sidhuvuden och sidnummer bortrensade). */
export function htmlToLines(html: string, identifier: string | null): string[] {
  const body = html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "");
  const blocks = body.split(/<\/(?:p|h[1-6]|li|tr|div)>|<br\s*\/?>/i);
  const header = identifier ? identifier.replace(/\s+/g, " ").toLowerCase() : null;
  const out: string[] = [];
  for (const b of blocks) {
    const text = decodeEntities(b.replace(/<[^>]+>/g, " "))
      .replace(/[\u00a0\s]+/g, " ")
      .trim();
    if (!text) continue;
    if (/^\d{1,4}$/.test(text)) continue; // sidnummer
    const lower = text.toLowerCase();
    if (header && (lower === header || (lower.startsWith(header) && text.length < header.length + 14))) continue; // sidhuvud
    out.push(text);
  }
  return out;
}

const HEADING_NUM = /^(\d{1,2}(?:\.\d{1,2}){0,3})\s+([A-ZÅÄÖ].{1,150})$/;

/** Textrader → markdown med rubriker och stycken. Avstavade/brutna rader slås ihop. */
export function linesToMarkdown(lines: string[], title: string | null): string {
  const out: string[] = title ? [`# ${title}`, ""] : [];
  let para = "";
  const flush = () => {
    if (para) out.push(para, "");
    para = "";
  };
  for (const line of lines) {
    const h = line.match(HEADING_NUM);
    if (h && !/[.,;:]$/.test(line) && line.length < 160) {
      flush();
      const depth = h[1]!.split(".").length;
      out.push(`${"#".repeat(Math.min(6, depth + 1))} ${line}`, "");
      continue;
    }
    if (/^\d{1,3}\s?[a-z]?\s*kap\.\s*[A-ZÅÄÖ]?[^§]{0,120}$/.test(line) && !/[.,;]$/.test(line.replace(/kap\.$/, "kap"))) {
      flush();
      out.push(`**${line}**`, "");
      continue;
    }
    if (/^\d{1,3}\s?[a-z]?\s*§§?(\s|$)/.test(line) && line.length < 120 && !/[.;]$/.test(line)) {
      flush();
      out.push(`**${line}**`, "");
      continue;
    }
    if (!para) para = line;
    else if (/-$/.test(para) && /^[a-zåäö]/.test(line)) para = para.slice(0, -1) + line;
    else if (!/[.:;!?)”"]$/.test(para) && /^[a-zåäö(0-9]/.test(line)) para += ` ${line}`;
    else {
      flush();
      para = line;
    }
  }
  flush();
  return out.join("\n").trim();
}
