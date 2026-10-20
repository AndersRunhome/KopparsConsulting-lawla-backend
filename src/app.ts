/**
 * Hono-appen. Alla beroenden (databas, modelltjänster, konfiguration) skickas in så att
 * samma app kan köras i produktion och i tester (PGlite, hash-embedder, ingen LLM).
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Config } from "./config.js";
import type { Db } from "./db/db.js";
import type { Embedder } from "./providers/embeddings.js";
import type { Reranker } from "./providers/rerank.js";
import type { Llm } from "./providers/llm.js";
import { Tokens, findUserById, toUserDto, type UserDto } from "./auth/auth.js";
import { authRoutes } from "./auth/routes.js";
import { projectRoutes, publicShareRoutes } from "./projects/routes.js";
import { documentRoutes } from "./documents/routes.js";
import { searchRoutes } from "./search/routes.js";
import { analysisRoutes, ragRoutes } from "./analysis/routes.js";

export interface Deps {
  cfg: Config;
  db: Db;
  embedder: Embedder;
  reranker: Reranker;
  llm: Llm;
}

export interface AppContext extends Deps {
  tokens: Tokens;
}

export type Env = { Variables: { user: UserDto } };

export function createApp(deps: Deps) {
  const ctx: AppContext = { ...deps, tokens: new Tokens(deps.cfg.JWT_SECRET, deps.cfg.JWT_TTL_SECONDS) };
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "Ett fel uppstod." }, 500);
  });

  app.get("/health", async (c) => {
    await ctx.db.query("SELECT 1");
    return c.json({ ok: true });
  });

  app.get("/api/System/features", (c) =>
    c.json({
      ai: { enabled: ctx.llm.enabled, ragEnabled: true, embeddingsEnabled: true, analysisEnabled: ctx.llm.enabled },
      elasticsearch: { enabled: false, contentIndexingEnabled: true },
      tts: { enabled: false },
      googleAuth: { enabled: Boolean(ctx.cfg.GOOGLE_CLIENT_ID) },
      security: { requireLogin: true, allowRegistrations: ctx.cfg.ALLOW_REGISTRATIONS, autoApproveRegistrations: ctx.cfg.AUTO_APPROVE_REGISTRATIONS },
      documentAnalysisEnabled: true,
      documentManagementEnabled: true,
    }),
  );

  app.route("/api/Auth", authRoutes(ctx));
  app.route("/api/shares", publicShareRoutes(ctx));

  // Allt under /api/* utom ovan kräver inloggning.
  app.use("/api/*", async (c, next) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const claims = token ? await ctx.tokens.verify(token) : null;
    const user = claims ? await findUserById(ctx.db, claims.userId) : null;
    if (!user || !user.is_active) throw new HTTPException(401, { message: "Inte inloggad." });
    c.set("user", toUserDto(user));
    await next();
  });

  app.route("/api/Projects", projectRoutes(ctx));
  app.route("/api/Projects", analysisRoutes(ctx));
  app.route("/api", documentRoutes(ctx));
  app.route("/api", searchRoutes(ctx));
  app.route("/api", ragRoutes(ctx));

  app.post("/api/feedback", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const description = String(body.description ?? "").trim().slice(0, 4000);
    if (!description) throw new HTTPException(400, { message: "Beskrivning saknas." });
    await ctx.db.query(
      `INSERT INTO feedback (user_id, description, path, priority, user_agent, viewport) VALUES ($1,$2,$3,$4,$5,$6)`,
      [c.get("user").id, description, String(body.path ?? "").slice(0, 500), ["low", "normal", "high"].includes(String(body.priority)) ? body.priority : "normal",
        String(body.userAgent ?? "").slice(0, 500), String(body.viewport ?? "").slice(0, 40)],
    );
    return c.body(null, 204);
  });
  app.get("/api/feedback", async (c) => {
    if (!c.get("user").isAdmin) throw new HTTPException(403, { message: "Kräver admin." });
    return c.json(await ctx.db.query(`SELECT f.*, u.email FROM feedback f LEFT JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT 500`));
  });

  return app;
}
