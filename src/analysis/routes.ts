/** Analyser: delanalys, samlad analys (SSE) och Fråga Lawla (/api/Rag/query-stream). */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { AppContext, Env } from "../app.js";
import { iso } from "../auth/auth.js";
import { evidenceList, projectDetail, requireProject, snapshotOf } from "../projects/repo.js";
import { snapshotHash } from "../../shared/snapshot.js";
import { SYSTEM_PROMPT, buildAnalysisPrompt, extractCitations, gatherContext, renderContext, streamLlm, type Citation, type ContextSource } from "./engine.js";

const id = (v: string | undefined) => Number(v);

export function analysisRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const { db, llm } = ctx;

  const analysisDto = (r: Record<string, unknown>) => ({
    id: Number(r.id), legalIssueId: r.legal_issue_id === null ? null : Number(r.legal_issue_id), outputContent: r.output_content, citations: r.citations,
    inputSummary: r.input_summary, model: r.model, createdAt: iso(r.created_at),
  });

  app.get("/:id/legal-issues/:iid/analyses", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    const rows = await db.query(`SELECT * FROM analyses WHERE project_id=$1 AND legal_issue_id=$2 AND status='done' ORDER BY created_at DESC`, [p.id, id(c.req.param("iid"))]);
    return c.json(rows.map(analysisDto));
  });

  app.get("/:id/analyses", async (c) => {
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    const rows = await db.query(`SELECT * FROM analyses WHERE project_id=$1 AND legal_issue_id IS NULL AND status='done' ORDER BY created_at DESC`, [p.id]);
    return c.json(rows.map(analysisDto));
  });

  /** Gemensam körning för del- och samlad analys. Strömmar SSE om klienten ber om det. */
  const run = async (c: Context<Env>, legalIssueId: number | null) => {
    if (!llm.enabled) throw new HTTPException(503, { message: "Ingen språkmodell är konfigurerad." });
    const p = await requireProject(db, id(c.req.param("id")), c.get("user"));
    const body = (await c.req.json().catch(() => ({}))) as { instructions?: string };
    const instructions = body.instructions?.trim() || p.main_prompt || null;
    const project = await projectDetail(db, p);
    const issue = legalIssueId ? project.legalIssues.find((l) => l.id === legalIssueId) : null;
    if (legalIssueId && !issue) throw new HTTPException(404, { message: "Rättsfrågan finns inte." });

    // Version inför analysen (dedupe på hash), som Workern gjorde.
    const snapshot = await snapshotOf(db, p);
    const hash = snapshotHash(snapshot);
    const latest = await db.one<{ hash: string }>(`SELECT hash FROM project_versions WHERE project_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`, [p.id]);
    if (!latest || latest.hash !== hash) await db.query(`INSERT INTO project_versions (project_id, trigger, hash, snapshot, created_by) VALUES ($1,'analysis',$2,$3,$4)`, [p.id, hash, JSON.stringify(snapshot), c.get("user").id]);

    const evidence = await evidenceList(db, Number(p.id));
    const queries = issue ? [issue.text ?? ""] : [...project.legalIssues.map((l) => l.text ?? ""), ...project.questions.map((q) => q.text ?? "")];
    const sources = await gatherContext(db, ctx.embedder, ctx.reranker, evidence, queries);
    const prompt = buildAnalysisPrompt(project, sources, { legalIssue: issue?.text, instructions });
    const inputSummary = { questionCount: project.questions.length, circumstanceCount: project.circumstances.length, legalIssueCount: project.legalIssues.length, evidenceCount: evidence.length, corpusSources: sources.length - evidence.length };
    const row = await db.one<{ id: number }>(`INSERT INTO analyses (project_id, legal_issue_id, status, model, input_summary) VALUES ($1,$2,'running',$3,$4) RETURNING id`, [p.id, legalIssueId, llm.model, JSON.stringify(inputSummary)]);
    const analysisId = Number(row!.id);
    const t0 = Date.now();

    const finish = async (raw: string) => {
      const { text, citations } = await extractCitations(db, raw, sources);
      await db.query(`UPDATE analyses SET output_content=$2, citations=$3, status='done' WHERE id=$1`, [analysisId, text, JSON.stringify(citations)]);
      await db.query(`UPDATE projects SET updated_at = now() WHERE id = $1`, [p.id]);
      return { text, citations };
    };
    const fail = async (err: unknown) => {
      await db.query(`UPDATE analyses SET status='error', output_content=$2 WHERE id=$1`, [analysisId, String((err as Error).message ?? err).slice(0, 2000)]);
    };

    const wantsStream = (c.req.header("Accept") ?? "").includes("text/event-stream");
    if (!wantsStream) {
      try {
        const raw = await streamLlm(llm, prompt, () => {});
        const { text, citations } = await finish(raw);
        return c.json({ id: analysisId, legalIssueId, outputContent: text, citations, inputSummary, model: llm.model, createdAt: new Date().toISOString() });
      } catch (err) {
        await fail(err);
        throw new HTTPException(502, { message: `Analysen misslyckades: ${(err as Error).message}` });
      }
    }
    return streamSSE(c, async (stream) => {
      const send = (data: unknown) => stream.writeSSE({ data: JSON.stringify(data) });
      await send({ type: "status", content: issue ? "Analyserar rättsfrågan…" : "Gör samlad analys…" });
      await send({ type: "sources", sources: sourcesDto(sources) });
      try {
        let buffer = "";
        const raw = await streamLlm(llm, prompt, (t) => {
          buffer += t;
          // Nycklar [[k12]] visas inte i den strömmade texten; skicka fram till sista säkra tecken.
          const safe = buffer.lastIndexOf("[[");
          const emit = safe === -1 ? buffer : buffer.slice(0, safe);
          if (emit) {
            buffer = buffer.slice(emit.length);
            void send({ type: "content", content: emit.replace(/\s?\[\[[ke]\d+\]\]/g, "") });
          }
        });
        if (buffer) await send({ type: "content", content: buffer.replace(/\s?\[\[[ke]\d+\]\]/g, "") });
        const { text, citations } = await finish(raw);
        await send({ type: "done", analysisContent: text, analysisId, citations: citations satisfies Citation[], processingTimeMs: Date.now() - t0 });
      } catch (err) {
        await fail(err);
        await send({ type: "error", error: `Analysen misslyckades: ${(err as Error).message}` });
      }
    });
  };

  app.post("/:id/legal-issues/:iid/analyze", (c) => run(c, id(c.req.param("iid"))));
  app.post("/:id/analyses", (c) => run(c, null));

  return app;
}

function sourcesDto(sources: ContextSource[]) {
  const byDoc = new Map<string, { documentId: number | null; title: string; documentType: string | null; relevanceScore: number; passages: { chunkId: number | null; text: string; similarityScore: number; displayLabel: string }[] }>();
  for (const s of sources) {
    const k = String(s.documentId ?? `e${s.evidenceId}`);
    const d = byDoc.get(k) ?? { documentId: s.documentId, title: s.documentTitle ?? s.label ?? "Egen källa", documentType: null, relevanceScore: 1, passages: [] };
    d.passages.push({ chunkId: s.chunkId, text: s.content.slice(0, 600), similarityScore: 1, displayLabel: s.label ?? "" });
    byDoc.set(k, d);
  }
  return [...byDoc.values()];
}

/** Fråga Lawla: /api/Rag/query-stream – fråga + ev. ärendekontext, svar strömmat med källor. */
export function ragRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const { db, llm } = ctx;
  app.post("/Rag/query-stream", async (c) => {
    if (!llm.enabled) throw new HTTPException(503, { message: "Ingen språkmodell är konfigurerad." });
    const b = (await c.req.json().catch(() => ({}))) as { question?: string; topK?: number; documentIds?: number[] | null; projectId?: number; conversationHistory?: { role: "user" | "assistant"; content: string }[] | null };
    const question = (b.question ?? "").trim().slice(0, 4000);
    if (!question) throw new HTTPException(400, { message: "Fråga saknas." });
    const evidence = b.projectId ? await evidenceList(db, Number((await requireProject(db, Number(b.projectId), c.get("user"))).id)) : [];
    const sources = await gatherContext(db, ctx.embedder, ctx.reranker, evidence, [question], Math.min(20, Math.max(3, Number(b.topK ?? 8))));
    const history = (b.conversationHistory ?? []).slice(-10).map((m) => ({ role: m.role, content: String(m.content).slice(0, 8000) }));
    const t0 = Date.now();
    return streamSSE(c, async (stream) => {
      const send = (data: unknown) => stream.writeSSE({ data: JSON.stringify(data) });
      await send({ type: "status", content: "Söker i rättskällorna…" });
      await send({ type: "sources", sources: sourcesDto(sources) });
      try {
        let raw = "";
        await llm.stream(
          { system: SYSTEM_PROMPT, messages: [...history, { role: "user", content: `## Underlag\n${renderContext(sources, 40_000)}\n\n## Fråga\n${question}` }], maxTokens: 3000 },
          (t) => {
            raw += t;
            void send({ type: "content", content: t.replace(/\s?\[\[[ke]\d+\]\]/g, "") });
          },
        );
        const { text, citations } = await extractCitations(db, raw, sources);
        await send({ type: "done", analysisContent: text, citations, processingTimeMs: Date.now() - t0 });
      } catch (err) {
        await send({ type: "error", error: (err as Error).message });
      }
    });
  });
  return app;
}
