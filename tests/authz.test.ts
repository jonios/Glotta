import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, createUser, ids, importWorkbook, keyOn, login, type Client, type TestEnv } from './helpers.js';

let env: TestEnv;
let L: (c: string) => number;
let P: (n: string) => number;
let admin: Client;
let italian: Client;
let persianViewer: Client;
let wsKey: { id: number };
let dispatcherOnlyKey: { id: number };

beforeAll(async () => {
  env = await createEnv();
  const adminId = await createUser(env.db, { email: 'admin@tms.test', role: 'super_admin' });
  await importWorkbook(env.db, adminId);
  ({ lang: L, plat: P } = await ids(env.db));
  // Scenario B: Italian only, Web Service + Dashboard, view English, edit Italian, export.
  await createUser(env.db, {
    email: 'italian@tms.test',
    role: 'translator',
    caps: ['view', 'view_source', 'edit_translations', 'export'],
    languages: [L('it')],
    platforms: [P('Web Service'), P('Dashboard')],
  });
  // Scenario F: one language, one platform, read-only.
  await createUser(env.db, { email: 'viewer@tms.test', role: 'viewer', caps: ['view', 'view_source', 'export'], languages: [L('fa')], platforms: [P('Dispatcher')] });
  admin = await login(env.app, 'admin@tms.test');
  italian = await login(env.app, 'italian@tms.test');
  persianViewer = await login(env.app, 'viewer@tms.test');
  wsKey = (await keyOn(env.db, 'Web Service', 'Error'))!;
  dispatcherOnlyKey = (await env.db.one(
    `SELECT k.id FROM translation_keys k WHERE EXISTS (SELECT 1 FROM key_platforms kp WHERE kp.key_id=k.id AND kp.platform_id=$1)
     AND NOT EXISTS (SELECT 1 FROM key_platforms kp WHERE kp.key_id=k.id AND kp.platform_id = ANY($2::int[])) LIMIT 1`,
    [P('Dispatcher'), [P('Web Service'), P('Dashboard')]],
  ))!;
  // A French value only an all-language user may see.
  await admin.put('/api/translations', { keyId: wsKey.id, languageId: L('fr'), value: 'ZZFRENCHSECRET', status: 'approved', expectedVersion: (await env.db.one('SELECT version FROM translations WHERE key_id=$1 AND language_id=$2', [wsKey.id, L('fr')]))?.version ?? null });
});
afterAll(async () => env?.close());

describe('authentication', () => {
  it('rejects unauthenticated requests and requests without the CSRF token', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/api/keys' })).statusCode).toBe(401);
    const noCsrf = await env.app.inject({ method: 'PUT', url: '/api/translations', headers: { cookie: italian.cookie }, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error).toBe('csrf');
  });

  it('rejects wrong passwords and deactivated users', async () => {
    const bad = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'italian@tms.test', password: 'wrong-password' } });
    expect(bad.statusCode).toBe(401);
    const id = await createUser(env.db, { email: 'gone@tms.test', role: 'viewer', caps: ['view'] });
    await env.db.query('UPDATE users SET is_active=false WHERE id=$1', [id]);
    await expect(login(env.app, 'gone@tms.test')).rejects.toThrow(/401/);
  });
});

describe('Scenario B — Italian translator (Web Service + Dashboard)', () => {
  it('sees only the assigned platforms', async () => {
    const res = await italian.get('/api/platforms');
    expect(res.json().map((p: any) => p.name).sort()).toEqual(['Dashboard', 'Web Service']);
  });

  it('sees English sources and only Italian translations in the workspace', async () => {
    const res = await italian.get('/api/keys?pageSize=500');
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.languageIds).toEqual([L('it')]);
    expect(body.total).toBeGreaterThan(500);
    for (const row of body.rows) {
      expect(Object.keys(row.translations).every((k) => Number(k) === L('it'))).toBe(true);
      expect(row.platforms.every((p: any) => ['Web Service', 'Dashboard'].includes(p.name))).toBe(true);
    }
    expect(body.rows.some((r: any) => r.sourceText)).toBe(true);
  });

  it('cannot request other languages or platforms through query parameters', async () => {
    expect((await italian.get(`/api/keys?languageIds=${L('fr')}`)).statusCode).toBe(403);
    expect((await italian.get(`/api/keys?languageIds=${L('it')},${L('fa')}`)).statusCode).toBe(403);
    expect((await italian.get(`/api/keys?platformIds=${P('Dispatcher')}`)).statusCode).toBe(403);
    expect((await italian.get(`/api/keys/${dispatcherOnlyKey.id}`)).statusCode).toBe(404);
    expect((await italian.get(`/api/keys/${wsKey.id}?languageIds=${L('fr')}`)).statusCode).toBe(403);
    const detail = (await italian.get(`/api/keys/${wsKey.id}`)).json();
    expect(Object.keys(detail.translations).map(Number)).toEqual(Object.keys(detail.translations).length ? [L('it')] : []);
    expect(detail.alternates.every((a: any) => a.languageId === L('it'))).toBe(true);
  });

  it('search does not match values in unauthorised languages', async () => {
    const res = await italian.get('/api/keys?search=ZZFRENCHSECRET');
    expect(res.json().total).toBe(0);
    const adminRes = await admin.get('/api/keys?search=ZZFRENCHSECRET');
    expect(adminRes.json().total).toBe(1);
  });

  it('can create and update Italian translations with optimistic concurrency', async () => {
    const v1 = await italian.put('/api/translations', { keyId: wsKey.id, languageId: L('it'), value: 'Si è verificato un errore', status: 'needs_review', expectedVersion: null });
    expect(v1.statusCode).toBe(200);
    expect(v1.json().status).toBe('needs_review');
    const stale = await italian.put('/api/translations', { keyId: wsKey.id, languageId: L('it'), value: 'Altro', status: 'needs_review', expectedVersion: null });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().details.current.value).toBe('Si è verificato un errore');
    const v2 = await italian.put('/api/translations', { keyId: wsKey.id, languageId: L('it'), value: 'Errore', status: 'draft', expectedVersion: v1.json().version });
    expect(v2.statusCode).toBe(200);
    // Two editors starting from the same version: the second save is rejected, not merged.
    const a = await italian.put('/api/translations', { keyId: wsKey.id, languageId: L('it'), value: 'A', status: 'draft', expectedVersion: v2.json().version });
    const b = await admin.put('/api/translations', { keyId: wsKey.id, languageId: L('it'), value: 'B', status: 'draft', expectedVersion: v2.json().version });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(409);
  });

  it('cannot edit other languages, the source string, unassigned platforms, or approve', async () => {
    expect((await italian.put('/api/translations', { keyId: wsKey.id, languageId: L('fr'), value: 'x', status: 'draft', expectedVersion: 1 })).statusCode).toBe(403);
    expect((await italian.put('/api/translations', { keyId: wsKey.id, languageId: L('en'), value: 'x', status: 'draft', expectedVersion: null })).statusCode).toBe(400);
    expect((await italian.put('/api/translations', { keyId: dispatcherOnlyKey.id, languageId: L('it'), value: 'x', status: 'draft', expectedVersion: null })).statusCode).toBe(404);
    expect((await italian.put('/api/translations', { keyId: wsKey.id, languageId: L('it'), value: 'x', status: 'approved', expectedVersion: null })).statusCode).toBe(403);
    const key = await env.db.one('SELECT version FROM translation_keys WHERE id=$1', [wsKey.id]);
    expect((await italian.patch(`/api/keys/${wsKey.id}`, { expectedVersion: key.version, sourceText: 'hacked' })).statusCode).toBe(403);
    expect((await italian.put(`/api/keys/${wsKey.id}/segments`, { segmentIds: [] })).statusCode).toBe(403);
    expect((await italian.put(`/api/keys/${wsKey.id}/platforms`, { platformIds: [P('Dispatcher')] })).statusCode).toBe(403);
    expect((await italian.post('/api/keys/bulk', { keyIds: [wsKey.id], archive: true })).statusCode).toBe(403);
    expect((await italian.post('/api/translations/bulk-review', { items: [{ keyId: wsKey.id, languageId: L('it') }], action: 'approve' })).statusCode).toBe(403);
    const fr = await env.db.one('SELECT value FROM translations WHERE key_id=$1 AND language_id=$2', [wsKey.id, L('fr')]);
    expect(fr.value).toBe('ZZFRENCHSECRET');
  });

  it('cannot reach administrative endpoints', async () => {
    expect((await italian.get('/api/users')).statusCode).toBe(403);
    expect((await italian.post('/api/languages', { code: 'xx', name: 'X' })).statusCode).toBe(403);
    expect((await italian.patch(`/api/platforms/${P('Web Service')}`, { name: 'x' })).statusCode).toBe(403);
    expect((await italian.put('/api/settings', { organization_name: 'x' })).statusCode).toBe(403);
    expect((await italian.get('/api/import/jobs')).statusCode).toBe(403);
  });

  it('exports only Italian (and English) for its platforms; widening attempts are rejected', async () => {
    expect((await italian.post('/api/export/resources', { format: 'json', languageIds: [L('fr')] })).statusCode).toBe(403);
    expect((await italian.post('/api/export/resources', { format: 'json', platformIds: [P('Dispatcher')] })).statusCode).toBe(403);
    expect((await italian.post('/api/export/excel', { layout: 'normalized', languageIds: [L('de')] })).statusCode).toBe(403);
    const res = await italian.post('/api/export/resources', { format: 'json', zip: true });
    expect(res.statusCode).toBe(200);
    const zip = await JSZip.loadAsync(res.rawPayload);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    expect(names.sort()).toEqual(['dashboard/en.json', 'dashboard/it.json', 'web-service/en.json', 'web-service/it.json']);
    const it = JSON.parse(await zip.file('web-service/it.json')!.async('string'));
    expect(Object.values(it)).not.toContain('ZZFRENCHSECRET');

    const xl = await italian.post('/api/export/excel', { layout: 'legacy' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xl.rawPayload as any);
    expect(wb.worksheets.map((w) => w.name).sort()).toEqual(['Dashboard', 'Web Service']);
    const ws = wb.getWorksheet('Web Service')!;
    const headers = (ws.getRow(1).values as any[]).filter(Boolean).map(String);
    expect(headers).toEqual(['Keyword', 'English', 'Italian']);
    for (let r = 1; r <= ws.rowCount; r++) {
      expect((ws.getRow(r).values as any[]).includes('ZZFRENCHSECRET')).toBe(false);
    }
  });

  it('dashboard statistics are limited to the scope', async () => {
    const d = (await italian.get('/api/dashboard')).json();
    expect(d.byLanguage.map((l: any) => l.code)).toEqual(['it']);
    expect(d.byPlatform.map((p: any) => p.name).sort()).toEqual(['Dashboard', 'Web Service']);
    expect(d.totals.languages).toBe(1);
  });

  it('audit log shows only the translator’s own actions', async () => {
    const a = (await italian.get('/api/audit')).json();
    expect(a.scoped).toBe('own');
    expect(a.rows.length).toBeGreaterThan(0);
    expect(a.rows.every((r: any) => r.actorEmail === 'italian@tms.test')).toBe(true);
  });
});

describe('Scenario F — one language, one platform, read-only', () => {
  it('reads only Persian on Dispatcher and cannot write', async () => {
    const res = (await persianViewer.get('/api/keys?pageSize=200')).json();
    expect(res.languageIds).toEqual([L('fa')]);
    expect(res.rows.every((r: any) => r.platforms.every((p: any) => p.name === 'Dispatcher'))).toBe(true);
    const k = res.rows[0];
    expect((await persianViewer.put('/api/translations', { keyId: k.id, languageId: L('fa'), value: 'x', status: 'draft', expectedVersion: k.translations[L('fa')]?.version ?? null })).statusCode).toBe(403);
    expect((await persianViewer.get(`/api/keys?platformIds=${P('Web Service')}`)).statusCode).toBe(403);
    expect((await persianViewer.post('/api/export/resources', { format: 'android', languageIds: [L('ar')] })).statusCode).toBe(403);
    const exp = await persianViewer.post('/api/export/resources', { format: 'android', zip: true });
    const zip = await JSZip.loadAsync(exp.rawPayload);
    const files = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    expect(files.filter((n) => n.endsWith('.xml')).sort()).toEqual(['values-fa/strings.xml', 'values/strings.xml']);
    const langs = (await persianViewer.get('/api/languages')).json();
    expect(langs.map((l: any) => l.code).sort()).toEqual(['en', 'fa']);
  });
});

describe('review workflow', () => {
  it('needs_review → request changes (comment required) → in_progress → approved; source change reopens', async () => {
    const managerId = await createUser(env.db, {
      email: 'manager@tms.test',
      role: 'manager',
      caps: ['view', 'view_source', 'review', 'approve', 'edit_translations', 'edit_source'],
      allLanguages: true,
      allPlatforms: true,
    });
    expect(managerId).toBeGreaterThan(0);
    const mgr = await login(env.app, 'manager@tms.test');
    const key = (await keyOn(env.db, 'Dashboard', 'Username'))!;
    const cur = await env.db.one('SELECT version FROM translations WHERE key_id=$1 AND language_id=$2', [key.id, L('it')]);
    const saved = (await italian.put('/api/translations', { keyId: key.id, languageId: L('it'), value: 'Nome utente', status: 'needs_review', expectedVersion: cur?.version ?? null })).json();
    expect(saved.status).toBe('needs_review');
    const noComment = await mgr.post(`/api/translations/${saved.id}/review`, { action: 'request_changes' });
    expect(noComment.statusCode).toBe(400);
    expect((await mgr.post(`/api/translations/${saved.id}/review`, { action: 'request_changes', comment: 'Use "Nome utente" capitalised' })).json().status).toBe('in_progress');
    // The review queue carries the reviewer's note for returned translations.
    const returned = (await italian.get(`/api/keys?languageIds=${L('it')}&statuses=in_progress&q=Username`)).json();
    expect(returned.rows.find((r: any) => r.id === key.id).translations[L('it')].feedback).toMatchObject({ comment: 'Use "Nome utente" capitalised', reviewer: expect.any(String) });
    expect((await italian.post(`/api/translations/${saved.id}/review`, { action: 'approve' })).statusCode).toBe(403);
    expect((await mgr.post(`/api/translations/${saved.id}/review`, { action: 'approve' })).json().status).toBe('approved');
    const t = await env.db.one('SELECT status, approved_by, reviewed_by FROM translations WHERE id=$1', [saved.id]);
    expect(t).toMatchObject({ status: 'approved', approved_by: managerId, reviewed_by: managerId });
    const k = await env.db.one('SELECT version FROM translation_keys WHERE id=$1', [key.id]);
    expect((await mgr.patch(`/api/keys/${key.id}`, { expectedVersion: k.version, sourceText: 'User name' })).statusCode).toBe(200);
    expect(await env.db.one('SELECT status, source_changed FROM translations WHERE id=$1', [saved.id])).toEqual({ status: 'in_progress', source_changed: true });
    // Stale key version is rejected.
    expect((await mgr.patch(`/api/keys/${key.id}`, { expectedVersion: k.version, sourceText: 'Again' })).statusCode).toBe(409);
    // Saving an empty value returns the translation to "missing", never "complete".
    const v = await env.db.one('SELECT version FROM translations WHERE id=$1', [saved.id]);
    expect((await mgr.put('/api/translations', { keyId: key.id, languageId: L('it'), value: '', status: 'approved', expectedVersion: v.version })).json().status).toBe('missing');
  });
});

describe('Scenario C — shared keyword "all"', () => {
  it('assigns several segments and platforms to one key without mixing platform-specific keys', async () => {
    const all = (await keyOn(env.db, 'Dispatcher', 'all'))!;
    // Create the segment, or reuse it when the workbook import already created one with that name.
    const seg = async (name: string) => {
      const res = await admin.post('/api/segments', { name });
      if (res.statusCode === 200) return res.json().id as number;
      expect(res.statusCode).toBe(409);
      return (await admin.get(`/api/segments?search=${encodeURIComponent(name)}`)).json().find((s: any) => s.name.toLowerCase() === name).id as number;
    };
    const segs = [await seg('neworder'), await seg('vieworder'), await seg('table list')];
    expect((await admin.put(`/api/keys/${all.id}/segments`, { segmentIds: segs })).statusCode).toBe(200);
    const plats = [P('Dispatcher'), P('Dashboard'), P('Customer PANEL')];
    const current = (await env.db.query<{ platform_id: number }>('SELECT platform_id FROM key_platforms WHERE key_id=$1', [all.id])).map((r) => r.platform_id);
    expect((await admin.put(`/api/keys/${all.id}/platforms`, { platformIds: [...new Set([...current, ...plats])] })).statusCode).toBe(200);
    const detail = (await admin.get(`/api/keys/${all.id}`)).json();
    expect(detail.segments.map((s: any) => s.name.toLowerCase()).sort()).toEqual(['neworder', 'table list', 'vieworder']);
    expect(detail.platforms.map((p: any) => p.name)).toEqual(expect.arrayContaining(['Dispatcher', 'Dashboard', 'Customer PANEL']));
    // Dashboard's own "All" (different identifier, different strings) is untouched.
    const dashAll = await keyOn(env.db, 'Dashboard', 'All');
    expect(dashAll!.id).not.toBe(all.id);
    // One translation serves every platform using the shared key.
    const cur = await env.db.one('SELECT version FROM translations WHERE key_id=$1 AND language_id=$2', [all.id, L('it')]);
    await admin.put('/api/translations', { keyId: all.id, languageId: L('it'), value: 'Tutti', status: 'approved', expectedVersion: cur?.version ?? null });
    for (const p of ['Dispatcher', 'Dashboard', 'Customer PANEL']) {
      const exp = await admin.post('/api/export/resources', { format: 'json', platformIds: [P(p)], languageIds: [L('it')], includeSource: false });
      expect(JSON.parse(exp.body).all, p).toBe('Tutti');
    }
    // The Italian translator (Dashboard in scope) sees the key but not the Dispatcher/Customer PANEL names.
    const it = (await italian.get(`/api/keys/${all.id}`)).json();
    expect(it.platforms.map((p: any) => p.name)).toEqual(['Dashboard']);
    expect(it.hiddenPlatformCount).toBeGreaterThanOrEqual(2);
  });

  it('refuses to attach a key to a platform that already has a different key with the same identifier', async () => {
    const block = (await keyOn(env.db, 'Customer PANEL', 'block'))!;
    const res = await admin.put(`/api/keys/${block.id}/platforms`, { platformIds: [P('Customer PANEL'), P('Dispatcher')] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('identifier_conflict');
  });

  it('splits a shared key into a platform-specific key that can diverge', async () => {
    const all = (await keyOn(env.db, 'Dispatcher', 'all'))!;
    const res = await admin.post(`/api/keys/${all.id}/split`, { platformId: P('Customer PANEL') });
    expect(res.statusCode).toBe(200);
    const cp = (await keyOn(env.db, 'Customer PANEL', 'all'))!;
    expect(cp.id).toBe(res.json().id);
    expect(cp.id).not.toBe(all.id);
    const v = await env.db.one('SELECT version, value FROM translations WHERE key_id=$1 AND language_id=$2', [cp.id, L('it')]);
    expect(v.value).toBe('Tutti');
    await admin.put('/api/translations', { keyId: cp.id, languageId: L('it'), value: 'Tutte', status: 'approved', expectedVersion: v.version });
    const shared = await env.db.one('SELECT value FROM translations WHERE key_id=$1 AND language_id=$2', [all.id, L('it')]);
    expect(shared.value).toBe('Tutti');
  });

  it('picks the namespace automatically when a new key is created without one', async () => {
    const fresh = await admin.post('/api/keys', { identifier: 'brand_new_probe', sourceText: 'Probe', platformIds: [P('Dashboard')] });
    expect(fresh.statusCode).toBe(200);
    expect((await env.db.one('SELECT namespace FROM translation_keys WHERE id=$1', [fresh.json().id])).namespace).toBe('shared');
    // Same name again on another platform: "shared" is taken, so the platform's slug is used instead of failing.
    const again = await admin.post('/api/keys', { identifier: 'brand_new_probe', sourceText: 'Other meaning', platformIds: [P('Dispatcher')] });
    expect(again.statusCode).toBe(200);
    const slug = (await env.db.one('SELECT slug FROM platforms WHERE id=$1', [P('Dispatcher')])).slug;
    expect((await env.db.one('SELECT namespace FROM translation_keys WHERE id=$1', [again.json().id])).namespace).toBe(slug);
    // An explicit namespace still refuses duplicates.
    const dup = await admin.post('/api/keys', { namespace: 'shared', identifier: 'brand_new_probe', platformIds: [P('Web Service')] });
    expect(dup.statusCode).toBe(409);
  });
});

describe('user administration', () => {
  it('creates an invited translator with scoped access and an invite link that sets the password', async () => {
    const res = await admin.post('/api/users', {
      email: 'new.it@tms.test',
      name: 'Italian Translator',
      role: 'translator',
      capabilities: ['view', 'view_source', 'edit_translations', 'export'],
      allLanguages: false,
      languageIds: [L('it')],
      allPlatforms: false,
      platformIds: [P('Web Service'), P('Dashboard')],
    });
    expect(res.statusCode).toBe(200);
    const token = new URL(res.json().inviteUrl).searchParams.get('token')!;
    expect((await env.app.inject({ method: 'POST', url: '/api/auth/accept-invite', payload: { token, password: 'short' } })).statusCode).toBe(400);
    expect((await env.app.inject({ method: 'POST', url: '/api/auth/accept-invite', payload: { token, password: 'a-long-password-1' } })).statusCode).toBe(200);
    const c = await login(env.app, 'new.it@tms.test', 'a-long-password-1');
    expect((await c.get('/api/platforms')).json().length).toBe(2);
    const audit = await env.db.one(`SELECT after FROM audit_logs WHERE action='user.invited' ORDER BY id DESC LIMIT 1`);
    expect(audit.after.languages).toEqual(['it']);
    expect(JSON.stringify(audit)).not.toMatch(/password|token/i);
  });

  it('reserves user management and invitations for Super Admins and keeps one Super Admin', async () => {
    // Even with the manage_users capability, a non-Super-Admin can't list, invite, edit, deactivate or reset users.
    const umId = await createUser(env.db, { email: 'um@tms.test', role: 'manager', caps: ['view', 'manage_users'], languages: [L('it')], platforms: [P('Dashboard')] });
    const um = await login(env.app, 'um@tms.test');
    const base = { name: 'x', role: 'translator', allLanguages: false, allPlatforms: false, languageIds: [L('it')], platformIds: [P('Dashboard')] };
    expect((await um.get('/api/users')).statusCode).toBe(403);
    expect((await um.post('/api/users', { ...base, email: 'd@tms.test', capabilities: ['view'] })).statusCode).toBe(403);
    expect((await um.patch(`/api/users/${umId}`, { ...base, capabilities: ['view'] })).statusCode).toBe(403);
    expect((await um.post(`/api/users/${umId}/status`, { isActive: true })).statusCode).toBe(403);
    expect((await um.post(`/api/users/${umId}/reset-access`)).statusCode).toBe(403);
    expect((await um.get(`/api/users/${umId}/activity`)).statusCode).toBe(403);
    expect(await env.db.one(`SELECT 1 FROM users WHERE email='d@tms.test'`)).toBeUndefined();
    const adminRow = await env.db.one(`SELECT id FROM users WHERE email='admin@tms.test'`);
    const self = await admin.post(`/api/users/${adminRow.id}/status`, { isActive: false });
    expect(self.statusCode).toBe(400);
    const demote = await admin.patch(`/api/users/${adminRow.id}`, { name: 'a', role: 'manager', capabilities: ['view'], allLanguages: true, languageIds: [], allPlatforms: true, platformIds: [] });
    expect(demote.statusCode).toBe(400);
  });

  it('deactivation revokes existing sessions immediately', async () => {
    const id = await createUser(env.db, { email: 'tmp@tms.test', role: 'viewer', caps: ['view'], allLanguages: true, allPlatforms: true });
    const c = await login(env.app, 'tmp@tms.test');
    expect((await c.get('/api/platforms')).statusCode).toBe(200);
    expect((await admin.post(`/api/users/${id}/status`, { isActive: false })).statusCode).toBe(200);
    expect((await c.get('/api/platforms')).statusCode).toBe(401);
  });
});
