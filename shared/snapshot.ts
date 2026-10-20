/**
 * Versionshistorik: en ögonblicksbild av ett ärende (rättsutredning).
 * Delas mellan Workern (som skapar och lagrar versioner) och frontenden (som visar och jämför dem).
 * Inga DOM- eller Worker-beroenden här.
 */

export interface SnapshotItem {
  id: number;
  text: string;
}

export interface SnapshotEvidence {
  id: number;
  label: string;
  documentTitle: string | null;
  documentId: number | null;
  chunkId: number | null;
  annotation: string | null;
}

export interface ProjectSnapshot {
  title: string;
  description: string;
  caseOverview: string;
  status: number;
  questions: SnapshotItem[];
  circumstances: SnapshotItem[];
  legalIssues: (SnapshotItem & { analysisCount: number })[];
  evidence: SnapshotEvidence[];
  /** Antal samlade analyser som fanns vid tillfället. */
  analysisCount: number;
  /** Huvudprompt (juristens stående instruktion till Lawla). Saknas i versioner sparade före funktionen. */
  mainPrompt?: string;
}

export type VersionTrigger = "manual" | "analysis";

export interface VersionSummary {
  id: number;
  createdAt: string;
  label: string | null;
  trigger: VersionTrigger;
  counts: { questions: number; circumstances: number; legalIssues: number; evidence: number; analyses: number };
}

export interface VersionDetail extends VersionSummary {
  snapshot: ProjectSnapshot;
}

/** Minsta gemensamma form av det backend returnerar – används av både Worker och frontend. */
interface ProjectLike {
  title?: string | null;
  description?: string | null;
  caseOverview?: string | null;
  status?: number;
  questions?: { id: number; text: string | null; sortOrder?: number }[] | null;
  circumstances?: { id: number; text: string | null; sortOrder?: number }[] | null;
  legalIssues?: { id: number; text: string | null; sortOrder?: number; analysisCount?: number }[] | null;
}

interface EvidenceLike {
  id: number;
  displayLabel?: string | null;
  documentTitle?: string | null;
  documentId?: number | null;
  chunkId?: number | null;
  annotation?: string | null;
}

function items<T extends { id: number; text: string | null; sortOrder?: number }>(list: T[] | null | undefined): T[] {
  return [...(list ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
}

export function buildSnapshot(project: ProjectLike, evidence: EvidenceLike[], analysisCount: number, mainPrompt = ""): ProjectSnapshot {
  return {
    title: project.title ?? "",
    description: project.description ?? "",
    caseOverview: project.caseOverview ?? "",
    status: project.status ?? 0,
    questions: items(project.questions).map((q) => ({ id: q.id, text: q.text ?? "" })),
    circumstances: items(project.circumstances).map((c) => ({ id: c.id, text: c.text ?? "" })),
    legalIssues: items(project.legalIssues).map((l) => ({ id: l.id, text: l.text ?? "", analysisCount: l.analysisCount ?? 0 })),
    evidence: [...evidence]
      .sort((a, b) => a.id - b.id)
      .map((e) => ({
        id: e.id,
        label: e.displayLabel ?? "",
        documentTitle: e.documentTitle ?? null,
        documentId: e.documentId ?? null,
        chunkId: e.chunkId ?? null,
        annotation: e.annotation ?? null,
      })),
    analysisCount,
    mainPrompt,
  };
}

export function snapshotCounts(s: ProjectSnapshot): VersionSummary["counts"] {
  return {
    questions: s.questions.length,
    circumstances: s.circumstances.length,
    legalIssues: s.legalIssues.length,
    evidence: s.evidence.length,
    analyses: s.analysisCount,
  };
}

/* ─── Jämförelse mellan två versioner ───────────────────────────────── */

export interface FieldChange {
  field: "title" | "description" | "caseOverview" | "mainPrompt";
  label: string;
  before: string;
  after: string;
}

export interface ListChange {
  kind: "questions" | "circumstances" | "legalIssues" | "evidence";
  label: string;
  added: string[];
  removed: string[];
  changed: { before: string; after: string }[];
}

export interface SnapshotDiff {
  fields: FieldChange[];
  lists: ListChange[];
  analyses: { before: number; after: number };
  /** Totalt antal ändringar. */
  total: number;
}

const FIELD_LABELS: Record<FieldChange["field"], string> = {
  title: "Namn på ärendet",
  description: "Kort beskrivning",
  caseOverview: "Ärendebeskrivning",
  mainPrompt: "Instruktion till Lawla",
};

const LIST_LABELS: Record<ListChange["kind"], string> = {
  questions: "Klientens frågor",
  circumstances: "Omständigheter",
  legalIssues: "Rättsfrågor",
  evidence: "Rättskällor",
};

function evidenceText(e: SnapshotEvidence): string {
  const base = e.label || e.documentTitle || `Källa ${e.id}`;
  return e.annotation ? `${base} — ${e.annotation}` : base;
}

function diffList(kind: ListChange["kind"], before: { id: number; text: string }[], after: { id: number; text: string }[]): ListChange {
  const b = new Map(before.map((i) => [i.id, i.text]));
  const a = new Map(after.map((i) => [i.id, i.text]));
  const change: ListChange = { kind, label: LIST_LABELS[kind], added: [], removed: [], changed: [] };
  for (const [id, text] of a) {
    if (!b.has(id)) change.added.push(text);
    else if (b.get(id) !== text) change.changed.push({ before: b.get(id)!, after: text });
  }
  for (const [id, text] of b) if (!a.has(id)) change.removed.push(text);
  return change;
}

export function diffSnapshots(before: ProjectSnapshot, after: ProjectSnapshot): SnapshotDiff {
  const fields: FieldChange[] = [];
  for (const field of ["title", "description", "caseOverview", "mainPrompt"] as const) {
    const b = before[field] ?? "";
    const a = after[field] ?? "";
    if (b !== a) fields.push({ field, label: FIELD_LABELS[field], before: b, after: a });
  }
  const lists = [
    diffList("questions", before.questions, after.questions),
    diffList("circumstances", before.circumstances, after.circumstances),
    diffList("legalIssues", before.legalIssues, after.legalIssues),
    diffList(
      "evidence",
      before.evidence.map((e) => ({ id: e.id, text: evidenceText(e) })),
      after.evidence.map((e) => ({ id: e.id, text: evidenceText(e) })),
    ),
  ].filter((l) => l.added.length || l.removed.length || l.changed.length);

  const analyses = { before: before.analysisCount, after: after.analysisCount };
  const total =
    fields.length +
    lists.reduce((n, l) => n + l.added.length + l.removed.length + l.changed.length, 0) +
    (analyses.before !== analyses.after ? 1 : 0);
  return { fields, lists, analyses, total };
}

/** Stabil hash av en ögonblicksbild (FNV-1a), för att slippa spara identiska versioner. */
export function snapshotHash(s: ProjectSnapshot): string {
  const str = JSON.stringify(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + str.length.toString(16);
}
