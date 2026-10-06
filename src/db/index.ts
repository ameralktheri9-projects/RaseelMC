import "dotenv/config";
import { Pool, types } from "pg";

// Postgres returns COUNT(*)/bigint as a string by default (to avoid precision
// loss past Number.MAX_SAFE_INTEGER). This app's counts never get remotely
// close to that, and the existing code throughout treats `COUNT(*) as n`
// results as plain numbers (SQLite returned them that way) — so parse OID 20
// (bigint) as a JS number everywhere instead of fixing every call site.
types.setTypeParser(20, (val: string) => parseInt(val, 10));

// Lazy: constructing the real Pool only on first actual use (not at import time) means importing
// this module — which every service/route does, including ones with pure calculation functions
// that unit tests exercise without ever touching the database — never requires DATABASE_URL to be
// set. Only an actual query attempt without one configured fails, which is the right place for it.
let realPool: Pool | null = null;

function getPool(): Pool {
  if (realPool) return realPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Add it to your .env file (see .env.example).");
  }
  realPool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
    // Keep small: on Vercel, every warm serverless instance keeps its own Pool, so a large `max`
    // here multiplies across instances fast. Use Neon's pooled ("-pooler") connection string,
    // which already multiplexes connections upstream via PgBouncer — this Pool just needs a handful.
    max: 5,
  });
  return realPool;
}

export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop, _receiver) {
    const p = getPool() as any;
    const value = p[prop];
    return typeof value === "function" ? value.bind(p) : value;
  },
});

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * node:sqlite -> Postgres compatibility shim. Keeps the rest of the codebase's
 * `db.prepare(sql).get/all/run(...params)` call shape (with `?` placeholders)
 * instead of rewriting ~170 call sites to raw pool.query($1, $2, ...). Every
 * method is now async — callers must `await` it.
 */
function toPgSql(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export const db = {
  prepare(sql: string) {
    const pgSql = toPgSql(sql);
    return {
      async get(...params: unknown[]): Promise<any> {
        const result = await pool.query(pgSql, params);
        return result.rows[0];
      },
      async all(...params: unknown[]): Promise<any[]> {
        const result = await pool.query(pgSql, params);
        return result.rows;
      },
      async run(...params: unknown[]): Promise<{ changes: number }> {
        const result = await pool.query(pgSql, params);
        return { changes: result.rowCount ?? 0 };
      },
    };
  },
  async exec(sql: string): Promise<void> {
    await pool.query(sql);
  },
};

/**
 * node:sqlite returned rows synchronously as Record<string, SQLOutputValue>;
 * with Postgres every row fetch is now a Promise, so this also guards against
 * the single easiest mistake in this conversion: forgetting an `await` before
 * wrapping a call in asRow(), which previously would have just mis-cast but
 * now would silently hand back a pending Promise instead of a row.
 */
export function asRow<T>(value: unknown): T {
  if (value && typeof (value as PromiseLike<unknown>).then === "function") {
    throw new Error("asRow() received a Promise — did you forget an `await`?");
  }
  return value as T;
}
