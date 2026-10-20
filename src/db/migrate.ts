/**
 * Migreringar: SQL-filer i src/db/migrations körs i namnordning, en gång var, inom en transaktion.
 * `npm run migrate` i drift; testdatabasen kör samma filer mot PGlite.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Db } from "./db.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await db.query<{ name: string }>(`SELECT name FROM schema_migrations`)).map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
    });
    ran.push(file);
    log(`migrering ${file} klar`);
  }
  return ran;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { loadConfig } = await import("../config.js");
  const { connect } = await import("./db.js");
  const cfg = loadConfig();
  const db = await connect(cfg.DATABASE_URL);
  const ran = await migrate(db, console.log);
  console.log(ran.length ? `${ran.length} migrering(ar) körda.` : "Databasen är redan uppdaterad.");
  await db.close();
}
