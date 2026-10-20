/**
 * Analysmotorn: bygger underlag (ärendets rättskällor + hybridsök i korpusen), promptar modellen
 * att citera med chunk-id och ger tillbaka text + strukturerade citeringar som kontrollerats mot
 * underlaget. Se docs/ARCHITECTURE.md §7.
 */
import type { Db } from "../db/db.js";
import type { Embedder } from "../providers/embeddings.js";
import type { Reranker } from "../providers/rerank.js";
import type { Llm } from "../providers/llm.js";
import { hybridSearch, type SearchHit } from "../search/hybrid.js";
import { extractReferences } from "../documents/citations.js";
import { resolveTarget } from "../ingest/store.js";
import type { ExpandedEvidenceDto, ProjectDetailDto } from "../projects/repo.js";

export interface ContextSource {
  key: string; // k<chunkId> eller e<evidenceId>
  chunkId: number | null;
  evidenceId: number | null;
  documentId: number | null;
  documentTitle: string | null;
  label: string | null;
  canonical: string | null;
  content: string;
}

export interface Citation {
  text: string;
  chunkId: number | null;
  evidenceId: number | null;
  canonical: string | null;
  start: number;
  end: number;
  /** ok = finns i underlaget; corpus = finns i korpusen men inte i underlaget; missing = okänd (möjlig fabrikation). */
  status: "ok" | "corpus" | "missing";
}

export const SYSTEM_PROMPT = `Du är Lawla, en juridisk assistent för svenska jurister. Du skriver rättsutredningar på korrekt juridisk svenska.
Regler:
- Grunda varje påstående om gällande rätt på underlaget. Varje gång du stödjer dig på en källa skriver du dess nyckel inom dubbla hakparenteser direkt efter, t.ex. "… (5 kap. 16 c § UtlL [[k123]])". Använd bara nycklar som finns i underlaget.
- Hänvisa till lagrum, rättsfall och förarbeten med vedertagen form (t.ex. "5 kap. 16 c § UtlL", "MIG 2017:3", "prop. 2005/06:77").
- Hitta aldrig på källor. Saknas stöd i underlaget: säg det uttryckligen under rubriken "Osäkerheter" och ange vilken typ av källa som skulle behövas.
- Skriv i markdown med rubrikerna Sammanfattning, Rättslig analys, Bedömning, Osäkerheter.`;

/** Samlar underlag: ärendets rättskällor först, sedan sökträffar i korpusen per fråga. */
export async function gatherContext(db: Db, embedder: Embedder, reranker: Reranker, evidence: ExpandedEvidenceDto[], queries: string[], perQuery = 6): Promise<ContextSource[]> {
  const out = new Map<string, ContextSource>();
  for (const e of evidence) {
    if (!e.content?.trim()) continue;
    const key = e.chunkId ? `k${e.chunkId}` : `e${e.id}`;
    out.set(key, { key, chunkId: e.chunkId, evidenceId: e.id, documentId: e.documentId, documentTitle: e.documentTitle, label: e.displayLabel, canonical: e.canonicalReference, content: e.content });
  }
  for (const q of queries) {
    if (!q.trim()) continue;
    const r = await hybridSearch(db, embedder, reranker, q, { topK: perQuery, onlyCurrent: true });
    for (const h of r.hits) addHit(out, h);
  }
  return [...out.values()];
}

function addHit(out: Map<string, ContextSource>, h: SearchHit) {
  const key = `k${h.chunkId}`;
  if (out.has(key)) return;
  out.set(key, { key, chunkId: h.chunkId, evidenceId: null, documentId: h.documentId, documentTitle: h.documentTitle, label: h.label, canonical: h.canonicalId ? `${h.canonicalId}#${h.anchor}` : null, content: h.content });
}

export function renderContext(sources: ContextSource[], maxChars = 60_000): string {
  let used = 0;
  const parts: string[] = [];
  for (const s of sources) {
    const block = `[[${s.key}]] ${s.label ?? ""}${s.documentTitle ? ` – ${s.documentTitle}` : ""}${s.evidenceId ? " (i ärendets underlag)" : ""}\n${s.content.trim()}\n`;
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n");
}

export function renderCase(p: ProjectDetailDto, instructions?: string | null): string {
  const list = (items: { text: string | null }[]) => (items.length ? items.map((i, n) => `${n + 1}. ${i.text ?? ""}`).join("\n") : "(inga)");
  return [
    `# Ärende: ${p.title ?? ""}`,
    p.description ? `\n${p.description}` : "",
    p.caseOverview ? `\n## Bakgrund\n${p.caseOverview}` : "",
    `\n## Frågor\n${list(p.questions)}`,
    `\n## Omständigheter\n${list(p.circumstances)}`,
    `\n## Rättsfrågor\n${list(p.legalIssues)}`,
    instructions?.trim() ? `\n## Instruktion från juristen\n${instructions.trim()}` : "",
  ].join("\n");
}

/**
 * Citeringar ur analystexten: [[k123]]-nycklar (exakta) och fria hänvisningar (kontrolleras mot
 * underlaget, därefter korpusen). Nycklarna tas bort ur texten som visas; positionerna gäller den rensade texten.
 */
export async function extractCitations(db: Db, markdown: string, sources: ContextSource[]): Promise<{ text: string; citations: Citation[] }> {
  const byKey = new Map(sources.map((s) => [s.key, s]));
  const citations: Citation[] = [];
  let text = "";
  let last = 0;
  for (const m of markdown.matchAll(/\s?\[\[([ke]\d+)\]\]/g)) {
    text += markdown.slice(last, m.index!);
    last = m.index! + m[0].length;
    const s = byKey.get(m[1]!);
    if (!s) continue;
    // Citeringen gäller texten närmast före nyckeln (senaste hänvisningen i meningen, annars etiketten).
    const tail = text.slice(Math.max(0, text.length - 200));
    const refs = extractReferences(tail);
    const r = refs[refs.length - 1];
    const start = r ? text.length - tail.length + r.start : Math.max(0, text.length - (s.label?.length ?? 0));
    citations.push({ text: r?.text ?? s.label ?? "", chunkId: s.chunkId, evidenceId: s.evidenceId, canonical: s.canonical, start, end: text.length, status: "ok" });
  }
  text += markdown.slice(last);

  // Fria hänvisningar som inte redan täcks av en nyckel.
  const covered = (a: number, b: number) => citations.some((c) => a < c.end && b > c.start);
  for (const r of extractReferences(text)) {
    if (covered(r.start, r.end)) continue;
    const inContext = sources.find((s) => s.canonical && (s.canonical === r.canonical || (r.type === "lagrum" && s.canonical === r.canonical)));
    if (inContext) {
      citations.push({ text: r.text, chunkId: inContext.chunkId, evidenceId: inContext.evidenceId, canonical: r.canonical, start: r.start, end: r.end, status: "ok" });
      continue;
    }
    const t = await resolveTarget(db, r);
    citations.push({ text: r.text, chunkId: t.chunkId, evidenceId: null, canonical: r.canonical, start: r.start, end: r.end, status: t.documentId ? "corpus" : "missing" });
  }
  citations.sort((a, b) => a.start - b.start);
  return { text, citations };
}

export interface AnalysisRun {
  system: string;
  user: string;
  sources: ContextSource[];
}

export function buildAnalysisPrompt(project: ProjectDetailDto, sources: ContextSource[], focus: { legalIssue?: string | null; instructions?: string | null }): AnalysisRun {
  const user = [
    renderCase(project, focus.instructions),
    focus.legalIssue ? `\n## Uppgift\nGör en delanalys av rättsfrågan: "${focus.legalIssue}". Håll dig till den.` : `\n## Uppgift\nGör en samlad rättsutredning som besvarar frågorna utifrån omständigheterna och rättsfrågorna.`,
    `\n## Underlag\n${renderContext(sources)}`,
  ].join("\n");
  return { system: SYSTEM_PROMPT, user, sources };
}

export function streamLlm(llm: Llm, run: AnalysisRun, onText: (t: string) => void): Promise<string> {
  return llm.stream({ system: run.system, messages: [{ role: "user", content: run.user }], maxTokens: 6000 }, onText);
}
