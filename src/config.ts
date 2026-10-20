/**
 * Konfiguration via miljövariabler. Allt som är leverantörsspecifikt (databas, objektlager,
 * modelltjänster) pekas ut här – koden i övrigt känner bara till standardytorna
 * (Postgres, S3, OpenAI-kompatibla embeddings, TEI-rerank, LLM-adapter). Se docs/ARCHITECTURE.md §3.
 */
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  /** Postgres-anslutning. Tomt i test → PGlite i minne. */
  DATABASE_URL: z.string().default(""),
  /** Hemlighet för JWT (HS256). Minst 32 tecken i produktion. */
  JWT_SECRET: z.string().default("dev-secret-change-me-dev-secret-change-me"),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 12),
  /** Tillåtna retur-URL:er för Google-inloggning (kommaseparerade origins). */
  AUTH_RETURN_ORIGINS: z.string().default("http://localhost:5173"),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_REDIRECT_URI: z.string().default(""),
  ALLOW_REGISTRATIONS: z.coerce.boolean().default(true),
  AUTO_APPROVE_REGISTRATIONS: z.coerce.boolean().default(true),

  /** OpenAI-kompatibel embeddings-endpoint (TEI, DeepInfra, OpenAI, Workers AI). Tomt → lokal hash-embedder (bara utveckling/test). */
  EMBEDDINGS_URL: z.string().default(""),
  EMBEDDINGS_API_KEY: z.string().default(""),
  EMBEDDINGS_MODEL: z.string().default("BAAI/bge-m3"),
  EMBEDDINGS_DIM: z.coerce.number().int().positive().default(1024),
  /** TEI-/Cohere-kompatibel rerank-endpoint. Tomt → ingen reranking. */
  RERANK_URL: z.string().default(""),
  RERANK_API_KEY: z.string().default(""),
  RERANK_MODEL: z.string().default("BAAI/bge-reranker-v2-m3"),

  LLM_PROVIDER: z.enum(["anthropic", "none"]).default("none"),
  ANTHROPIC_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().default("claude-sonnet-4-5"),
  /** Snabb modell för frågeomskrivning och berikning vid ingest. */
  LLM_FAST_MODEL: z.string().default("claude-haiku-4-5"),

  /** S3-kompatibelt objektlager för rådokument (R2 nu, MinIO hos kunden). Tomt → lokal mapp. */
  S3_ENDPOINT: z.string().default(""),
  S3_BUCKET: z.string().default("lawla-raw"),
  S3_ACCESS_KEY: z.string().default(""),
  S3_SECRET_KEY: z.string().default(""),
  RAW_DIR: z.string().default("./data/raw"),

  LAGEN_BASE: z.string().default("https://lagen.nu"),
  RIKSDAGEN_BASE: z.string().default("https://data.riksdagen.se"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Ogiltig konfiguration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === "production") {
    if (!cfg.DATABASE_URL) throw new Error("DATABASE_URL krävs i produktion.");
    if (cfg.JWT_SECRET.length < 32 || cfg.JWT_SECRET.startsWith("dev-secret")) throw new Error("JWT_SECRET måste sättas i produktion (minst 32 tecken).");
  }
  return cfg;
}
