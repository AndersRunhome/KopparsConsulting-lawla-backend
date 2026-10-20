# Lawla backend – arkitektur

*Version 1, 2026-10-20. Ersätter plattformen på lawla.berge.tech. Inget migreras därifrån.*

## 1. Mål och ramar

- **Ett backend som äger allt**: ärenden, underlag, analyser, versioner, delningar, anteckningar,
  huvudprompt, feedback – och en egen korpus av rättskällor med riktigt sökindex.
- **Samma API-kontrakt som frontenden redan använder.** LAWLA_NEW pratar via en Worker-proxy
  (`/api/*`). Det nya backendet uppfyller samma endpoints och DTO:er (se `docs/API.md`), så
  cutover är att byta `BACKEND_URL` i Workern. Det som Workern i dag lagrar själv i D1
  (historik, inställningar, delningar, anteckningar) får egna endpoints här och kan sedan tas bort ur Workern.
- **Portabelt från dag ett.** Allt ska kunna köras på en server som kunden äger. Inget
  leverantörsspecifikt i koden; varje beroende går via en standardiserad yta (se §3).
- **Svensk juridik i fokus.** Chunkning, sökning och citeringar bygger på rättskällornas
  struktur (kapitel/paragraf/stycke, propositionens författningskommentar, domskäl), inte på teckenantal.

## 2. Lager

```
┌───────────────────────── Frontend (LAWLA_NEW, Cloudflare) ─────────────────────────┐
│ Worker-BFF: httpOnly-cookie, CSRF, vitlista  ──►  BACKEND_URL                     │
└───────────────────────────────────────────────┬────────────────────────────────────┘
                                                │ HTTPS (Bearer-token)
┌───────────────────────────────────────────────▼────────────────────────────────────┐
│ API (Node 22 + Hono, en Docker-container)                                          │
│  ├─ auth        JWT, Google OAuth, roller                                           │
│  ├─ projects    ärenden, frågor, omständigheter, rättsfrågor, underlag, versioner,  │
│  │              delningar, anteckningar, huvudprompt, feedback                     │
│  ├─ documents   korpusen: dokument, avsnitt (chunks), innehållsförteckning,        │
│  │              referenser (graf)                                                   │
│  ├─ search      hybridsök: frågeförståelse → fulltext + vektor → RRF → rerank → expand │
│  ├─ analysis    del-/samlad analys och Fråga Lawla, SSE, strukturerade citeringar │
│  └─ ingest      hämta → tolka → chunka → berika → embedda (kö i Postgres, pg-boss) │
└───────────┬──────────────────┬────────────────────┬────────────────────────────────┘
            │                  │                    │
   Postgres 16             Objektlager (S3)    Modelltjänster (HTTP)
   + pgvector + tsvector   rådokument          embeddings, reranker, LLM
```

## 3. Drift – samma kod i molnet och hos kunden

| Behov | Nu (Koppars) | Hos kunden | Yta i koden |
|---|---|---|---|
| API + ingest-worker | Docker-container på Cloudflare Containers / Fly / Hetzner | Samma container | Node, inga plattforms-API:er |
| Databas, fulltext, vektor, graf, kö | Managed Postgres (Supabase/Neon) | Postgres 16 + pgvector på servern | `DATABASE_URL` |
| Rådokument | R2 | MinIO | S3-API (`S3_*`) |
| Embeddings | bge-m3 via hostad endpoint | bge-m3 i TEI-container (CPU räcker) | OpenAI-kompatibel `/v1/embeddings` (`EMBEDDINGS_URL`, `EMBEDDINGS_MODEL`) |
| Reranking | bge-reranker-v2-m3 via hostad endpoint | Samma modell i TEI | `/rerank` (`RERANK_URL`) |
| LLM | Anthropic API | Anthropic, Bedrock eller Azure efter kundens krav | Provider-adapter (`LLM_PROVIDER`) |
| Auth | Egen (JWT + Google OAuth) | Samma | – |

`docker-compose.yml` beskriver hela miljön (api, worker, postgres, minio, tei). Molndriften är
samma delar utpekade via miljövariabler. Det enda som inte blir helt "hos kunden" är språkmodellen
för analyserna – det är ett val kunden gör när det blir aktuellt.

Beslut som följer av portabilitetskravet: ingen Supabase Auth, inga Cloudflare Queues/Workflows/
Workers AI som hårda beroenden, ingen Hyperdrive. Tester körs mot **PGlite** (Postgres i Node
med pgvector), så hela sök- och ingestlogiken kan testas utan Docker.

## 4. Datamodell (Postgres)

### Ärendelagret
- `users` – id, email, name, password_hash, role (`member`/`admin`), google_sub, is_active.
- `projects` – ärende: title, description, case_overview, status (0–3), **main_prompt**, owner_id.
- `project_questions`, `project_circumstances`, `project_legal_issues` – text, sort_order.
- `project_evidence` – underlag: type, document_id?, chunk_id?, content (markerad text), display_label,
  annotation, canonical_reference, external_url, char_start/char_end, updated_at.
- `issue_analyses`, `project_analyses` – output_content (markdown), **citations (jsonb)**, model, input_summary.
- `project_versions` – ögonblicksbilder (`shared/snapshot.ts`-format), label, trigger, hash.
- `report_shares` – token, frozen markdown + källor, expires_at, revoked_at, view_count.
- `source_notes` – anteckning per källa (sourceKey) och ärende.
- `feedback` – description, path, priority, user_agent, viewport, status.

### Korpuslagret
- `documents` – title, source (`lagen.nu`/`riksdagen`/`domstol`/`upload`), source_url, document_type
  (`lag`/`forordning`/`proposition`/`sou`/`ds`/`betankande`/`rattsfall`/`doktrin`/`ovrigt`),
  canonical_id (`sfs:2005:716`, `prop:2005/06:77`, `nja:2015:899`), identifier, status
  (`gallande`/`upphavd`), version_date, raw_key (S3), metadata jsonb.
- `chunks` – document_id, chunk_index, **anchor** (`K5P16c`, `P36`, `K12-A3`…), **path**
  (`["5 kap. Uppehållstillstånd", "16 c §"]`), kind (`paragraf`/`avsnitt`/`kommentar`/`domskal`/`rubrik`),
  label (`5 kap. 16 c §`), parent_id, content, **context** (sökvägen i klartext som prefix vid embedding),
  summary (LLM-genererad, vardagsspråk), keywords text[], metadata jsonb,
  `tsv` (tsvector, svensk konfiguration, genererad kolumn över context+content+summary+keywords),
  `embedding vector(1024)` (bge-m3).
- `document_references` – source_chunk_id, source_document_id, citation_text, canonical_form,
  reference_type (`lagrum`/`rattsfall`/`forarbete`), target_document_id?, target_chunk_id?, is_resolved.
- `provision_history` – för lagrum: sfs_change, prop, old_label/new_label (omnumreringar), effective_date.
- `ingest_jobs` (pg-boss) – kö och status per dokument.

## 5. Chunkning

Strukturen avgör, inte teckenantalet. Tolkningen återanvänder logiken i LAWLA_NEW
(`shared/sourceDoc.ts`, `shared/forarbeten.ts`, `shared/riksdagen.ts`) som flyttas hit.

| Källtyp | Minsta enhet | Förälder | Metadata |
|---|---|---|---|
| Lag (SFS) | paragraf med stycken | kapitel → lag | sfs, kap, §, rubrik, ikraft, ändrad genom, status |
| Prop/SOU/Ds | lägsta rubriknivå; **författningskommentar per paragraf** (kind `kommentar`, kopplad till lagrummet) | kapitel → dokument | beteckning, år, lagförslag + § |
| Rättsfall | domskälsavsnitt; referatrubriken som egen chunk | avgörandet | domstol, målnr, datum, anförda lagrum |
| Doktrin/uppladdat | rubrikstyrt, 400–800 tokens, överlapp | avsnitt → dokument | titel, författare, år |

Tre saker som gör att man hittar rätt utan rätt formulering:

1. **Kontextuell inbäddning.** Embeddingen görs av `context + "\n" + content`, där context är
   sökvägen i klartext: `Utlänningslag (2005:716) › 5 kap. Uppehållstillstånd › 16 c §`.
2. **LLM-berikning vid ingest** (valbar, körs asynkront): sammanfattning i vardagsspråk, 5–10
   nyckelbegrepp, vilka situationer/rekvisit chunken handlar om. Indexeras både i fulltext och vektor.
3. **Kanoniska id:n och versioner.** `canonical_id` + `anchor` följer lagen.nu:s mönster, så en
   hänvisning i en analys kan slås upp exakt. Lagtext lagras per version; upphävt markeras, inte raderas.
   Omnumreringar lagras i `provision_history` (det frontenden i dag räknar ut vid varje visning).

Referensgrafen byggs vid ingest med citeringsparsern (lagrum, rättsfall, förarbeten) per chunk.

## 6. Sökning

```
fråga ──► frågeförståelse ──► [fulltext (tsvector sv) ‖ vektor (bge-m3) ‖ exakt lagrum] ──► RRF ──► rerank (topp 50) ──► expand ──► träffar med chunk-id
```

1. **Frågeförståelse** (regler först, snabb modell vid behov): lagrum/målnummer/beteckning →
   exakt uppslag. Annars: 1–3 omskrivningar varav en i juridisk terminologi, plus filter
   (dokumenttyp, rättsområde, tid, bara gällande).
2. **Parallellt**: fulltext med svensk stemming + egen synonymlista; vektorsök (cosine);
   metadatafilter. Allt i en SQL-fråga med RRF-sammanvägning (`k = 60`).
3. **Reranking** med cross-encoder på topp 50 (hoppas över om `RERANK_URL` saknas).
4. **Utvidgning**: små chunkar byts mot förälder när det behövs; grannar via referensgrafen
   (paragraf → senaste författningskommentar → ledande avgörande) tas med som "relaterat".
5. Svar: chunk-id, kanonisk hänvisning, etikett, textställe, poäng per väg (varför den träffade).

**Utvärdering**: `eval/questions.jsonl` med frågor och förväntade lagrum/avgöranden;
`npm run eval` räknar recall@5/@10 och MRR. Ingen ändring i chunkning eller modell utan att siffrorna körs.

## 7. Analyser

- Claude via Anthropic API (adapter), strömmat som SSE i samma format som i dag
  (`data: {"type":"content","content":"…"}`), `done` med hela analysen.
- Prompten tar ärendets `main_prompt` (`instructions`) på riktigt.
- Modellen får chunkar med id:n och måste citera med dem; svaret lagras som markdown +
  `citations: [{ text, chunkId, evidenceId?, start, end }]` – spårbarheten blir exakt.
- Hallucinationskontroll innan svaret lämnar backend: varje citering verifieras mot korpusen,
  okända hänvisningar flaggas (och kan slås upp mot lagen.nu).
- Del- och samlad analys som i dag, Fråga Lawla via `/api/Rag/query-stream`.

## 8. Säkerhet

- Lösenord med argon2id, JWT (HS256, kort livslängd) + refresh, Google OAuth med vitlistad `returnUrl`.
- Alla ärende-endpoints kontrollerar ägare/medlem. Admin-roll för feedback, användare, ingest.
- Delade rapporter: slumpmässig token (32 byte), giltighet, återkallning, `noindex`.
- Inga ärendedata till externa tjänster utom LLM-anropet (och bara det som analysen behöver);
  lagen.nu får bara hänvisningen.

## 9. Repo-struktur

```
src/
  app.ts            Hono-app, routes monteras här
  server.ts         Node-server (produktion)
  config.ts         miljövariabler, validerade
  db/               klient, migreringar (SQL), testdatabas (PGlite)
  auth/             JWT, lösenord, Google
  projects/         ärendelagret (routes + repository)
  documents/        korpus: dokument, chunks, toc, referenser
  search/           frågeförståelse, hybridsök, rerank, expand
  analysis/         prompts, SSE, citeringar
  ingest/           parsers (lagen.nu, riksdagen), chunkers, berikning, embedding, kö
  providers/        embeddings, rerank, llm, storage – en adapter per yta
shared/             tolkningskod flyttad från LAWLA_NEW (sourceDoc, forarbeten, riksdagen, lagen, snapshot, sharing)
eval/               frågor + skript för recall
docs/               ARCHITECTURE.md, API.md, DEPLOY.md
docker-compose.yml  hela miljön
```

## 10. Steg

1. ✅ Kontraktet kartlagt (Worker-vitlista, DTO:er, SSE) – `docs/API.md`.
2. Grundstruktur: API, schema, migreringar, docker-compose, tester mot PGlite.
3. Korpus och sök: ingest av utlänningslagen + förarbeten, hybridsök, utvärdering.
4. Ärendelagret komplett inkl. versioner, delningar, anteckningar, huvudprompt, feedback.
5. Analysmotor med strukturerade citeringar och SSE.
6. Staging bakom Workern (`BACKEND_URL` i `staging`-miljön), parallellkörning, cutover.
