/**
 * Typer för det som Workern lagrar utöver backend: ärendets huvudprompt och
 * delningslänkar till rapporten. Delas av Worker och frontend, inga DOM-beroenden.
 */

/* ─── Huvudprompt ────────────────────────────────────────────────────── */

export const MAIN_PROMPT_MAX = 4000;

export interface ProjectSettings {
  /** Juristens stående instruktion till Lawla för det här ärendet (tom sträng = ingen). */
  mainPrompt: string;
  updatedAt: string | null;
}

/* ─── Delningslänkar ─────────────────────────────────────────────────── */

/** Längsta giltighetstid som går att välja, i dagar. */
export const SHARE_MAX_DAYS = 365;
/** Största rapport som får delas (tecken markdown). */
export const SHARE_MARKDOWN_MAX = 400_000;
/** Högst så många aktiva länkar per ärende. */
export const SHARE_MAX_PER_PROJECT = 50;

/** Rättskälla som följer med den delade rapporten, så att hänvisningar kan visas utan inloggning. */
export interface SharedEvidence {
  id: number;
  displayLabel: string | null;
  documentTitle: string | null;
  content: string | null;
  annotation: string | null;
  chapter: string | null;
  paragraph: string | null;
}

export interface CreateShareRequest {
  /** Rapportens titel. */
  title: string;
  /** Rapporten som markdown, exakt som den såg ut när länken skapades. */
  markdown: string;
  evidence: SharedEvidence[];
  /** Egen etikett, t.ex. "Till klienten" (valfri). */
  label?: string | null;
  /** Giltighetstid i dagar; utelämnad eller 0 = tills vidare. */
  expiresInDays?: number | null;
}

export interface ShareSummary {
  token: string;
  label: string | null;
  title: string;
  createdAt: string;
  createdBy: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  views: number;
}

/** Det mottagaren ser – inga ärende- eller användar-id:n. */
export interface SharedReport {
  title: string;
  markdown: string;
  evidence: SharedEvidence[];
  createdAt: string;
  createdBy: string | null;
  expiresAt: string | null;
}

export function shareStatus(s: Pick<ShareSummary, "expiresAt" | "revokedAt">, now = new Date()): "active" | "expired" | "revoked" {
  if (s.revokedAt) return "revoked";
  if (s.expiresAt && new Date(s.expiresAt).getTime() <= now.getTime()) return "expired";
  return "active";
}

export function shareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/delad/${token}`;
}
