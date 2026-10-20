/**
 * Databasyta: ren SQL med $1-parametrar mot Postgres. Två adaptrar – postgres.js i drift och
 * PGlite (Postgres i Node, med pgvector) i tester och lokal utveckling utan server.
 * Ingen ORM: schemat är enkelt och sökfrågorna (tsvector + pgvector + RRF) skrivs bäst för hand.
 */

export type Row = object;
export type AnyRow = Record<string, unknown>;

export interface Db {
  query<T extends Row = AnyRow>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends Row = AnyRow>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Kör ett SQL-skript med flera satser (migreringar). Inga parametrar. */
  exec(sql: string): Promise<void>;
  /** Kör en följd av satser i en transaktion. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: "postgres" | "pglite";
}

function withOne(base: Pick<Db, "query">): Db["one"] {
  return (async (sql: string, params?: unknown[]) => (await base.query(sql, params))[0] ?? null) as Db["one"];
}

/* ─── postgres.js ─────────────────────────────────────────────────────── */

export async function connectPostgres(url: string): Promise<Db> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 10, transform: { undefined: null } });
  const make = (client: typeof sql): Db => {
    const query = async <T extends Row>(text: string, params: unknown[] = []) =>
      (await client.unsafe(text, params as never)) as unknown as T[];
    return {
      kind: "postgres",
      query,
      one: withOne({ query }),
      exec: async (text) => {
        await client.unsafe(text);
      },
      transaction: (fn) => client.begin((tx) => fn(make(tx as unknown as typeof sql))) as Promise<never>,
      close: () => client.end(),
    };
  };
  return make(sql);
}

/* ─── PGlite ──────────────────────────────────────────────────────────── */

export async function connectPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const pg = dataDir ? new PGlite(dataDir, { extensions: { vector } }) : new PGlite({ extensions: { vector } });
  await pg.waitReady;
  const query = async <T extends Row>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows as T[];
  const db: Db = {
    kind: "pglite",
    query,
    one: withOne({ query }),
    exec: async (text) => {
      await pg.exec(text);
    },
    transaction: (fn) =>
      pg.transaction(async (tx) => {
        const tq = async <T extends Row>(text: string, params: unknown[] = []) => (await tx.query<T>(text, params)).rows as T[];
        const texec = async (text: string) => {
          await tx.exec(text);
        };
        return fn({ kind: "pglite", query: tq, one: withOne({ query: tq }), exec: texec, transaction: (inner) => inner(db), close: async () => {} });
      }),
    close: () => pg.close(),
  };
  return db;
}

export async function connect(databaseUrl: string): Promise<Db> {
  if (!databaseUrl) return connectPglite();
  if (databaseUrl.startsWith("pglite:")) return connectPglite(databaseUrl.slice("pglite:".length) || undefined);
  return connectPostgres(databaseUrl);
}

/** Formaterar en vektor för pgvector-parametrar ("[0.1,0.2,…]"). */
export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
