/**
 * /api/Auth – login, register, validate, Google. Samma kontrakt som Workern i LAWLA_NEW
 * förväntar sig (docs/API.md). Google-flödet: redirect till Google med `state` = returnUrl
 * (vitlistad origin), callback byter kod mot id_token, hittar/skapar användaren och
 * skickar till `returnUrl?token=<JWT>`.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createHmac, randomBytes } from "node:crypto";
import type { AppContext, Env } from "../app.js";
import { hashPassword, toUserDto, verifyPassword, type UserRow } from "./auth.js";

const USER_COLS = "id, email, name, role, is_active, created_at, last_login_at";

export function authRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const { db, cfg, tokens } = ctx;

  app.post("/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    const email = (body.email ?? "").trim().toLowerCase();
    const row = await db.one<UserRow & { password_hash: string | null }>(`SELECT ${USER_COLS}, password_hash FROM users WHERE email = $1`, [email]);
    if (!row || !row.password_hash || !(await verifyPassword(row.password_hash, body.password ?? ""))) {
      throw new HTTPException(401, { message: "Fel e-post eller lösenord." });
    }
    if (!row.is_active) throw new HTTPException(403, { message: "Kontot väntar på godkännande." });
    await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [row.id]);
    return c.json({ token: await tokens.sign(row), user: toUserDto(row) });
  });

  app.post("/register", async (c) => {
    if (!cfg.ALLOW_REGISTRATIONS) throw new HTTPException(403, { message: "Registrering är avstängd." });
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string; name?: string };
    const email = (body.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HTTPException(400, { message: "Ogiltig e-postadress." });
    if ((body.password ?? "").length < 8) throw new HTTPException(400, { message: "Lösenordet måste vara minst 8 tecken." });
    if (await db.one(`SELECT 1 FROM users WHERE email = $1`, [email])) throw new HTTPException(409, { message: "E-postadressen används redan." });
    const first = !(await db.one(`SELECT 1 FROM users LIMIT 1`));
    const row = await db.one<UserRow>(
      `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,$4,$5) RETURNING ${USER_COLS}`,
      [email, (body.name ?? "").trim() || null, await hashPassword(body.password!), first ? "admin" : "member", first || cfg.AUTO_APPROVE_REGISTRATIONS],
    );
    if (!row!.is_active) return c.json({ token: null, user: null, message: "Kontot är skapat och väntar på godkännande." });
    return c.json({ token: await tokens.sign(row!), user: toUserDto(row!), message: null });
  });

  app.post("/validate", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: string };
    const claims = body.token ? await tokens.verify(body.token) : null;
    const row = claims ? await db.one<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1 AND is_active`, [claims.userId]) : null;
    if (!row) throw new HTTPException(401, { message: "Ogiltig session." });
    return c.json(toUserDto(row));
  });

  /* ─── Google ─────────────────────────────────────────────────────────── */

  const allowedOrigins = cfg.AUTH_RETURN_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  const stateSign = (v: string) => createHmac("sha256", cfg.JWT_SECRET).update(v).digest("base64url");

  app.get("/google", (c) => {
    if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_REDIRECT_URI) throw new HTTPException(404, { message: "Google-inloggning är inte konfigurerad." });
    const returnUrl = c.req.query("returnUrl") ?? "";
    let origin: string;
    try {
      origin = new URL(returnUrl).origin;
    } catch {
      throw new HTTPException(400, { message: "Ogiltig returnUrl." });
    }
    if (!allowedOrigins.includes(origin)) throw new HTTPException(400, { message: "returnUrl är inte tillåten." });
    const nonce = randomBytes(8).toString("base64url");
    const state = `${nonce}.${Buffer.from(returnUrl).toString("base64url")}`;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", cfg.GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", cfg.GOOGLE_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", `${state}.${stateSign(state)}`);
    return c.redirect(url.toString(), 302);
  });

  app.get("/google/callback", async (c) => {
    const code = c.req.query("code") ?? "";
    const stateRaw = c.req.query("state") ?? "";
    const [nonce, ret, sig] = stateRaw.split(".");
    if (!nonce || !ret || !sig || stateSign(`${nonce}.${ret}`) !== sig) throw new HTTPException(400, { message: "Ogiltigt state." });
    const returnUrl = Buffer.from(ret, "base64url").toString();
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: cfg.GOOGLE_CLIENT_ID, client_secret: cfg.GOOGLE_CLIENT_SECRET, redirect_uri: cfg.GOOGLE_REDIRECT_URI, grant_type: "authorization_code" }),
    });
    if (!tokenRes.ok) return c.redirect(`${returnUrl}?error=google`, 302);
    const data = (await tokenRes.json()) as { id_token?: string };
    const payload = data.id_token ? decodeIdToken(data.id_token) : null;
    if (!payload?.sub || !payload.email) return c.redirect(`${returnUrl}?error=google`, 302);

    let row = await db.one<UserRow>(`SELECT ${USER_COLS} FROM users WHERE google_sub = $1 OR email = $2`, [payload.sub, payload.email.toLowerCase()]);
    if (!row) {
      if (!cfg.ALLOW_REGISTRATIONS) return c.redirect(`${returnUrl}?error=registrations`, 302);
      row = await db.one<UserRow>(
        `INSERT INTO users (email, name, google_sub, is_active) VALUES ($1,$2,$3,$4) RETURNING ${USER_COLS}`,
        [payload.email.toLowerCase(), payload.name ?? null, payload.sub, cfg.AUTO_APPROVE_REGISTRATIONS],
      );
    } else {
      await db.query(`UPDATE users SET google_sub = coalesce(google_sub, $2), last_login_at = now() WHERE id = $1`, [row.id, payload.sub]);
    }
    if (!row!.is_active) return c.redirect(`${returnUrl}?error=pending`, 302);
    return c.redirect(`${returnUrl}?token=${encodeURIComponent(await tokens.sign(row!))}`, 302);
  });

  return app;
}

/** id_token kommer direkt från Googles token-endpoint över TLS – signaturen behöver inte verifieras igen. */
function decodeIdToken(jwt: string): { sub?: string; email?: string; name?: string } | null {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
  } catch {
    return null;
  }
}
