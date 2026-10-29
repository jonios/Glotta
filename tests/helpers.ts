import 'dotenv/config';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { createDb, migrate, type Db } from '../server/db/client.js';
import { seedReferenceData } from '../server/bootstrap.js';
import { hashPassword } from '../server/auth/crypto.js';
import { CAPABILITIES, type Capability, type Role } from '../shared/domain.js';
import { parseForImport, runImport, storeUpload } from '../server/importexport/import-routes.js';
import { suggestPlatform, type ImportOptions } from '../server/importexport/importer.js';
import type { ImportStrategy } from '../shared/domain.js';
import type { AiRuntime } from '../server/ai/routes.js';

export const WORKBOOK = 'data/Keywords (5).xlsx';
export const PASSWORD = 'test-password-123';

export interface TestEnv {
  db: Db;
  /** Connection URL of this environment's own database. */
  url: string;
  app: FastifyInstance;
  close(): Promise<void>;
}

/**
 * Every test environment gets its own freshly created PostgreSQL database (dropped on close), so test
 * files run in parallel without seeing each other's data. TEST_DATABASE_URL names a database the role
 * can connect to and must have CREATEDB (both set up by "npm run pg:init").
 */
export async function createEnv(opts: { ai?: (db: Db) => AiRuntime } = {}): Promise<TestEnv> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error('TEST_DATABASE_URL is not set. Run "npm run pg:init" (local PostgreSQL) or point it at a test database whose role has CREATEDB.');
  const name = `glotta_t_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  const db = await createDb({ url: url.toString(), max: 5 });
  await migrate(db);
  await seedReferenceData(db);
  const app = await buildApp({ db, config: { ...loadConfig({}), nodeEnv: 'test', uploadsPerMinute: 1000 }, ai: opts.ai?.(db) });
  return {
    db,
    url: url.toString(),
    app,
    close: async () => {
      await app.close();
      await db.close();
      const c = new pg.Client({ connectionString: base });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export async function ids(db: Db) {
  const langs = await db.query<{ id: number; code: string }>('SELECT id, code FROM languages');
  const plats = await db.query<{ id: number; name: string }>('SELECT id, name FROM platforms');
  return {
    lang: (code: string) => langs.find((l) => l.code === code)!.id,
    plat: (name: string) => plats.find((p) => p.name === name)!.id,
  };
}

export async function createUser(
  db: Db,
  opts: { email: string; role: Role; caps?: Capability[]; languages?: number[]; platforms?: number[]; allLanguages?: boolean; allPlatforms?: boolean },
) {
  const all = opts.role === 'super_admin';
  const u = await db.one<{ id: number }>(
    `INSERT INTO users (email, name, role, password_hash, all_languages, all_platforms) VALUES ($1,$1,$2,$3,$4,$5) RETURNING id`,
    [opts.email, opts.role, await hashPassword(PASSWORD), all || !!opts.allLanguages, all || !!opts.allPlatforms],
  );
  const caps = all ? [...CAPABILITIES] : opts.caps ?? [];
  if (caps.length) await db.query('INSERT INTO user_capabilities SELECT $1, unnest($2::text[])', [u!.id, caps]);
  for (const l of opts.languages ?? []) await db.query('INSERT INTO user_languages VALUES ($1,$2)', [u!.id, l]);
  for (const p of opts.platforms ?? []) await db.query('INSERT INTO user_platforms VALUES ($1,$2)', [u!.id, p]);
  return u!.id;
}

export type Client = Awaited<ReturnType<typeof login>>;

/** A logged-in HTTP client using the real cookie + CSRF flow. */
export async function login(app: FastifyInstance, email: string, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  const csrf = me.json().csrfToken as string;
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as any, headers: { cookie, 'x-csrf-token': csrf } });
  return {
    cookie,
    csrf,
    get: (url: string) => call('GET', url),
    post: (url: string, body?: unknown) => call('POST', url, body ?? {}),
    put: (url: string, body?: unknown) => call('PUT', url, body ?? {}),
    patch: (url: string, body?: unknown) => call('PATCH', url, body ?? {}),
    del: (url: string) => call('DELETE', url),
    raw: call,
  };
}

/** Imports the real workbook through the production pipeline. */
export async function importWorkbook(
  db: Db,
  userId: number,
  strategy: ImportStrategy = 'skip_existing',
  buffer: Buffer = readFileSync(WORKBOOK),
  dryRun = false,
) {
  const { snap, sheets } = await parseForImport(db, buffer);
  const opts: ImportOptions = {
    strategy,
    importedStatus: 'approved',
    sheets: sheets.map((s) => ({ name: s.name, action: 'import' as const, platformId: suggestPlatform(s.name, snap)! })),
  };
  const job = await db.one<{ id: number }>(`INSERT INTO import_jobs (file_name, file_sha256, created_by) VALUES ('wb.xlsx','x',$1) RETURNING id`, [userId]);
  storeUpload(job!.id, buffer);
  const report = await runImport(db, job!.id, userId, buffer, opts, dryRun);
  return { jobId: job!.id, report };
}

/** Finds a key on a platform by identifier. */
export async function keyOn(db: Db, platform: string, identifier: string) {
  return db.one<{ id: number; source_text: string; namespace: string; version: number }>(
    `SELECT k.id, k.source_text, k.namespace, k.version FROM translation_keys k JOIN key_platforms kp ON kp.key_id=k.id
     JOIN platforms p ON p.id=kp.platform_id WHERE p.name=$1 AND kp.identifier=$2`,
    [platform, identifier],
  );
}
