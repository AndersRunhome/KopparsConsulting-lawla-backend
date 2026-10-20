/** Produktionsserver: Node + Hono. `npm run dev` för utveckling, `npm start` i containern. */
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { connect } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { createEmbedder } from "./providers/embeddings.js";
import { createReranker } from "./providers/rerank.js";
import { createLlm } from "./providers/llm.js";
import { createApp } from "./app.js";

const cfg = loadConfig();
const db = await connect(cfg.DATABASE_URL);
await migrate(db, console.log);
const app = createApp({ cfg, db, embedder: createEmbedder(cfg), reranker: createReranker(cfg), llm: createLlm(cfg) });

serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  console.log(`Lawla backend lyssnar på http://localhost:${info.port} (db: ${db.kind}, embeddings: ${cfg.EMBEDDINGS_MODEL}${cfg.EMBEDDINGS_URL ? "" : " [hash-dev]"}, llm: ${cfg.LLM_PROVIDER})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await db.close();
    process.exit(0);
  });
}
