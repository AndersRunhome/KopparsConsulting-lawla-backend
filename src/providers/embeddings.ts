/**
 * Embeddings via OpenAI-kompatibel endpoint (`POST {EMBEDDINGS_URL}/v1/embeddings`). Samma
 * adapter täcker TEI (hos kunden), DeepInfra/OpenAI och Cloudflare Workers AI. Utan URL används
 * en deterministisk hash-embedder – bara för utveckling och test, den förstår ingen semantik.
 */
import { createHash } from "node:crypto";
import type { Config } from "../config.js";

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  /** Embeddar texter (batchas internt). Returnerar normaliserade vektorer. */
  embed(texts: string[], kind?: "document" | "query"): Promise<number[][]>;
}

export function createEmbedder(cfg: Pick<Config, "EMBEDDINGS_URL" | "EMBEDDINGS_API_KEY" | "EMBEDDINGS_MODEL" | "EMBEDDINGS_DIM">): Embedder {
  if (!cfg.EMBEDDINGS_URL) return hashEmbedder(cfg.EMBEDDINGS_DIM);
  return openAiCompatibleEmbedder(cfg.EMBEDDINGS_URL, cfg.EMBEDDINGS_API_KEY, cfg.EMBEDDINGS_MODEL, cfg.EMBEDDINGS_DIM);
}

export function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export function openAiCompatibleEmbedder(baseUrl: string, apiKey: string, model: string, dim: number, batchSize = 32): Embedder {
  const url = baseUrl.replace(/\/+$/, "") + (baseUrl.includes("/embeddings") ? "" : "/v1/embeddings");
  return {
    model,
    dim,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model, input: batch }),
        });
        if (!res.ok) throw new Error(`Embeddings-tjänsten svarade ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = (await res.json()) as { data: { index: number; embedding: number[] }[] };
        const sorted = [...data.data].sort((a, b) => a.index - b.index);
        for (const d of sorted) {
          if (d.embedding.length !== dim) throw new Error(`Embedding har ${d.embedding.length} dimensioner, väntade ${dim} (EMBEDDINGS_DIM).`);
          out.push(normalize(d.embedding));
        }
      }
      return out;
    },
  };
}

/**
 * Hash-embedder: ord- och teckentrigram hashas till positioner i vektorn. Ger överlapp mellan
 * texter som delar ord (böjningar via trigram), vilket räcker för att testa sökpipelinen.
 */
export function hashEmbedder(dim = 1024): Embedder {
  return {
    model: "hash-dev",
    dim,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array<number>(dim).fill(0);
        const words = t.toLowerCase().replace(/[^\p{L}\p{N}§]+/gu, " ").split(" ").filter((w) => w.length > 1);
        const add = (token: string, weight: number) => {
          const h = createHash("sha1").update(token).digest();
          const idx = h.readUInt32BE(0) % dim;
          const sign = h[4]! & 1 ? 1 : -1;
          v[idx]! += sign * weight;
        };
        for (const w of words) {
          add(`w:${w}`, 1);
          if (w.length >= 5) for (let i = 0; i + 4 <= w.length; i++) add(`t:${w.slice(i, i + 4)}`, 0.35);
        }
        return normalize(v);
      });
    },
  };
}
