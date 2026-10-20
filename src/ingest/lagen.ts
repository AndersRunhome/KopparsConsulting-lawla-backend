/**
 * Ingest från lagen.nu (öppet API, ingen nyckel): GET /api/v1/document?uri=…&format=md.
 * Lagar chunkas per paragraf med kapitel som förälder; förarbeten och rättsfall efter rubriker.
 */
import { parseLagenMarkdown } from "../../shared/sourceDoc.js";
import { chunkBlocks, type ChunkDraft } from "./chunker.js";
import type { DocumentDraft } from "./store.js";

export interface LagenMarkdownDocument {
  uri: string;
  source?: string | null;
  kind?: string | null;
  label?: string | null;
  title?: string | null;
  source_url?: string | null;
  markdown?: string;
}

export const USER_AGENT = "Lawla-backend/0.1 (+https://lawla.kopparsconsulting.com)";

export async function fetchLagenMarkdown(baseUrl: string, uri: string): Promise<LagenMarkdownDocument> {
  const url = new URL("/api/v1/document", baseUrl);
  url.searchParams.set("uri", uri.split("#")[0]!);
  url.searchParams.set("format", "md");
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`lagen.nu svarade ${res.status} för ${uri}`);
  return (await res.json()) as LagenMarkdownDocument;
}

/** lagen.nu:s "kind"/"source" → Lawlas dokumenttyp och kanoniskt id. */
export function classifyLagenDocument(doc: LagenMarkdownDocument): { documentType: string; canonicalId: string | null } {
  const uri = doc.uri.replace(/^https?:\/\/lagen\.nu\//, "");
  const label = (doc.label ?? "").trim();
  const kind = (doc.kind ?? "").toLowerCase();
  if (/^\d{4}:\d+$/.test(uri)) {
    const isForordning = /förordning/i.test(doc.title ?? "") || kind.includes("förordning");
    return { documentType: isForordning ? "forordning" : "lag", canonicalId: `sfs:${uri}` };
  }
  let m = label.match(/^Prop\.?\s*(\d{4}\/\d{2,4}:\d+)/i) ?? uri.match(/^prop\/(\d{4}\/\d{2,4}:\d+)/);
  if (m) return { documentType: "proposition", canonicalId: `prop:${m[1]}` };
  m = label.match(/^SOU\s*(\d{4}:\d+)/i) ?? uri.match(/^sou\/(\d{4}:\d+)/);
  if (m) return { documentType: "sou", canonicalId: `sou:${m[1]}` };
  m = label.match(/^Ds\s*(\d{4}:\d+)/i) ?? uri.match(/^ds\/(\d{4}:\d+)/);
  if (m) return { documentType: "ds", canonicalId: `ds:${m[1]}` };
  m = label.match(/^NJA\s+(\d{4})\s+s\.?\s*(\d+)/i);
  if (m) return { documentType: "rattsfall", canonicalId: `nja:${m[1]}:${m[2]}` };
  m = label.match(/^(RH|MIG|AD|MÖD|HFD|RÅ)\s+(\d{4})\s*(?:ref\.?\s*)?:?\s*(\d+)/i);
  if (m) return { documentType: "rattsfall", canonicalId: `${m[1]!.toLowerCase().replace("ö", "o").replace("å", "a")}:${m[2]}:${m[3]}` };
  if (kind.includes("rättsfall") || doc.source === "dv") return { documentType: "rattsfall", canonicalId: null };
  return { documentType: "ovrigt", canonicalId: null };
}

export function lagenToDrafts(doc: LagenMarkdownDocument): { document: DocumentDraft; chunks: ChunkDraft[] } {
  const md = doc.markdown ?? "";
  const title = (doc.title ?? doc.label ?? doc.uri).trim();
  const { documentType, canonicalId } = classifyLagenDocument(doc);
  const blocks = parseLagenMarkdown(md, doc.uri);
  const chunks = chunkBlocks(blocks, { title });
  if (documentType === "proposition" || documentType === "sou" || documentType === "ds") markCommentary(chunks);
  const upphavd = /upphävd|upphört att gälla/i.test(md.slice(0, 2000)) && /^(#\s.*\n)?\s*(\*\*)?upphävd/i.test(md.slice(0, 200));
  return {
    document: {
      title,
      source: "lagen.nu",
      sourceUrl: doc.uri,
      sourceType: doc.source ?? null,
      documentType,
      canonicalId,
      identifier: doc.label ?? null,
      status: upphavd ? "upphavd" : "gallande",
      metadata: { kind: doc.kind ?? null, officialSource: doc.source_url ?? null },
      raw: md,
    },
    chunks,
  };
}

/** I förarbeten: chunkar under rubriken "Författningskommentar"/"Specialmotivering" blir `kommentar`. */
function markCommentary(chunks: ChunkDraft[]): void {
  for (const c of chunks) {
    if (c.kind !== "avsnitt" && c.kind !== "paragraf") continue;
    if (c.path.some((p) => /författningskommentar|specialmotivering/i.test(p))) c.kind = "kommentar";
  }
}
