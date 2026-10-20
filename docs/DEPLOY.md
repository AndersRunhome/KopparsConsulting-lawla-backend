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

## Hetzner (valt för Koppars drift)
1. Hetzner Cloud → ny server: **Ubuntu 24.04**, typ **CX22** (2 vCPU/4 GB, ~4 EUR/mån), plats Helsinki, din SSH-nyckel.
2. DNS (Cloudflare): `A api.lawla.kopparsconsulting.com → <serverns IP>`, **DNS only** (grått moln) så att Caddy kan hämta Let's Encrypt-certifikat.
3. På servern som root:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/AndersRunhome/KopparsConsulting-lawla-backend/main/deploy/bootstrap.sh | bash
   nano /opt/lawla-backend/deploy/.env        # DATABASE_URL, DeepInfra-nyckel, Anthropic-nyckel
   cd /opt/lawla-backend/deploy && docker compose -f docker-compose.hetzner.yml up -d --build
   curl https://api.lawla.kopparsconsulting.com/health
   ```
4. Uppdatering senare: `/opt/lawla-backend/deploy/update.sh`. Loggar: `docker compose -f docker-compose.hetzner.yml logs -f api`.

Supabase: använd **Session pooler**-adressen (port 5432) från projektets "Connect"-dialog – direktanslutningen är bara IPv6.
Supabase-projektet för Lawla: `qgcmoghpkirukfgfjfmv` (Stockholm). Schemat är applicerat via Supabase-migreringen `lawla_init`
(= `0001_init.sql` + `0002_rls.sql`); RLS är på för alla tabeller så att PostgREST/anon inte kan läsa något.

`fly.toml` finns kvar som alternativ (Fly.io, region Stockholm).

## Migreringar
Körs automatiskt vid start (`src/db/migrations/*.sql`, en gång var). Nya ändringar = ny fil med nästa nummer.
