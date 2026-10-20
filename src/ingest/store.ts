/**
 * Lagrar ett tolkat dokument: dokumentrad, chunkar (med förälder, kontext, embedding) och
 * hänvisningar (referensgrafen). Idempotent per canonical_id – en ny version ersätter chunkarna.
 */
import { createHash } from "node:crypto";
import { toVector, type Db } from "../db/db.js";
import type { Embedder } from "../providers/embeddings.js";
import { extractReferences, type Reference } from "../documents/citations.js";
import type { ChunkDraft } from "./chunker.js";

export interface DocumentDraft {
  title: string;
  source: string;
  sourceUrl: string | null;
  sourceType: string | null;
  documentType: string;
  canonicalId: string | null;
  identifier: string | null;
  status?: "gallande" | "upphavd" | "okand";
  versionDate?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** Råtext/markdown – hash lagras så att oförändrade dokument inte indexeras om. */
  raw: string;
}

export interface StoreResult {
  documentId: number;
  chunks: number;
  references: number;
  skipped: boolean;
}

/** Text som embeddas: kontexten först, sedan innehållet (kontextuell inbäddning). */
export function embeddingText(c: Pick<ChunkDraft, "context" | "content"> & { summary?: string | null }): string {
  return `${c.context}\n${c.content}${c.summary ? `\n${c.summary}` : ""}`;
}

export async function storeDocument(
  db: Db,
  embedder: Embedder,
  doc: DocumentDraft,
  chunks: ChunkDraft[],
  opts: { force?: boolean; log?: (m: string) => void } = {},
): Promise<StoreResult> {
  const log = opts.log ?? (() => {});
  const hash = createHash("sha256").update(doc.raw).digest("hex");

  const existing = doc.canonicalId
    ? await db.one<{ id: number; content_hash: string | null }>(`SELECT id, content_hash FROM documents WHERE canonical_id = $1`, [doc.canonicalId])
    : null;
  if (existing && existing.content_hash === hash && !opts.force) {
    log(`${doc.title}: oförändrad, hoppar över`);
    const n = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM chunks WHERE document_id = $1`, [existing.id]);
    return { documentId: Number(existing.id), chunks: Number(n?.n ?? 0), references: 0, skipped: true };
  }

  log(`${doc.title}: embeddar ${chunks.length} chunkar (${embedder.model})`);
  const vectors = await embedder.embed(chunks.map(embeddingText), "document");

  return db.transaction(async (tx) => {
    let documentId: number;
    if (existing) {
      documentId = Number(existing.id);
      await tx.query(`DELETE FROM chunks WHERE document_id = $1`, [documentId]);
      await tx.query(`DELETE FROM document_references WHERE source_document_id = $1`, [documentId]);
      await tx.query(
        `UPDATE documents SET title=$2, source=$3, source_url=$4, source_type=$5, document_type=$6, identifier=$7, status=$8,
           version_date=$9, tags=$10, metadata=$11, content_hash=$12, updated_at=now() WHERE id=$1`,
        [documentId, doc.title, doc.source, doc.sourceUrl, doc.sourceType, doc.documentType, doc.identifier, doc.status ?? "gallande",
          doc.versionDate ?? null, doc.tags ?? [], JSON.stringify(doc.metadata ?? {}), hash],
      );
    } else {
      const row = await tx.one<{ id: number }>(
        `INSERT INTO documents (title, source, source_url, source_type, document_type, canonical_id, identifier, status, version_date, tags, metadata, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [doc.title, doc.source, doc.sourceUrl, doc.sourceType, doc.documentType, doc.canonicalId, doc.identifier, doc.status ?? "gallande",
          doc.versionDate ?? null, doc.tags ?? [], JSON.stringify(doc.metadata ?? {}), hash],
      );
      documentId = Number(row!.id);
    }

    const ids: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      const parentId = c.parentIndex === null ? null : ids[c.parentIndex] ?? null;
      const row = await tx.one<{ id: number }>(
        `INSERT INTO chunks (document_id, chunk_index, anchor, kind, label, path, parent_id, context, content, metadata, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [documentId, i, c.anchor, c.kind, c.label, c.path, parentId, c.context, c.content, JSON.stringify(c.metadata), toVector(vectors[i]!)],
      );
      ids.push(Number(row!.id));
    }

    // Hänvisningar i texten → referensgrafen. Interna lagrum får dokumentets egen SFS.
    const ownSfs = doc.canonicalId?.startsWith("sfs:") ? doc.canonicalId.slice(4) : null;
    let refCount = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      if (c.kind === "rubrik") continue;
      const refs = dedupe(extractReferences(c.content, ownSfs, typeof c.metadata.chapter === "string" ? c.metadata.chapter : null));
      for (const r of refs) {
        const target = await resolveTarget(tx, r);
        await tx.query(
          `INSERT INTO document_references (source_document_id, source_chunk_id, citation_text, canonical_form, reference_type, target_document_id, target_chunk_id, is_resolved)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [documentId, ids[i], r.text, r.canonical, r.type, target.documentId, target.chunkId, target.documentId !== null],
        );
        refCount++;
      }
    }
    // Andra dokument som hänvisade hit innan detta fanns: koppla ihop dem nu.
    if (doc.canonicalId) {
      await tx.query(
        `UPDATE document_references r SET target_document_id = $1, is_resolved = TRUE,
           target_chunk_id = (SELECT c.id FROM chunks c WHERE c.document_id = $1 AND r.canonical_form = $2 || '#' || c.anchor LIMIT 1)
         WHERE r.target_document_id IS NULL AND (r.canonical_form = $2 OR r.canonical_form LIKE $2 || '#%')`,
        [documentId, doc.canonicalId],
      );
    }
    log(`${doc.title}: ${chunks.length} chunkar, ${refCount} hänvisningar`);
    return { documentId, chunks: chunks.length, references: refCount, skipped: false };
  });
}

function dedupe(refs: Reference[]): Reference[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.canonical) ? false : (seen.add(r.canonical), true)));
}

/** Slår upp ett kanoniskt mål i korpusen: dokument via canonical_id, paragraf via ankare. */
export async function resolveTarget(db: Db, r: Reference): Promise<{ documentId: number | null; chunkId: number | null }> {
  const [docPart, anchor] = r.canonical.split("#") as [string, string | undefined];
  if (docPart.startsWith("law:")) return { documentId: null, chunkId: null };
  const doc = await db.one<{ id: number }>(`SELECT id FROM documents WHERE canonical_id = $1`, [docPart]);
  if (!doc) return { documentId: null, chunkId: null };
  if (!anchor) return { documentId: Number(doc.id), chunkId: null };
  const chunk = await db.one<{ id: number }>(`SELECT id FROM chunks WHERE document_id = $1 AND anchor = $2`, [doc.id, anchor]);
  return { documentId: Number(doc.id), chunkId: chunk ? Number(chunk.id) : null };
}
