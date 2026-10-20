/** /api/Search, /api/Lagrum/resolve, /api/Ingest (admin). */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppContext, Env } from "../app.js";
import { hybridSearch } from "./hybrid.js";
import { parseReference } from "../documents/citations.js";
import { resolveTarget } from "../ingest/store.js";
import { runIngestJob } from "../ingest/run.js";

export function searchRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const { db } = ctx;

  app.post("/Search", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const query = String(b.query ?? "").trim().slice(0, 1000);
    if (!query) throw new HTTPException(400, { message: "Fråga saknas." });
    const result = await hybridSearch(db, ctx.embedder, ctx.reranker, query, {
      topK: Math.min(50, Math.max(1, Number(b.topK ?? 10))),
      documentTypes: Array.isArray(b.documentTypes) ? b.documentTypes.map(String) : undefined,
      documentIds: Array.isArray(b.documentIds) ? b.documentIds.map(Number).filter(Number.isInteger) : undefined,
      onlyCurrent: b.onlyCurrent === true,
      rewrites: Array.isArray(b.rewrites) ? b.rewrites.map(String).slice(0, 3) : undefined,
    });
    return c.json(result);
  });

  app.get("/Lagrum/resolve", async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 300);
    const ref = parseReference(q);
    if (!ref) return c.json({ query: q, status: "unknown", canonical: null, documentId: null, chunkId: null });
    const t = await resolveTarget(db, ref);
    const chunk = t.chunkId ? await db.one<{ label: string | null; content: string }>(`SELECT label, content FROM chunks WHERE id = $1`, [t.chunkId]) : null;
    const status = t.documentId === null ? "not_in_corpus" : t.chunkId || !ref.canonical.includes("#") ? "found" : "invalid";
    return c.json({ query: q, status, canonical: ref.canonical, type: ref.type, documentId: t.documentId, chunkId: t.chunkId, label: chunk?.label ?? null, excerpt: chunk?.content.slice(0, 400) ?? null });
  });

  app.post("/Ingest", async (c) => {
    if (!c.get("user").isAdmin) throw new HTTPException(403, { message: "Kräver admin." });
    const b = (await c.req.json().catch(() => ({}))) as { source?: string; uri?: string; force?: boolean };
    if (b.source !== "lagen.nu" || !/^https:\/\/lagen\.nu\/[^\s#]+$/.test(b.uri ?? "")) throw new HTTPException(400, { message: "Ange source 'lagen.nu' och en lagen.nu-adress." });
    const job = await db.one<{ id: number }>(`INSERT INTO ingest_jobs (source, uri) VALUES ($1,$2) RETURNING id`, [b.source, b.uri]);
    // Körs i bakgrunden; status via GET /api/Ingest/:id.
    void runIngestJob(ctx, Number(job!.id), { force: b.force === true }).catch((err) => console.error("ingest", err));
    return c.json({ id: Number(job!.id), status: "queued" }, 202);
  });

  app.get("/Ingest/:id", async (c) => {
    if (!c.get("user").isAdmin) throw new HTTPException(403, { message: "Kräver admin." });
    const r = await db.one(`SELECT id, source, uri, status, document_id, error, attempts, created_at, updated_at FROM ingest_jobs WHERE id = $1`, [Number(c.req.param("id"))]);
    if (!r) throw new HTTPException(404, { message: "Jobbet finns inte." });
    return c.json(r);
  });

  return app;
}
