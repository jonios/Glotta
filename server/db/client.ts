import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Minimal database interface over a node-postgres pool (PostgreSQL 14+). All queries are
 * parameterised SQL; no string interpolation of user input anywhere.
 */
export interface Queryable {
  query<T = any>(text: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(text: string, params?: unknown[]): Promise<T | undefined>;
}
export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly driver: 'pg';
}

function wrap(run: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>): Queryable {
  return {
    async query(text, params) {
      return (await run(text, params as any[])).rows;
    },
    async one(text, params) {
      return (await run(text, params as any[])).rows[0];
    },
  };
}

export const MISSING_DATABASE_URL =
  'DATABASE_URL is not set. Point it at a PostgreSQL 14+ database (for a local one run "npm run pg:init"), e.g. DATABASE_URL=postgres://glotta:secret@127.0.0.1:5432/glotta';

export async function createDb(opts: { url?: string; max?: number }): Promise<Db> {
  if (!opts.url) throw new Error(MISSING_DATABASE_URL);
  const pool = new pg.Pool({ connectionString: opts.url, max: opts.max ?? 10 });
  // Fail fast with a readable message instead of on the first request.
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end().catch(() => undefined);
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot connect to PostgreSQL (${detail}). Is the server running ("npm run pg:start" for the local one) and is DATABASE_URL correct?`);
  }
  const base = wrap((t, p) => pool.query(t, p));
  return {
    ...base,
    driver: 'pg',
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap((t, p) => client.query(t, p)));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Applies pending SQL migrations in filename order, each inside its own transaction. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await db.tx(async (q) => {
      for (const stmt of splitSql(sql)) await q.query(stmt);
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}

/**
 * Splits a migration into statements at semicolons that end a line, keeping dollar-quoted bodies
 * (`$$ … $$`, used by functions and triggers) together even though they contain semicolons.
 */
export function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  let inDollar = false;
  for (const line of sql.split('\n')) {
    if (!inDollar && line.trim().startsWith('--')) continue;
    current.push(line);
    if ((line.match(/\$\$/g)?.length ?? 0) % 2 === 1) inDollar = !inDollar;
    if (!inDollar && /;\s*$/.test(line)) {
      statements.push(current.join('\n').trim().replace(/;\s*$/, ''));
      current = [];
    }
  }
  const rest = current.join('\n').trim();
  if (rest) statements.push(rest);
  return statements.filter(Boolean);
}
