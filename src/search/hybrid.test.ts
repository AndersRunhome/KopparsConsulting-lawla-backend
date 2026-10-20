import { readFile } from "node:fs/promises";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { testDb } from "../db/testdb.js";
import type { Db } from "../db/db.js";
import { hashEmbedder } from "../providers/embeddings.js";
import { createReranker } from "../providers/rerank.js";
import { lagenToDrafts } from "../ingest/lagen.js";
import { storeDocument } from "../ingest/store.js";
import { hybridSearch } from "./hybrid.js";

const embedder = hashEmbedder(1024);
const reranker = createReranker({ RERANK_URL: "", RERANK_API_KEY: "", RERANK_MODEL: "" });
let db: Db;

beforeAll(async () => {
  db = await testDb();
  const md = await readFile(new URL("../ingest/fixtures/utll-utdrag.md", import.meta.url), "utf8");
  const { document, chunks } = lagenToDrafts({ uri: "https://lagen.nu/2005:716", label: "SFS 2005:716", title: "Utlänningslag (2005:716)", kind: "Lag", source: "sfs", markdown: md });
  const r = await storeDocument(db, embedder, document, chunks);
  expect(r.skipped).toBe(false);
});
afterAll(() => db.close());

describe("ingest från lagen.nu", () => {
  it("ger paragrafer med sökväg, kontext och förälder", async () => {
    const row = await db.one<{ label: string; path: string[]; context: string; parent_label: string | null; kind: string }>(
      `SELECT c.label, c.path, c.context, p.label AS parent_label, c.kind FROM chunks c LEFT JOIN chunks p ON p.id = c.parent_id WHERE c.anchor = 'K5P16c'`,
    );
    expect(row).toMatchObject({ label: "5 kap. 16 c §", kind: "paragraf", parent_label: "Uppehållstillstånd på grund av anknytning" });
    expect(row!.path).toEqual(["5 kap. Uppehållstillstånd", "Uppehållstillstånd på grund av anknytning"]);
    expect(row!.context).toBe("Utlänningslag (2005:716) › 5 kap. Uppehållstillstånd › Uppehållstillstånd på grund av anknytning › 5 kap. 16 c §");
  });

  it("bygger referensgrafen: interna lagrum löses, externa hänvisningar sparas olösta", async () => {
    const refs = await db.query<{ canonical_form: string; is_resolved: boolean; target_anchor: string | null }>(
      `SELECT r.canonical_form, r.is_resolved, t.anchor AS target_anchor FROM document_references r
         JOIN chunks s ON s.id = r.source_chunk_id LEFT JOIN chunks t ON t.id = r.target_chunk_id
        WHERE s.anchor = 'K5P18' ORDER BY r.canonical_form`,
    );
    expect(refs).toContainEqual({ canonical_form: "mig:2017:3", is_resolved: false, target_anchor: null });
    expect(refs).toContainEqual({ canonical_form: "prop:2005/06:77", is_resolved: false, target_anchor: null });
    expect(refs.find((r) => r.canonical_form === "sfs:2005:716#K21P2")).toMatchObject({ is_resolved: true, target_anchor: null });
  });

  it("indexerar inte om ett oförändrat dokument", async () => {
    const md = await readFile(new URL("../ingest/fixtures/utll-utdrag.md", import.meta.url), "utf8");
    const { document, chunks } = lagenToDrafts({ uri: "https://lagen.nu/2005:716", label: "SFS 2005:716", title: "Utlänningslag (2005:716)", markdown: md });
    expect((await storeDocument(db, embedder, document, chunks)).skipped).toBe(true);
  });
});

describe("hybridsök", () => {
  it("exakt lagrum går först", async () => {
    const r = await hybridSearch(db, embedder, reranker, "5 kap. 16 c § UtlL");
    expect(r.understood.reference?.canonical).toBe("sfs:2005:716#K5P16c");
    expect(r.hits[0]).toMatchObject({ anchor: "K5P16c", signals: { exact: true } });
  });

  it("vardagsspråk träffar rätt paragraf utan exakt formulering", async () => {
    const r = await hybridSearch(db, embedder, reranker, "kan jag få tillstånd om jag ska gifta mig med någon som bor i Sverige?");
    expect(r.hits.slice(0, 3).map((h) => h.anchor)).toContain("K5P16c");
    expect(r.hits[0]!.signals.fulltext ?? r.hits[0]!.signals.vector).toBeGreaterThan(0);
  });

  it("synonymer: 'asyl' hittar definitionen av flykting", async () => {
    const r = await hybridSearch(db, embedder, reranker, "vem räknas som flykting vid asyl");
    expect(r.hits.slice(0, 3).map((h) => h.anchor)).toContain("K4P1");
  });

  it("filter på dokumenttyp och relaterade chunkar via grafen", async () => {
    const r = await hybridSearch(db, embedder, reranker, "måste den jag flyttar till kunna försörja mig och ha bostad?", { documentTypes: ["lag"] });
    const hit = r.hits.find((h) => h.anchor === "K5P3b");
    expect(hit).toBeDefined();
    // 3 b § hänvisar till "3 eller 3 a §" → grafen pekar på 5 kap. 3 §.
    expect(hit!.related?.some((x) => x.label === "5 kap. 3 §" && x.referenceType === "lagrum")).toBe(true);
    expect((await hybridSearch(db, embedder, reranker, "flykting", { documentTypes: ["proposition"] })).hits).toHaveLength(0);
  });
});
