/**
 * Ingest från kommandoraden:
 *   npm run ingest -- https://lagen.nu/2005:716 [fler adresser…] [--force]
 *   npm run ingest -- --file utdrag.md --uri https://lagen.nu/2005:716   (lokal markdown i lagen.nu-format)
 */
import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { connect } from "../db/db.js";
import { migrate } from "../db/migrate.js";
import { createEmbedder } from "../providers/embeddings.js";
import { ingestUri } from "./run.js";
import { lagenToDrafts } from "./lagen.js";
import { storeDocument } from "./store.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const fileIdx = args.indexOf("--file");
const uriIdx = args.indexOf("--uri");
const cfg = loadConfig();
const db = await connect(cfg.DATABASE_URL);
await migrate(db);
const ctx = { db, cfg, embedder: createEmbedder(cfg) };

if (fileIdx !== -1) {
  const md = await readFile(args[fileIdx + 1]!, "utf8");
  const uri = uriIdx !== -1 ? args[uriIdx + 1]! : "https://lagen.nu/lokal";
  const title = md.match(/^#\s+(.+)$/m)?.[1] ?? uri;
  const { document, chunks } = lagenToDrafts({ uri, title, markdown: md, label: null });
  const r = await storeDocument(db, ctx.embedder, document, chunks, { force, log: console.log });
  console.log(r);
} else {
  for (const uri of args.filter((a) => a.startsWith("https://lagen.nu/"))) {
    try {
      console.log(await ingestUri(ctx, "lagen.nu", uri, { force, log: console.log }));
    } catch (err) {
      console.error(`${uri}: ${(err as Error).message}`);
    }
  }
}
await db.close();
