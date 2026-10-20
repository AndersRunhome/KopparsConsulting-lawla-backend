/** /api/Documents och /api/References – korpusen som frontenden läser den. */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppContext, Env } from "../app.js";
import { iso } from "../auth/auth.js";

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export function documentRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const { db } = ctx;

  const docDto = (r: Record<string, unknown>) => ({
    id: Number(r.id), title: r.title, timestamp: iso(r.created_at), lastModified: iso(r.updated_at), source: r.source, sourceType: r.source_type,
    documentType: r.document_type, canonicalId: r.canonical_id, tags: r.tags, hasAnalysis: false, hasEmbeddings: true,
    chunkCount: Number(r.chunk_count ?? 0), outgoingReferenceCount: Number(r.out_refs ?? 0), incomingReferenceCount: Number(r.in_refs ?? 0),
    status: r.status, identifier: r.identifier,
  });
  const DOC_SELECT = `SELECT d.*, (SELECT count(*) FROM chunks c WHERE c.document_id = d.id AND c.kind <> 'rubrik') AS chunk_count,
      (SELECT count(*) FROM document_references r WHERE r.source_document_id = d.id) AS out_refs,
      (SELECT count(*) FROM document_references r WHERE r.target_document_id = d.id) AS in_refs FROM documents d`;

  app.get("/Documents/stats", async (c) => {
    const rows = await db.query<{ document_type: string; n: number }>(`SELECT document_type, count(*)::int AS n FROM documents GROUP BY document_type`);
    return c.json({ totalCount: rows.reduce((s, r) => s + r.n, 0), typeCounts: Object.fromEntries(rows.map((r) => [r.document_type, r.n])) });
  });

  app.get("/Documents", async (c) => {
    const page = Math.max(1, num(c.req.query("page"), 1));
    const pageSize = Math.min(200, Math.max(1, num(c.req.query("pageSize"), 50)));
    const search = c.req.query("search")?.trim();
    const tag = c.req.query("tag")?.trim();
    const type = c.req.query("documentType")?.trim();
    const where: string[] = [];
    const params: unknown[] = [];
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where.push(`(lower(d.title) LIKE $${params.length} OR lower(coalesce(d.identifier,'')) LIKE $${params.length}${c.req.query("searchContent") === "true" ? ` OR EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id AND c.tsv @@ plainto_tsquery('swedish', $${params.length + 1}))` : ""})`);
      if (c.req.query("searchContent") === "true") params.push(search);
    }
    if (tag) { params.push(tag); where.push(`$${params.length} = ANY(d.tags)`); }
    if (type) { params.push(type); where.push(`d.document_type = $${params.length}`); }
    const rows = await db.query(`${DOC_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.title LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
    return c.json(rows.map(docDto));
  });

  app.get("/Documents/chunks/:chunkId", async (c) => {
    const r = await db.one(
      `SELECT c.*, d.title AS document_title, d.document_type, d.canonical_id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = $1`,
      [Number(c.req.param("chunkId"))]);
    if (!r) throw new HTTPException(404, { message: "Avsnittet finns inte." });
    return c.json(chunkDto(r));
  });

  app.get("/Documents/:id", async (c) => {
    const r = await db.one(`${DOC_SELECT} WHERE d.id = $1`, [Number(c.req.param("id"))]);
    if (!r) throw new HTTPException(404, { message: "Dokumentet finns inte." });
    return c.json(docDto(r));
  });

  app.get("/Documents/:id/chunks", async (c) => {
    const rows = await db.query(
      `SELECT c.*, d.title AS document_title, d.document_type, d.canonical_id FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.document_id = $1 AND c.kind <> 'rubrik' ORDER BY c.chunk_index`, [Number(c.req.param("id"))]);
    return c.json(rows.map(chunkDto));
  });

  app.get("/Documents/:id/toc", async (c) => {
    const rows = await db.query<{ id: number; chunk_index: number; label: string | null; kind: string; metadata: Record<string, unknown> }>(
      `SELECT id, chunk_index, label, kind, metadata FROM chunks WHERE document_id = $1 ORDER BY chunk_index`, [Number(c.req.param("id"))]);
    return c.json(rows.filter((r) => r.label).map((r) => ({ chunkId: Number(r.id), chunkIndex: r.chunk_index, displayLabel: r.label, kind: r.kind, level: r.metadata?.level ?? null })));
  });

  const outgoing = async (ids: number[]) =>
    (await db.query(
      `SELECT r.id, r.source_document_id, r.canonical_form, r.reference_type, r.citation_text, r.target_document_id, r.target_chunk_id, r.is_resolved, t.title AS target_title
       FROM document_references r LEFT JOIN documents t ON t.id = r.target_document_id WHERE r.source_document_id = ANY($1) ORDER BY r.id`, [ids]))
      .map((r) => ({ id: Number(r.id), sourceDocumentId: Number(r.source_document_id), canonicalForm: r.canonical_form, referenceType: r.reference_type, displayText: r.citation_text,
        citationText: r.citation_text, targetDocumentId: r.target_document_id === null ? null : Number(r.target_document_id), targetChunkId: r.target_chunk_id === null ? null : Number(r.target_chunk_id),
        targetDocumentTitle: r.target_title ?? null, isResolved: r.is_resolved }));

  app.get("/References/outgoing", async (c) => {
    const ids = (c.req.query("documentIds") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
    return c.json(ids.length ? await outgoing(ids) : []);
  });
  app.get("/References/document/:id/outgoing", async (c) => c.json(await outgoing([Number(c.req.param("id"))])));
  app.get("/References/document/:id/incoming", async (c) => {
    const rows = await db.query(
      `SELECT r.id, r.source_document_id, s.title AS source_title, r.reference_type, r.citation_text, r.canonical_form
       FROM document_references r JOIN documents s ON s.id = r.source_document_id WHERE r.target_document_id = $1 ORDER BY r.id`, [Number(c.req.param("id"))]);
    return c.json(rows.map((r) => ({ id: Number(r.id), sourceDocumentId: Number(r.source_document_id), sourceDocumentTitle: r.source_title, referenceType: r.reference_type, citationText: r.citation_text, targetCanonicalForm: r.canonical_form })));
  });

  return app;
}

export function chunkDto(r: Record<string, unknown>) {
  const meta = (r.metadata ?? {}) as Record<string, unknown>;
  return {
    id: Number(r.id), documentId: Number(r.document_id), documentTitle: r.document_title, documentType: r.document_type, canonicalId: r.canonical_id,
    content: r.content, chunkIndex: r.chunk_index, structuralMetadata: { ...meta, anchor: r.anchor, kind: r.kind, path: r.path, context: r.context },
    displayLabel: r.label, preview: String(r.content ?? "").slice(0, 200), anchor: r.anchor, kind: r.kind, path: r.path, summary: r.summary ?? null,
  };
}
