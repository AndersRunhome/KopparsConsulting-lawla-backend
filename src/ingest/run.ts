/** Kör ett ingest-jobb: hämta från källan, tolka, chunka, lagra. Status i ingest_jobs. */
import type { AppContext } from "../app.js";
import { fetchLagenMarkdown, lagenToDrafts } from "./lagen.js";
import { storeDocument, type StoreResult } from "./store.js";

export async function runIngestJob(ctx: Pick<AppContext, "db" | "embedder" | "cfg">, jobId: number, opts: { force?: boolean; log?: (m: string) => void } = {}): Promise<StoreResult> {
  const { db } = ctx;
  const job = await db.one<{ source: string; uri: string }>(`UPDATE ingest_jobs SET status='running', attempts=attempts+1, updated_at=now() WHERE id=$1 RETURNING source, uri`, [jobId]);
  if (!job) throw new Error(`Jobb ${jobId} finns inte.`);
  try {
    const result = await ingestUri(ctx, job.source, job.uri, opts);
    await db.query(`UPDATE ingest_jobs SET status='done', document_id=$2, updated_at=now() WHERE id=$1`, [jobId, result.documentId]);
    return result;
  } catch (err) {
    await db.query(`UPDATE ingest_jobs SET status='error', error=$2, updated_at=now() WHERE id=$1`, [jobId, String((err as Error).message ?? err).slice(0, 2000)]);
    throw err;
  }
}

export async function ingestUri(ctx: Pick<AppContext, "db" | "embedder" | "cfg">, source: string, uri: string, opts: { force?: boolean; log?: (m: string) => void } = {}): Promise<StoreResult> {
  if (source !== "lagen.nu") throw new Error(`Okänd källa: ${source}`);
  const doc = await fetchLagenMarkdown(ctx.cfg.LAGEN_BASE, uri);
  if (!doc.markdown) throw new Error(`lagen.nu gav ingen markdown för ${uri}`);
  const { document, chunks } = lagenToDrafts(doc);
  return storeDocument(ctx.db, ctx.embedder, document, chunks, opts);
}
