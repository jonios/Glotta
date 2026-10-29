// DEVELOPMENT ONLY. Creates demo accounts and imports the real legacy workbook so the app can
// be explored locally. Refuses to run when NODE_ENV=production.
//
//   npm run seed:dev -- [--file "data/Keywords (5).xlsx"]
//
// Demo accounts (local development only — never use these credentials anywhere else):
//   admin@tms.test     / dev-admin-pass-1     Super Admin
//   manager@tms.test   / dev-manager-pass-1   Translation Manager, all languages & platforms
//   italian@tms.test   / dev-italian-pass-1   Translator: Italian, Web Service + Dashboard
//   viewer@tms.test    / dev-viewer-pass-1    Read-only: Persian, Dispatcher
import { existsSync, readFileSync } from 'node:fs';
import { openDb, arg } from './common.js';
import { hashPassword } from '../auth/crypto.js';
import { CAPABILITIES, ROLE_DEFAULT_CAPABILITIES, type Capability, type Role } from '../../shared/domain.js';
import { parseForImport, runImport, storeUpload } from '../importexport/import-routes.js';
import { suggestPlatform, slugify, type ImportOptions } from '../importexport/importer.js';
import { buildApp } from '../app.js';

if (process.env.NODE_ENV === 'production') {
  console.error('seed:dev refuses to run with NODE_ENV=production');
  process.exit(1);
}
const file = arg('file') ?? 'data/Keywords (5).xlsx';
const { db, config } = await openDb();

async function user(email: string, name: string, password: string, role: Role, opts: { caps?: Capability[]; langs?: string[]; plats?: string[]; all?: boolean } = {}) {
  const existing = await db.one<{ id: number }>('SELECT id FROM users WHERE email=$1', [email]);
  if (existing) return existing.id;
  const all = role === 'super_admin' || !!opts.all;
  const u = await db.one<{ id: number }>(
    'INSERT INTO users (email, name, role, password_hash, all_languages, all_platforms) VALUES ($1,$2,$3,$4,$5,$5) RETURNING id',
    [email, name, role, await hashPassword(password), all],
  );
  const caps = role === 'super_admin' ? [...CAPABILITIES] : opts.caps ?? ROLE_DEFAULT_CAPABILITIES[role];
  await db.query('INSERT INTO user_capabilities SELECT $1, unnest($2::text[])', [u!.id, caps]);
  if (opts.langs) await db.query('INSERT INTO user_languages SELECT $1, id FROM languages WHERE code = ANY($2::text[])', [u!.id, opts.langs]);
  if (opts.plats) await db.query('INSERT INTO user_platforms SELECT $1, id FROM platforms WHERE name = ANY($2::text[])', [u!.id, opts.plats]);
  return u!.id;
}

const adminId = await user('admin@tms.test', 'Ada Admin', 'dev-admin-pass-1', 'super_admin');
await user('manager@tms.test', 'Morgan Manager', 'dev-manager-pass-1', 'manager', { all: true });
await user('italian@tms.test', 'Italian Translator', 'dev-italian-pass-1', 'translator', {
  caps: ['view', 'view_source', 'edit_translations', 'export'],
  langs: ['it'],
  plats: ['Web Service', 'Dashboard'],
});
await user('viewer@tms.test', 'Pat Viewer', 'dev-viewer-pass-1', 'viewer', { caps: ['view', 'view_source'], langs: ['fa'], plats: ['Dispatcher'] });

const imported = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM import_jobs WHERE status='completed'`);
if (!imported!.n) {
  if (!existsSync(file)) {
    console.error(`Workbook not found at ${file}; skipping import.`);
  } else {
    const buffer = readFileSync(file);
    const { snap, sheets } = await parseForImport(db, buffer);
    const opts: ImportOptions = {
      strategy: 'skip_existing',
      importedStatus: 'approved',
      sheets: sheets.map((s) => {
        const pid = suggestPlatform(s.name, snap);
        return pid ? { name: s.name, action: 'import' as const, platformId: pid } : { name: s.name, action: 'import' as const, createPlatform: { name: s.name, slug: slugify(s.name), archived: s.deprecated } };
      }),
    };
    const job = await db.one<{ id: number }>(`INSERT INTO import_jobs (file_name, file_sha256, created_by) VALUES ($1,'dev-seed',$2) RETURNING id`, ['Keywords (5).xlsx', adminId]);
    storeUpload(job!.id, buffer);
    const report = await runImport(db, job!.id, adminId, buffer, opts, false);
    console.log('Workbook imported:', report.summary);

    // Scenario C demo through the real API: the shared keyword "all".
    const app = await buildApp({ db, config: { ...config, nodeEnv: 'test' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@tms.test', password: 'dev-admin-pass-1' } });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const csrf = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json().csrfToken;
    const h = { cookie, 'x-csrf-token': csrf };
    const key = await db.one<{ id: number }>(
      `SELECT kp.key_id AS id FROM key_platforms kp JOIN platforms p ON p.id=kp.platform_id WHERE p.name='Dispatcher' AND kp.identifier='all'`,
    );
    if (key) {
      const segIds: number[] = [];
      for (const name of ['neworder', 'vieworder', 'table list']) {
        const r = await app.inject({ method: 'POST', url: '/api/segments', headers: h, payload: { name } });
        segIds.push(r.statusCode === 200 ? r.json().id : (await db.one('SELECT id FROM segments WHERE name_norm=$1', [name])).id);
      }
      await app.inject({ method: 'PUT', url: `/api/keys/${key.id}/segments`, headers: h, payload: { segmentIds: segIds } });
      const cur = (await db.query<{ platform_id: number }>('SELECT platform_id FROM key_platforms WHERE key_id=$1', [key.id])).map((r) => r.platform_id);
      const extra = (await db.query<{ id: number }>(`SELECT id FROM platforms WHERE name IN ('Dashboard','Customer PANEL')`)).map((r) => r.id);
      await app.inject({ method: 'PUT', url: `/api/keys/${key.id}/platforms`, headers: h, payload: { platformIds: [...new Set([...cur, ...extra])] } });
      console.log('Shared key "all" assigned to segments neworder/vieworder/table list and platforms Dispatcher, Dashboard, Customer PANEL.');
    }
    await app.close();
  }
} else {
  console.log('Workbook already imported; skipping.');
}
console.log('Dev accounts are listed at the top of server/cli/seed-dev.ts');
await db.close();
