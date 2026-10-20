/**
 * Utvärdering av söket: `npm run eval [-- --file eval/questions.jsonl --k 10 --no-rerank]`.
 * Räknar recall@5, recall@10 och MRR mot förväntade kanoniska id:n (sfs:…#K5P16c). Kör alltid
 * detta före och efter en ändring i chunkning, synonymer eller modellval.
 */
import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { connect } from "../src/db/db.js";
import { createEmbedder } from "../src/providers/embeddings.js";
import { createReranker } from "../src/providers/rerank.js";
import { hybridSearch } from "../src/search/hybrid.js";

const args = process.argv.slice(2);
const file = args[args.indexOf("--file") + 1] && args.includes("--file") ? args[args.indexOf("--file") + 1]! : "eval/questions.jsonl";
const k = args.includes("--k") ? Number(args[args.indexOf("--k") + 1]) : 10;
const cfg = loadConfig();
const db = await connect(cfg.DATABASE_URL);
const embedder = createEmbedder(cfg);
const reranker = createReranker(cfg);

const lines = (await readFile(file, "utf8")).split("\n").filter((l) => l.trim());
let r5 = 0, r10 = 0, mrr = 0;
for (const line of lines) {
  const q = JSON.parse(line) as { query: string; expect: string[] };
  const res = await hybridSearch(db, embedder, reranker, q.query, { topK: k, skipRerank: args.includes("--no-rerank") });
  const ids = res.hits.map((h) => `${h.canonicalId}#${h.anchor}`);
  const rank = ids.findIndex((id) => q.expect.includes(id));
  if (rank !== -1 && rank < 5) r5++;
  if (rank !== -1 && rank < 10) r10++;
  if (rank !== -1) mrr += 1 / (rank + 1);
  console.log(`${rank === -1 ? "MISS" : `#${rank + 1}`.padEnd(4)}  ${q.query}  → ${ids.slice(0, 3).join(", ")}`);
}
const n = lines.length;
console.log(`\nrecall@5 ${(r5 / n).toFixed(2)}  recall@10 ${(r10 / n).toFixed(2)}  MRR ${(mrr / n).toFixed(2)}  (n=${n}, embeddings=${embedder.model}, rerank=${reranker.enabled})`);
await db.close();
