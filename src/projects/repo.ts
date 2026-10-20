/** Ärendelagret: läsning och DTO:er enligt LAWLA_NEW:s src/api/types.ts. */
import { HTTPException } from "hono/http-exception";
import type { Db } from "../db/db.js";
import { iso } from "../auth/auth.js";
import { buildSnapshot, type ProjectSnapshot } from "../../shared/snapshot.js";

export type ItemKind = "question" | "circumstance" | "legal_issue";
export const ITEM_KINDS: Record<string, ItemKind> = { questions: "question", circumstances: "circumstance", "legal-issues": "legal_issue" };

export interface TextItemDto {
  id: number;
  text: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface ProjectDetailDto {
  id: number;
  title: string | null;
  description: string | null;
  caseOverview: string | null;
  mainPrompt: string | null;
  status: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  questions: TextItemDto[];
  circumstances: TextItemDto[];
  legalIssues: (TextItemDto & { analysisCount: number })[];
  evidence: ProjectEvidenceDto[];
}

export interface ProjectEvidenceDto {
  id: number;
  type: number;
  documentId: number | null;
  chunkId: number | null;
  canonicalReference: string | null;
  displayLabel: string | null;
  annotation: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpandedEvidenceDto extends Omit<ProjectEvidenceDto, "canonicalReference"> {
  content: string | null;
  documentTitle: string | null;
  documentType: string | null;
  chunkIndex: number | null;
  chapter: string | null;
  paragraph: string | null;
  canonicalReference: string | null;
  externalUrl: string | null;
}

interface ProjectRow {
  id: number; owner_id: number; title: string | null; description: string | null; case_overview: string | null; main_prompt: string | null;
  status: number; is_active: boolean; created_at: string; updated_at: string;
}

/** Hämtar ärendet och kontrollerar att användaren får se det (ägare eller admin). */
export async function requireProject(db: Db, projectId: number, user: { id: number; isAdmin: boolean }): Promise<ProjectRow> {
  const row = await db.one<ProjectRow>(`SELECT * FROM projects WHERE id = $1`, [projectId]);
  if (!row || (Number(row.owner_id) !== user.id && !user.isAdmin)) throw new HTTPException(404, { message: "Ärendet finns inte." });
  return row;
}

export async function listProjects(db: Db, user: { id: number; isAdmin: boolean }) {
  const rows = await db.query<ProjectRow & { q: number; c: number; l: number; e: number }>(
    `SELECT p.*,
       (SELECT count(*) FROM project_items i WHERE i.project_id = p.id AND i.kind = 'question')::int AS q,
       (SELECT count(*) FROM project_items i WHERE i.project_id = p.id AND i.kind = 'circumstance')::int AS c,
       (SELECT count(*) FROM project_items i WHERE i.project_id = p.id AND i.kind = 'legal_issue')::int AS l,
       (SELECT count(*) FROM project_evidence e WHERE e.project_id = p.id)::int AS e
     FROM projects p WHERE ($1 OR p.owner_id = $2) ORDER BY p.updated_at DESC`,
    [user.isAdmin, user.id],
  );
  return rows.map((r) => ({
    id: Number(r.id), title: r.title, description: r.description, status: r.status, isActive: r.is_active,
    questionCount: r.q, circumstanceCount: r.c, legalIssueCount: r.l, evidenceCount: r.e, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  }));
}

export async function projectDetail(db: Db, p: ProjectRow): Promise<ProjectDetailDto> {
  const items = await db.query<{ id: number; kind: ItemKind; text: string; sort_order: number; created_at: string; analysis_count: number }>(
    `SELECT i.id, i.kind, i.text, i.sort_order, i.created_at,
            (SELECT count(*) FROM analyses a WHERE a.legal_issue_id = i.id AND a.status = 'done')::int AS analysis_count
     FROM project_items i WHERE i.project_id = $1 ORDER BY i.sort_order, i.id`,
    [p.id],
  );
  const dto = (i: (typeof items)[number]): TextItemDto => ({ id: Number(i.id), text: i.text, sortOrder: i.sort_order, createdAt: iso(i.created_at) });
  return {
    id: Number(p.id), title: p.title, description: p.description, caseOverview: p.case_overview, mainPrompt: p.main_prompt, status: p.status, isActive: p.is_active,
    createdAt: iso(p.created_at), updatedAt: iso(p.updated_at),
    questions: items.filter((i) => i.kind === "question").map(dto),
    circumstances: items.filter((i) => i.kind === "circumstance").map(dto),
    legalIssues: items.filter((i) => i.kind === "legal_issue").map((i) => ({ ...dto(i), analysisCount: i.analysis_count })),
    evidence: (await evidenceList(db, Number(p.id))).map(({ content: _c, documentTitle: _t, documentType: _d, chunkIndex: _i, chapter: _ch, paragraph: _pa, externalUrl: _u, ...rest }) => rest),
  };
}

export async function evidenceList(db: Db, projectId: number): Promise<ExpandedEvidenceDto[]> {
  const rows = await db.query<{
    id: number; type: number; document_id: number | null; chunk_id: number | null; content: string | null; display_label: string | null; annotation: string | null;
    canonical_reference: string | null; external_url: string | null; created_at: string; updated_at: string;
    doc_title: string | null; doc_type: string | null; chunk_content: string | null; chunk_index: number | null; chunk_meta: Record<string, unknown> | null; chunk_label: string | null;
  }>(
    `SELECT e.*, d.title AS doc_title, d.document_type AS doc_type, c.content AS chunk_content, c.chunk_index, c.metadata AS chunk_meta, c.label AS chunk_label
     FROM project_evidence e LEFT JOIN documents d ON d.id = e.document_id LEFT JOIN chunks c ON c.id = e.chunk_id
     WHERE e.project_id = $1 ORDER BY e.created_at, e.id`,
    [projectId],
  );
  return rows.map((r) => ({
    id: Number(r.id), type: r.type, documentId: r.document_id === null ? null : Number(r.document_id), chunkId: r.chunk_id === null ? null : Number(r.chunk_id),
    content: r.content ?? r.chunk_content, displayLabel: r.display_label ?? r.chunk_label, annotation: r.annotation, canonicalReference: r.canonical_reference,
    externalUrl: r.external_url, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), documentTitle: r.doc_title, documentType: r.doc_type,
    chunkIndex: r.chunk_index, chapter: (r.chunk_meta?.chapter as string | null) ?? null, paragraph: (r.chunk_meta?.paragraph as string | null) ?? null,
  }));
}

export async function touch(db: Db, projectId: number): Promise<void> {
  await db.query(`UPDATE projects SET updated_at = now() WHERE id = $1`, [projectId]);
}

/** Ögonblicksbild i samma format som frontendens versionshistorik (shared/snapshot.ts). */
export async function snapshotOf(db: Db, p: ProjectRow): Promise<ProjectSnapshot> {
  const detail = await projectDetail(db, p);
  const evidence = await evidenceList(db, Number(p.id));
  const analyses = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM analyses WHERE project_id = $1 AND legal_issue_id IS NULL AND status = 'done'`, [p.id]);
  return buildSnapshot(detail, evidence, Number(analyses?.n ?? 0), p.main_prompt ?? "");
}
