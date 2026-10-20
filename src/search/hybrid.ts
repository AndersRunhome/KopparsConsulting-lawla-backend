/**
 * Hybridsök: frågeförståelse → (exakt lagrum ‖ fulltext ‖ vektor) → RRF → rerank → utvidgning.
 * Se docs/ARCHITECTURE.md §6. Allt i en SQL-fråga per väg; sammanvägningen görs i SQL.
 */
import { toVector, type Db } from "../db/db.js";
import type { Embedder } from "../providers/embeddings.js";
import type { Reranker } from "../providers/rerank.js";
import { parseReference, type Reference } from "../documents/citations.js";
import { SYNONYMS } from "./synonyms.js";

export interface SearchOptions {
  topK?: number;
  /** Filtrera på dokumenttyper (lag, proposition, rattsfall …). */
  documentTypes?: string[];
  documentIds?: number[];
  /** Bara gällande rätt. */
  onlyCurrent?: boolean;
  /** Fler omskrivningar av frågan (från frågeförståelsen). */
  rewrites?: string[];
  /** Hoppa över reranking (t.ex. i utvärdering av grundsöket). */
  skipRerank?: boolean;
}

export interface SearchHit {
  chunkId: number;
  documentId: number;
  documentTitle: string;
  documentType: string;
  canonicalId: string | null;
  anchor: string;
  label: string | null;
  kind: string;
  path: string[];
  content: string;
  summary: string | null;
  score: number;
  /** Varför träffen kom: poäng per väg. */
  signals: { exact?: true; fulltext?: number; vector?: number; rerank?: number };
  /** Relaterade chunkar via referensgrafen (ett steg). */
  related?: { chunkId: number; documentTitle: string; label: string | null; referenceType: string }[];
}

export interface SearchResult {
  query: string;
  understood: { reference: Reference | null; terms: string; rewrites: string[] };
  hits: SearchHit[];
  timings: Record<string, number>;
}

const RRF_K = 60;
const CANDIDATES = 50;

/** Lägger till synonymer så att vardagsord även träffar juridiska termer (och tvärtom). */
export function expandTerms(q: string): string {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}§:]+/u).filter(Boolean);
  const extra = new Set<string>();
  for (const w of words) for (const s of SYNONYMS[w] ?? []) extra.add(s);
  return extra.size ? `${q} ${[...extra].join(" ")}` : q;
}

/** Fulltextfråga: OR mellan orden så att en fråga i vardagsspråk inte kräver att alla ord finns. */
function toTsQuery(q: string): string {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  return [...new Set(words)].map((w) => w.replace(/'/g, "")).join(" | ");
}

export async function hybridSearch(db: Db, embedder: Embedder, reranker: Reranker, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const topK = opts.topK ?? 10;
  const reference = parseReference(query);
  const terms = expandTerms(query);
  const rewrites = opts.rewrites ?? [];

  // Filter som gäller alla vägar.
  const filters: string[] = [];
  const fparams: unknown[] = [];
  if (opts.documentTypes?.length) {
    fparams.push(opts.documentTypes);
    filters.push(`d.document_type = ANY($${fparams.length})`);
  }
  if (opts.documentIds?.length) {
    fparams.push(opts.documentIds);
    filters.push(`d.id = ANY($${fparams.length})`);
  }
  if (opts.onlyCurrent) filters.push(`d.status = 'gallande'`);
  filters.push(`c.kind <> 'rubrik'`);
  const where = filters.length ? `AND ${filters.join(" AND ")}` : "";

  // 1. Exakt uppslag av hänvisning.
  const exactIds = new Set<number>();
  if (reference) {
    const [docPart, anchor] = reference.canonical.split("#") as [string, string | undefined];
    const rows = docPart.startsWith("law:")
      ? await db.query<{ id: number }>(
          `SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id
           WHERE c.anchor = $1 AND lower(d.title) LIKE '%' || $2 || '%' ${where.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 2}`)} LIMIT 5`,
          [anchor ?? "", reference.lagrum?.law?.toLowerCase().replace(/(en|et)$/, "") ?? "", ...fparams],
        )
      : await db.query<{ id: number }>(
          `SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id
           WHERE d.canonical_id = $1 AND ($2 = '' OR c.anchor = $2) ${where.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 2}`)}
           ORDER BY c.chunk_index LIMIT 5`,
          [docPart, anchor ?? "", ...fparams],
        );
    for (const r of rows) exactIds.add(Number(r.id));
  }
  timings.exact = Date.now() - t0;

  // 2. Fulltext + vektor med RRF i en fråga.
  const t1 = Date.now();
  const queries = [terms, ...rewrites.map(expandTerms)];
  const vectors = await embedder.embed([query, ...rewrites], "query");
  timings.embed = Date.now() - t1;

  const t2 = Date.now();
  const params: unknown[] = [...fparams];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const ftParts = queries.map((q) => {
    const tsq = p(toTsQuery(q));
    return `SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, to_tsquery('swedish', ${tsq}), 32) DESC) AS rn
      FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.tsv @@ to_tsquery('swedish', ${tsq}) ${where} LIMIT ${CANDIDATES}`;
  });
  const vecParts = vectors.map((v) => {
    const vp = p(toVector(v));
    return `SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> ${vp}::vector) AS rn
      FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.embedding IS NOT NULL ${where} ORDER BY c.embedding <=> ${vp}::vector LIMIT ${CANDIDATES}`;
  });
  const sql = `
    WITH ft AS (${ftParts.map((s) => `(${s})`).join(" UNION ALL ")}),
         vec AS (${vecParts.map((s) => `(${s})`).join(" UNION ALL ")}),
         fused AS (
           SELECT id, sum(1.0 / (${RRF_K} + rn)) AS score, max(CASE WHEN src = 'ft' THEN 1.0/(${RRF_K}+rn) END) AS ft_score,
                  max(CASE WHEN src = 'vec' THEN 1.0/(${RRF_K}+rn) END) AS vec_score
           FROM (SELECT id, rn, 'ft' AS src FROM ft UNION ALL SELECT id, rn, 'vec' FROM vec) u
           GROUP BY id
         )
    SELECT f.id, f.score, f.ft_score, f.vec_score FROM fused f ORDER BY f.score DESC LIMIT ${CANDIDATES}`;
  const fused = await db.query<{ id: number; score: number; ft_score: number | null; vec_score: number | null }>(sql, params);
  timings.fuse = Date.now() - t2;

  // Exakta träffar läggs först.
  const order: { id: number; score: number; ft: number | null; vec: number | null; exact: boolean }[] = [];
  for (const id of exactIds) order.push({ id, score: 1, ft: null, vec: null, exact: true });
  for (const f of fused) if (!exactIds.has(Number(f.id))) order.push({ id: Number(f.id), score: Number(f.score), ft: f.ft_score === null ? null : Number(f.ft_score), vec: f.vec_score === null ? null : Number(f.vec_score), exact: false });
  if (!order.length) return { query, understood: { reference, terms, rewrites }, hits: [], timings };

  const rows = await db.query<{
    id: number; document_id: number; title: string; document_type: string; canonical_id: string | null; anchor: string; label: string | null;
    kind: string; path: string[]; content: string; summary: string | null;
  }>(
    `SELECT c.id, c.document_id, d.title, d.document_type, d.canonical_id, c.anchor, c.label, c.kind, c.path, c.content, c.summary
     FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ANY($1)`,
    [order.map((o) => o.id)],
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  let hits: SearchHit[] = order
    .filter((o) => byId.has(o.id))
    .map((o) => {
      const r = byId.get(o.id)!;
      return {
        chunkId: Number(r.id), documentId: Number(r.document_id), documentTitle: r.title, documentType: r.document_type, canonicalId: r.canonical_id,
        anchor: r.anchor, label: r.label, kind: r.kind, path: r.path, content: r.content, summary: r.summary, score: o.score,
        signals: { ...(o.exact ? { exact: true as const } : {}), ...(o.ft !== null ? { fulltext: o.ft } : {}), ...(o.vec !== null ? { vector: o.vec } : {}) },
      };
    });

  // 3. Reranking av kandidaterna (exakta träffar behåller topplaceringen).
  if (reranker.enabled && !opts.skipRerank) {
    const t3 = Date.now();
    const scores = await reranker.score(query, hits.map((h) => `${h.label ? `${h.label}: ` : ""}${h.content.slice(0, 1500)}`));
    hits.forEach((h, i) => {
      h.signals.rerank = scores[i];
      if (!h.signals.exact) h.score = scores[i]!;
    });
    hits.sort((a, b) => (b.signals.exact ? 1 : 0) - (a.signals.exact ? 1 : 0) || b.score - a.score);
    timings.rerank = Date.now() - t3;
  }
  hits = hits.slice(0, topK);

  // 4. Utvidgning via referensgrafen: vad hänvisar träffen till, och vad hänvisar hit?
  const t4 = Date.now();
  const rel = await db.query<{ src: number; chunk_id: number; title: string; label: string | null; reference_type: string }>(
    `SELECT r.source_chunk_id AS src, c.id AS chunk_id, d.title, c.label, r.reference_type
       FROM document_references r JOIN chunks c ON c.id = r.target_chunk_id JOIN documents d ON d.id = c.document_id
      WHERE r.source_chunk_id = ANY($1)
     UNION ALL
     SELECT r.target_chunk_id AS src, c.id, d.title, c.label, r.reference_type
       FROM document_references r JOIN chunks c ON c.id = r.source_chunk_id JOIN documents d ON d.id = c.document_id
      WHERE r.target_chunk_id = ANY($1)`,
    [hits.map((h) => h.chunkId)],
  );
  for (const h of hits) {
    const related = rel.filter((r) => Number(r.src) === h.chunkId).slice(0, 8).map((r) => ({ chunkId: Number(r.chunk_id), documentTitle: r.title, label: r.label, referenceType: r.reference_type }));
    if (related.length) h.related = related;
  }
  timings.expand = Date.now() - t4;
  timings.total = Date.now() - t0;
  return { query, understood: { reference, terms, rewrites }, hits, timings };
}
