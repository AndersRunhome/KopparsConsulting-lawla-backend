/**
 * Reranking med cross-encoder via TEI-/Cohere-kompatibel endpoint (`POST {RERANK_URL}/rerank`,
 * kropp `{query, texts|documents, model?}`). Utan URL returneras ordningen oförändrad.
 */
import type { Config } from "../config.js";

export interface Reranker {
  readonly enabled: boolean;
  /** Poäng per text (högre = mer relevant), i samma ordning som indata. */
  score(query: string, texts: string[]): Promise<number[]>;
}

export function createReranker(cfg: Pick<Config, "RERANK_URL" | "RERANK_API_KEY" | "RERANK_MODEL">): Reranker {
  if (!cfg.RERANK_URL) return { enabled: false, score: async (_q, texts) => texts.map((_, i) => -i) };
  const url = cfg.RERANK_URL.replace(/\/+$/, "") + (cfg.RERANK_URL.includes("/rerank") ? "" : "/rerank");
  return {
    enabled: true,
    async score(query, texts) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(cfg.RERANK_API_KEY ? { Authorization: `Bearer ${cfg.RERANK_API_KEY}` } : {}) },
        // TEI/Cohere: {query, texts|documents}; DeepInfra: {queries, documents} → {scores}. Alla fält skickas, varje tjänst läser sina.
        body: JSON.stringify({ query, queries: [query], texts, documents: texts, model: cfg.RERANK_MODEL, raw_scores: false }),
      });
      if (!res.ok) throw new Error(`Rerank-tjänsten svarade ${res.status}: ${(await res.text()).slice(0, 300)}`);
      type R = { index: number; score?: number; relevance_score?: number };
      const data = (await res.json()) as R[] | { results?: R[]; scores?: number[] };
      if (!Array.isArray(data) && Array.isArray(data.scores)) return data.scores.slice(0, texts.length);
      const rows: R[] = Array.isArray(data) ? data : data.results ?? [];
      const scores = new Array<number>(texts.length).fill(-Infinity);
      for (const r of rows) scores[r.index] = r.score ?? r.relevance_score ?? 0;
      return scores;
    },
  };
}
