# Lawla backend

Backend för Lawla – rättsutredningar för svenska jurister. Äger ärenden, underlag, analyser,
versioner, delningar och en egen korpus av rättskällor med hybridsök. Ersätter plattformen på
lawla.berge.tech bakom samma API som frontenden (LAWLA_NEW) redan använder.

- **Arkitektur:** `docs/ARCHITECTURE.md` (lager, drift, datamodell, chunkning, sök, analyser)
- **API-kontrakt:** `docs/API.md`
- **Drift:** `docs/DEPLOY.md`

## Kom igång

```bash
npm install
cp .env.example .env          # utan DATABASE_URL körs PGlite i minne
npm run dev                   # http://localhost:8080/health
npm test                      # 59 tester mot PGlite (Postgres i Node, med pgvector)
```

Ingest och sök utan extern databas:

```bash
export DATABASE_URL=pglite:./.pglite
npm run ingest -- --file src/ingest/fixtures/utll-utdrag.md --uri https://lagen.nu/2005:716
npm run ingest -- https://lagen.nu/2005:716 https://lagen.nu/prop/2005/06:77   # riktiga dokument
npm run eval                  # recall@5/@10 och MRR mot eval/questions.jsonl
```

Utan `EMBEDDINGS_URL` används en hash-embedder (ingen semantik) – bra för tester, inte för drift.
Peka `EMBEDDINGS_URL` mot en OpenAI-kompatibel endpoint (TEI, DeepInfra, Workers AI) för riktig vektorsök.

## Struktur

```
src/app.ts            Hono-app, alla routes
src/server.ts         Node-server (produktion)
src/config.ts         miljövariabler
src/db/               databasyta (postgres.js / PGlite), migreringar
src/auth/             JWT, lösenord, Google
src/projects/         ärendelagret (ärenden, underlag, versioner, delningar, anteckningar)
src/documents/        korpus-API och hänvisningsparser
src/search/           hybridsök (fulltext + vektor + RRF + rerank), synonymer
src/analysis/         analysmotor med strukturerade citeringar, SSE
src/ingest/           lagen.nu → chunkar → databas, CLI
src/providers/        adaptrar: embeddings, rerank, LLM
shared/               tolkningskod delad med LAWLA_NEW
eval/                 utvärdering av söket
```

## Kontrakt med frontenden

Workern i LAWLA_NEW proxar `/api/*` hit med Bearer-token. Byt `BACKEND_URL` till den här tjänsten
så fungerar ärendeflödet som i dag; endpoints som Workern i dag sköter själv (historik, inställningar,
delning, anteckningar) finns här under `/api/Projects/:id/…` och kan flyttas över i frontenden i egen takt.
