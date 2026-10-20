/** Testdatabas: PGlite i minne med pgvector, migrerad. Används av vitest. */
import { connectPglite, type Db } from "./db.js";
import { migrate } from "./migrate.js";

export async function testDb(): Promise<Db> {
  const db = await connectPglite();
  await migrate(db);
  return db;
}
