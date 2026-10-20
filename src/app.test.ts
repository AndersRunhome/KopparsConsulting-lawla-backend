import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { testDb } from "./db/testdb.js";
import type { Db } from "./db/db.js";
import { hashEmbedder } from "./providers/embeddings.js";
import { createReranker } from "./providers/rerank.js";
import { createLlm } from "./providers/llm.js";
import { lagenToDrafts } from "./ingest/lagen.js";
import { storeDocument } from "./ingest/store.js";

let db: Db;
let app: ReturnType<typeof createApp>;
let token = "";
const json = (method: string, path: string, body?: unknown, auth = true) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...(auth && token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  db = await testDb();
  const cfg = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
  const embedder = hashEmbedder(1024);
  app = createApp({ cfg, db, embedder, reranker: createReranker(cfg), llm: createLlm(cfg) });
  const md = await readFile(new URL("./ingest/fixtures/utll-utdrag.md", import.meta.url), "utf8");
  const { document, chunks } = lagenToDrafts({ uri: "https://lagen.nu/2005:716", label: "SFS 2005:716", title: "Utlänningslag (2005:716)", kind: "Lag", source: "sfs", markdown: md });
  await storeDocument(db, embedder, document, chunks);
});
afterAll(() => db.close());

describe("API", () => {
  it("features är öppen, resten kräver inloggning", async () => {
    expect((await json("GET", "/api/System/features", undefined, false)).status).toBe(200);
    expect((await json("GET", "/api/Projects", undefined, false)).status).toBe(401);
  });

  it("registrering (första användaren blir admin), inloggning och validate", async () => {
    const reg = await json("POST", "/api/Auth/register", { email: "anders@example.com", password: "hemligt123", name: "Anders" });
    expect(reg.status).toBe(200);
    const data = (await reg.json()) as { token: string; user: { isAdmin: boolean } };
    expect(data.user.isAdmin).toBe(true);
    const login = await json("POST", "/api/Auth/login", { email: "Anders@example.com", password: "hemligt123" });
    expect(login.status).toBe(200);
    token = ((await login.json()) as { token: string }).token;
    expect((await json("POST", "/api/Auth/login", { email: "anders@example.com", password: "fel" })).status).toBe(401);
    const v = await json("POST", "/api/Auth/validate", { token }, false);
    expect(((await v.json()) as { email: string }).email).toBe("anders@example.com");
  });

  let projectId = 0;
  it("ärende med frågor, omständigheter, rättsfrågor och huvudprompt", async () => {
    const created = await json("POST", "/api/Projects", { title: "Anknytning – test" });
    expect(created.status).toBe(201);
    projectId = ((await created.json()) as { id: number }).id;
    expect((await json("POST", `/api/Projects/${projectId}/questions`, { text: "Kan klienten få uppehållstillstånd?" })).status).toBe(201);
    expect((await json("POST", `/api/Projects/${projectId}/circumstances`, { text: "Klienten ska gifta sig med en person bosatt i Sverige." })).status).toBe(201);
    const issue = await json("POST", `/api/Projects/${projectId}/legal-issues`, { text: "Förutsättningar för uppehållstillstånd vid avsikt att gifta sig" });
    expect(((await issue.json()) as { analysisCount: number }).analysisCount).toBe(0);
    const upd = await json("PUT", `/api/Projects/${projectId}`, { title: "Anknytning – test", description: null, caseOverview: "Bakgrund.", status: 1, mainPrompt: "Var kortfattad." });
    const detail = (await upd.json()) as { mainPrompt: string; status: number; questions: unknown[]; legalIssues: unknown[] };
    expect(detail).toMatchObject({ mainPrompt: "Var kortfattad.", status: 1 });
    expect(detail.questions).toHaveLength(1);
    expect(detail.legalIssues).toHaveLength(1);
  });

  it("sök i korpusen och lägg till träffen som rättskälla", async () => {
    const res = await json("POST", "/api/Search", { query: "gifta sig med någon som bor i Sverige", topK: 3 });
    expect(res.status).toBe(200);
    const hit = ((await res.json()) as { hits: { chunkId: number; anchor: string; documentId: number }[] }).hits.find((h) => h.anchor === "K5P16c");
    expect(hit).toBeDefined();
    const ev = await json("POST", `/api/Projects/${projectId}/evidence`, { chunkId: hit!.chunkId, displayLabel: "5 kap. 16 c § UtlL", annotation: "Seriöst förhållande" });
    expect(ev.status).toBe(201);
    expect((await ev.json()) as object).toMatchObject({ documentId: hit!.documentId, chunkId: hit!.chunkId, canonicalReference: "sfs:2005:716#K5P16c", type: 0 });
    const expanded = (await (await json("GET", `/api/Projects/${projectId}/evidence/expanded`)).json()) as { content: string; documentType: string; chapter: string; paragraph: string; id: number }[];
    expect(expanded[0]).toMatchObject({ documentType: "lag", chapter: "5", paragraph: "16 c" });
    expect(expanded[0]!.content).toContain("gifta sig");
    // PUT på rättskälla (saknades i gamla backendet)
    const put = await json("PUT", `/api/Projects/${projectId}/evidence/${expanded[0]!.id}`, { displayLabel: "16 c § UtlL", annotation: null });
    expect(((await put.json()) as { displayLabel: string }).displayLabel).toBe("16 c § UtlL");
    // Egen text utan dokument accepteras
    expect((await json("POST", `/api/Projects/${projectId}/evidence`, { content: "Specialkommentar …", displayLabel: "Prop. 2005/06:77", externalUrl: "https://lagen.nu/prop/2005/06:77" })).status).toBe(201);
  });

  it("exakt uppslag av lagrum i korpusen", async () => {
    const r = (await (await json("GET", "/api/Lagrum/resolve?q=5%20kap.%2016%20c%20%C2%A7%20UtlL")).json()) as { status: string; label: string };
    expect(r).toMatchObject({ status: "found", label: "5 kap. 16 c §" });
    expect(((await (await json("GET", "/api/Lagrum/resolve?q=99%20%C2%A7%20UtlL")).json()) as { status: string }).status).toBe("invalid");
  });

  it("versioner: spara, dedupe och hämta ögonblicksbild", async () => {
    const v1 = (await (await json("POST", `/api/Projects/${projectId}/versions`, { label: "Första", trigger: "manual" })).json()) as { version: { id: number; counts: { evidence: number } }; created: boolean };
    expect(v1.created).toBe(true);
    expect(v1.version.counts.evidence).toBe(2);
    const v2 = (await (await json("POST", `/api/Projects/${projectId}/versions`, { trigger: "analysis" })).json()) as { created: boolean };
    expect(v2.created).toBe(false);
    const detail = (await (await json("GET", `/api/Projects/${projectId}/versions/${v1.version.id}`)).json()) as { snapshot: { mainPrompt: string } };
    expect(detail.snapshot.mainPrompt).toBe("Var kortfattad.");
  });

  it("delning via länk: skapa, läsa utan inloggning, återkalla", async () => {
    const created = await json("POST", `/api/Projects/${projectId}/shares`, { title: "Rapport", markdown: "# Rapport\nText", evidence: [], expiresInDays: 7, label: "Till klienten" });
    expect(created.status).toBe(201);
    const { share } = (await created.json()) as { share: { token: string; expiresAt: string } };
    const open = await json("GET", `/api/shares/${share.token}`, undefined, false);
    expect(open.status).toBe(200);
    expect(open.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(((await open.json()) as { markdown: string }).markdown).toBe("# Rapport\nText");
    expect((await json("DELETE", `/api/Projects/${projectId}/shares/${share.token}`)).status).toBe(204);
    expect((await json("GET", `/api/shares/${share.token}`, undefined, false)).status).toBe(404);
  });

  it("anteckningar, feedback och analys utan LLM ger 503", async () => {
    await json("PUT", `/api/Projects/${projectId}/notes/l%2F2005:716`, { text: "Kolla 18 §." });
    expect(((await (await json("GET", `/api/Projects/${projectId}/notes/l%2F2005:716`)).json()) as { text: string }).text).toBe("Kolla 18 §.");
    expect((await json("POST", "/api/feedback", { description: "Testar", path: "/", priority: "low" })).status).toBe(204);
    expect((await json("POST", `/api/Projects/${projectId}/analyses`, {})).status).toBe(503);
  });

  it("dokument-API:t exponerar korpusen", async () => {
    const docs = (await (await json("GET", "/api/Documents?documentType=lag")).json()) as { id: number; chunkCount: number; canonicalId: string }[];
    expect(docs[0]).toMatchObject({ canonicalId: "sfs:2005:716" });
    expect(docs[0]!.chunkCount).toBeGreaterThan(5);
    const toc = (await (await json("GET", `/api/Documents/${docs[0]!.id}/toc`)).json()) as { displayLabel: string }[];
    expect(toc.map((t) => t.displayLabel)).toContain("5 kap. 16 c §");
    const out = (await (await json("GET", `/api/References/document/${docs[0]!.id}/outgoing`)).json()) as { canonicalForm: string }[];
    expect(out.map((r) => r.canonicalForm)).toContain("mig:2017:3");
  });

  it("en annan användare ser inte ärendet", async () => {
    await json("POST", "/api/Auth/register", { email: "annan@example.com", password: "hemligt123", name: "Annan" }, false);
    const login = (await (await json("POST", "/api/Auth/login", { email: "annan@example.com", password: "hemligt123" }, false)).json()) as { token: string };
    const res = await app.request(`/api/Projects/${projectId}`, { headers: { Authorization: `Bearer ${login.token}` } });
    expect(res.status).toBe(404);
  });
});
