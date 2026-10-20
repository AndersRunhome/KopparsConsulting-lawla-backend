import { describe, expect, it } from "vitest";
import { testDb } from "./testdb.js";
import { toVector } from "./db.js";

describe("schema", () => {
  it("migrerar och stödjer svensk fulltext och pgvector", async () => {
    const db = await testDb();
    const doc = await db.one<{ id: number }>(
      `INSERT INTO documents (title, source, document_type, canonical_id) VALUES ('Utlänningslag (2005:716)', 'lagen.nu', 'lag', 'sfs:2005:716') RETURNING id`,
    );
    const v = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    await db.query(
      `INSERT INTO chunks (document_id, chunk_index, anchor, kind, label, path, context, content, embedding)
       VALUES ($1, 0, 'K5P16c', 'paragraf', '5 kap. 16 c §', $2, 'Utlänningslag (2005:716) › 5 kap. Uppehållstillstånd › 16 c §',
               'Uppehållstillstånd får beviljas en utlänning som har för avsikt att gifta sig.', $3)`,
      [doc!.id, ["5 kap. Uppehållstillstånd", "16 c §"], toVector(v)],
    );
    const ft = await db.query<{ label: string }>(
      `SELECT label FROM chunks WHERE tsv @@ plainto_tsquery('swedish', 'uppehållstillstånden gifta')`,
    );
    expect(ft.map((r) => r.label)).toEqual(["5 kap. 16 c §"]);
    const vec = await db.one<{ d: number }>(`SELECT embedding <=> $1::vector AS d FROM chunks`, [toVector(v)]);
    expect(Number(vec!.d)).toBeCloseTo(0, 5);
    await db.close();
  });
});
