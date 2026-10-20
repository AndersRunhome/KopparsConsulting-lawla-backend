# Drift

Samma container överallt; det som skiljer är miljövariabler.

## Hos kunden (egen server)
```bash
cp .env.example .env    # sätt JWT_SECRET, ANTHROPIC_API_KEY, Google-uppgifter
docker compose up -d    # api + postgres (pgvector) + tei-embed + tei-rerank + minio
curl localhost:8080/health
```
Sätt en reverse proxy (Caddy/nginx) med TLS framför port 8080. Frontendens Worker (eller en
Caddy-proxy med samma cookie-logik) pekar `BACKEND_URL` hit.

Minsta server: 4 vCPU, 8 GB RAM (TEI på CPU med bge-m3 behöver ~3 GB). Ingest av hela korpusen är
en engångskostnad; sökfrågor tar ~100–300 ms på CPU.

## I molnet (Koppars, i dag)
| Del | Val |
|---|---|
| API-container | Cloudflare Containers, Fly.io eller en Hetzner-VM med `docker compose` (utan tei/minio) |
| Postgres | Supabase eller Neon (pgvector finns i båda) – `DATABASE_URL` |
| Embeddings/rerank | DeepInfra (`EMBEDDINGS_URL=https://api.deepinfra.com/v1/openai`, modell `BAAI/bge-m3`) eller Workers AI |
| Rådokument | R2 via S3-API |
| LLM | Anthropic API |

Första användaren som registrerar sig blir admin. Ingest startas som admin med
`POST /api/Ingest {"source":"lagen.nu","uri":"https://lagen.nu/2005:716"}` eller via `npm run ingest`.

## Migreringar
Körs automatiskt vid start (`src/db/migrations/*.sql`, en gång var). Nya ändringar = ny fil med nästa nummer.
