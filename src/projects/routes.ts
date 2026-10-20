/** /api/Projects – ärenden, frågor/omständigheter/rättsfrågor, underlag, versioner, delningar, anteckningar. */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomBytes } from "node:crypto";
import type { AppContext, Env } from "../app.js";
import { iso } from "../auth/auth.js";
import { ITEM_KINDS, evidenceList, listProjects, projectDetail, requireProject, snapshotOf, touch } from "./repo.js";
import { snapshotCounts, snapshotHash, type VersionTrigger } from "../../shared/snapshot.js";
import { MAIN_PROMPT_MAX, SHARE_MARKDOWN_MAX, SHARE_MAX_DAYS, SHARE_MAX_PER_PROJECT, shareStatus, type CreateShareRequest, type ShareSummary, type SharedReport } from "../../shared/sharing.js";

const id = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HTTPException(400, { message: "Ogiltigt id." });
  return n;
};
const str = (v: unknown, max = 20_000) => (typeof v === "string" ? v.slice(0, max) : null);

/** Publik delad rapport – ingen inloggning. Monteras på /api/shares/:token före auth-middlewaren. */
export function publicShareRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const { db } = ctx;
  /* ─── Publik delad rapport (ingen inloggning – monteras via /api/shares/:token) ─ */
  app.get("/:token", async (c) => {
    const row = await db.one<{ payload: SharedReport; expires_at: string | null; revoked_at: string | null }>(
      `SELECT payload, expires_at, revoked_at FROM report_shares WHERE token = $1`,
      [c.req.param("token")],
    );
    c.header("X-Robots-Tag", "noindex");
    if (!row || shareStatus({ expiresAt: row.expires_at ? iso(row.expires_at) : null, revokedAt: row.revoked_at ? iso(row.revoked_at) : null }) !== "active") {
      throw new HTTPException(404, { message: "Länken gäller inte längre." });
    }
    await db.query(`UPDATE report_shares SET view_count = view_count + 1 WHERE token = $1`, [c.req.param("token")]);
    return c.json(row.payload);
  });

  return app;
}

export function projectRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const { db } = ctx;

  /* ─── Ärenden ─────────────────────────────────────────────────────── */
  app.get("/", async (c) => c.json(await listProjects(db, c.get("user"))));

  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const title = str(body.title, 300)?.trim();
    if (!title) throw new HTTPException(400, { message: "Titel saknas." });
    const row = await db.one<{ id: number }>(`INSERT INTO projects (owner_id, title, description) VALUES ($1,$2,$3) RETURNING id`, [c.get("user").id, title, str(body.description)]);
    return c.json(await projectDetail(db, await requireProject(db, Number(row!.id), c.get("user"))), 201);
  });

  app.get("/:id", async (c) => c.json(await projectDetail(db, await requireProject(db, id(c.req.param("id")), c.get("user")))));

  app.put("/:id", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const mainPrompt = body.mainPrompt === undefined ? p.main_prompt : str(body.mainPrompt, MAIN_PROMPT_MAX);
    await db.query(
      `UPDATE projects SET title=$2, description=$3, case_overview=$4, status=$5, main_prompt=$6, updated_at=now() WHERE id=$1`,
      [p.id, str(body.title, 300) ?? p.title, body.description === undefined ? p.description : str(body.description), body.caseOverview === undefined ? p.case_overview : str(body.caseOverview),
        Number.isInteger(body.status) ? body.status : p.status, mainPrompt],
    );
    return c.json(await projectDetail(db, await requireProject(db, Number(p.id), c.get("user"))));
  });

  app.delete("/:id", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    await db.query(`DELETE FROM projects WHERE id = $1`, [p.id]);
    return c.body(null, 204);
  });

  /* ─── Frågor, omständigheter, rättsfrågor ─────────────────────────── */
  app.post("/:id/:kind{questions|circumstances|legal-issues}", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    const kind = ITEM_KINDS[c.req.param("kind")]!;
    const body = (await c.req.json().catch(() => ({}))) as { text?: string };
    const text = str(body.text)?.trim();
    if (!text) throw new HTTPException(400, { message: "Text saknas." });
    const row = await db.one<{ id: number; sort_order: number; created_at: string }>(
      `INSERT INTO project_items (project_id, kind, text, sort_order)
       VALUES ($1,$2,$3,(SELECT coalesce(max(sort_order),0)+1 FROM project_items WHERE project_id=$1 AND kind=$2)) RETURNING id, sort_order, created_at`,
      [p.id, kind, text],
    );
    await touch(db, Number(p.id));
    const dto = { id: Number(row!.id), text, sortOrder: row!.sort_order, createdAt: iso(row!.created_at) };
    return c.json(kind === "legal_issue" ? { ...dto, analysisCount: 0 } : dto, 201);
  });

  app.put("/:id/:kind{questions|circumstances|legal-issues}/:itemId", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    const body = (await c.req.json().catch(() => ({}))) as { text?: string };
    const text = str(body.text)?.trim();
    if (!text) throw new HTTPException(400, { message: "Text saknas." });
    const row = await db.one<{ id: number; sort_order: number; created_at: string }>(
      `UPDATE project_items SET text=$3, updated_at=now() WHERE id=$1 AND project_id=$2 AND kind=$4 RETURNING id, sort_order, created_at`,
      [id(c.req.param("itemId")), p.id, text, ITEM_KINDS[c.req.param("kind")]],
    );
    if (!row) throw new HTTPException(404, { message: "Posten finns inte." });
    await touch(db, Number(p.id));
    return c.json({ id: Number(row.id), text, sortOrder: row.sort_order, createdAt: iso(row.created_at) });
  });

  app.delete("/:id/:kind{questions|circumstances|legal-issues}/:itemId", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    await db.query(`DELETE FROM project_items WHERE id=$1 AND project_id=$2 AND kind=$3`, [id(c.req.param("itemId")), p.id, ITEM_KINDS[c.req.param("kind")]]);
    await touch(db, Number(p.id));
    return c.body(null, 204);
  });

  /* ─── Underlag ────────────────────────────────────────────────────── */
  app.get("/:id/evidence/expanded", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    return c.json(await evidenceList(db, Number(p.id)));
  });

  app.post("/:id/evidence", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const documentId = Number.isInteger(b.documentId) ? (b.documentId as number) : null;
    const chunkId = Number.isInteger(b.chunkId) ? (b.chunkId as number) : null;
    const content = str(b.content, 50_000);
    if (!documentId && !chunkId && !content?.trim()) throw new HTTPException(400, { message: "Ange ett dokument, ett avsnitt eller en text." });
    let docId = documentId;
    let canonical: string | null = str(b.canonicalReference, 300);
    if (chunkId) {
      const ch = await db.one<{ document_id: number; anchor: string; canonical_id: string | null }>(
        `SELECT c.document_id, c.anchor, d.canonical_id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = $1`,
        [chunkId],
      );
      if (!ch) throw new HTTPException(404, { message: "Avsnittet finns inte." });
      docId = Number(ch.document_id);
      canonical ??= ch.canonical_id ? `${ch.canonical_id}#${ch.anchor}` : null;
    } else if (docId) {
      const d = await db.one<{ canonical_id: string | null }>(`SELECT canonical_id FROM documents WHERE id = $1`, [docId]);
      if (!d) throw new HTTPException(404, { message: "Dokumentet finns inte." });
      canonical ??= d.canonical_id;
    }
    const type = docId ? 0 : 2; // 0 = korpus, 2 = egen/extern text
    const row = await db.one<{ id: number }>(
      `INSERT INTO project_evidence (project_id, type, document_id, chunk_id, content, display_label, annotation, canonical_reference, external_url, char_start, char_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [p.id, type, docId, chunkId, content, str(b.displayLabel, 500), str(b.annotation, 4000), canonical, str(b.externalUrl, 1000),
        Number.isInteger(b.charStart) ? b.charStart : null, Number.isInteger(b.charEnd) ? b.charEnd : null],
    );
    await touch(db, Number(p.id));
    const e = (await evidenceList(db, Number(p.id))).find((x) => x.id === Number(row!.id))!;
    return c.json({ id: e.id, type: e.type, documentId: e.documentId, chunkId: e.chunkId, canonicalReference: e.canonicalReference, displayLabel: e.displayLabel, annotation: e.annotation, createdAt: e.createdAt, updatedAt: e.updatedAt }, 201);
  });

  app.put("/:id/evidence/:eid", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const row = await db.one(`UPDATE project_evidence SET display_label=$3, annotation=$4, updated_at=now() WHERE id=$1 AND project_id=$2 RETURNING id`,
      [id(c.req.param("eid")), p.id, str(b.displayLabel, 500), str(b.annotation, 4000)]);
    if (!row) throw new HTTPException(404, { message: "Rättskällan finns inte." });
    await touch(db, Number(p.id));
    return c.json((await evidenceList(db, Number(p.id))).find((x) => x.id === id(c.req.param("eid"))));
  });

  app.delete("/:id/evidence/:eid", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    await db.query(`DELETE FROM project_evidence WHERE id=$1 AND project_id=$2`, [id(c.req.param("eid")), p.id]);
    await touch(db, Number(p.id));
    return c.body(null, 204);
  });

  /* ─── Versioner (ersätter worker/history.ts) ──────────────────────── */
  app.get("/:id/versions", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    const rows = await db.query<{ id: number; label: string | null; trigger: VersionTrigger; snapshot: Parameters<typeof snapshotCounts>[0]; created_at: string }>(
      `SELECT id, label, trigger, snapshot, created_at FROM project_versions WHERE project_id = $1 ORDER BY created_at DESC, id DESC`, [p.id]);
    return c.json(rows.map((r) => ({ id: Number(r.id), createdAt: iso(r.created_at), label: r.label, trigger: r.trigger, counts: snapshotCounts(r.snapshot) })));
  });

  app.post("/:id/versions", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    const b = (await c.req.json().catch(() => ({}))) as { label?: string; trigger?: VersionTrigger };
    const trigger: VersionTrigger = b.trigger === "analysis" ? "analysis" : "manual";
    const snapshot = await snapshotOf(db, p);
    const hash = snapshotHash(snapshot);
    const latest = await db.one<{ id: number; hash: string; label: string | null; trigger: VersionTrigger; created_at: string }>(
      `SELECT id, hash, label, trigger, created_at FROM project_versions WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [p.id]);
    if (latest && latest.hash === hash && trigger === "analysis") {
      return c.json({ version: { id: Number(latest.id), createdAt: iso(latest.created_at), label: latest.label, trigger: latest.trigger, counts: snapshotCounts(snapshot) }, created: false });
    }
    const row = await db.one<{ id: number; created_at: string }>(
      `INSERT INTO project_versions (project_id, label, trigger, hash, snapshot, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [p.id, str(b.label, 200)?.trim() || null, trigger, hash, JSON.stringify(snapshot), c.get("user").id]);
    return c.json({ version: { id: Number(row!.id), createdAt: iso(row!.created_at), label: str(b.label, 200)?.trim() || null, trigger, counts: snapshotCounts(snapshot) }, created: true }, 201);
  });

  app.get("/:id/versions/:vid", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    const r = await db.one<{ id: number; label: string | null; trigger: VersionTrigger; snapshot: Parameters<typeof snapshotCounts>[0]; created_at: string }>(
      `SELECT id, label, trigger, snapshot, created_at FROM project_versions WHERE project_id = $1 AND id = $2`, [p.id, id(c.req.param("vid"))]);
    if (!r) throw new HTTPException(404, { message: "Versionen finns inte." });
    return c.json({ id: Number(r.id), createdAt: iso(r.created_at), label: r.label, trigger: r.trigger, counts: snapshotCounts(r.snapshot), snapshot: r.snapshot });
  });

  /* ─── Delningslänkar (ersätter worker/share.ts) ───────────────────── */
  const toSummary = (r: { token: string; label: string | null; payload: SharedReport; shared_by: string | null; expires_at: string | null; revoked_at: string | null; view_count: number; created_at: string }): ShareSummary => ({
    token: r.token, label: r.label, title: r.payload.title, createdAt: iso(r.created_at), createdBy: r.shared_by,
    expiresAt: r.expires_at ? iso(r.expires_at) : null, revokedAt: r.revoked_at ? iso(r.revoked_at) : null, views: r.view_count,
  });

  app.get("/:id/shares", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    const rows = await db.query<Parameters<typeof toSummary>[0]>(`SELECT * FROM report_shares WHERE project_id = $1 ORDER BY created_at DESC`, [p.id]);
    return c.json(rows.map(toSummary));
  });

  app.post("/:id/shares", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    const b = (await c.req.json().catch(() => ({}))) as Partial<CreateShareRequest>;
    if (!b.title?.trim() || typeof b.markdown !== "string" || !b.markdown.trim()) throw new HTTPException(400, { message: "Titel och rapport krävs." });
    if (b.markdown.length > SHARE_MARKDOWN_MAX) throw new HTTPException(413, { message: "Rapporten är för stor för att delas." });
    const active = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM report_shares WHERE project_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [p.id]);
    if (Number(active?.n ?? 0) >= SHARE_MAX_PER_PROJECT) throw new HTTPException(429, { message: `Högst ${SHARE_MAX_PER_PROJECT} aktiva länkar per ärende.` });
    const days = Math.min(Math.max(Number(b.expiresInDays ?? 0), 0), SHARE_MAX_DAYS);
    const expiresAt = days ? new Date(Date.now() + days * 86_400_000) : null;
    const token = randomBytes(24).toString("base64url");
    const payload: SharedReport = {
      title: b.title.trim().slice(0, 300), markdown: b.markdown, evidence: Array.isArray(b.evidence) ? b.evidence.slice(0, 500) : [],
      createdAt: new Date().toISOString(), createdBy: c.get("user").name ?? c.get("user").email, expiresAt: expiresAt?.toISOString() ?? null,
    };
    const row = await db.one<Parameters<typeof toSummary>[0]>(
      `INSERT INTO report_shares (token, project_id, label, payload, shared_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [token, p.id, str(b.label, 200)?.trim() || null, JSON.stringify(payload), payload.createdBy, expiresAt]);
    return c.json({ share: toSummary(row!) }, 201);
  });

  app.delete("/:id/shares/:token", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    await db.query(`UPDATE report_shares SET revoked_at = now() WHERE project_id = $1 AND token = $2 AND revoked_at IS NULL`, [p.id, c.req.param("token")]);
    return c.body(null, 204);
  });

  /* ─── Anteckningar per källa (ersätter worker/notes.ts) ───────────── */
  app.get("/:id/notes/:sourceKey", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    const r = await db.one<{ text: string; updated_by: string | null; updated_at: string }>(`SELECT text, updated_by, updated_at FROM source_notes WHERE project_id = $1 AND source_key = $2`, [p.id, c.req.param("sourceKey")]);
    return c.json(r ? { text: r.text, updatedBy: r.updated_by, updatedAt: iso(r.updated_at) } : { text: "", updatedBy: null, updatedAt: null });
  });

  app.put("/:id/notes/:sourceKey", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    const b = (await c.req.json().catch(() => ({}))) as { text?: string };
    const text = str(b.text, 20_000) ?? "";
    const by = c.get("user").name ?? c.get("user").email;
    await db.query(
      `INSERT INTO source_notes (project_id, source_key, text, updated_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id, source_key) DO UPDATE SET text = EXCLUDED.text, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [p.id, c.req.param("sourceKey").slice(0, 200), text, by]);
    return c.json({ text, updatedBy: by, updatedAt: new Date().toISOString() });
  });

  return app;
}
