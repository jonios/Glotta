import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, createUser, ids, importWorkbook, login, type Client, type TestEnv } from './helpers.js';

let env: TestEnv;
let L: (c: string) => number;
let P: (n: string) => number;
let admin: Client;
let manager: Client;
let managerId: number;
let translator: Client;
let adminKey: string;
let managerKey: string;

/** Calls the public API the way an external app would: no cookie, just the key. */
const call = (url: string, key?: string | null, headers: Record<string, string> = {}) =>
  env.app.inject({ method: 'GET', url, headers: key ? { authorization: `Bearer ${key}`, ...headers } : headers });

beforeAll(async () => {
  env = await createEnv();
  const adminId = await createUser(env.db, { email: 'admin@tms.test', role: 'super_admin' });
  await importWorkbook(env.db, adminId);
  ({ lang: L, plat: P } = await ids(env.db));
  // A manager limited to Italian on Web Service + Dashboard.
  managerId = await createUser(env.db, {
    email: 'manager@tms.test',
    role: 'manager',
    caps: ['view', 'view_source', 'edit_translations', 'review', 'approve', 'export'],
    languages: [L('it')],
    platforms: [P('Web Service'), P('Dashboard')],
  });
  await createUser(env.db, { email: 'translator@tms.test', role: 'translator', caps: ['view', 'view_source', 'edit_translations'], allLanguages: true, allPlatforms: true });
  admin = await login(env.app, 'admin@tms.test');
  manager = await login(env.app, 'manager@tms.test');
  translator = await login(env.app, 'translator@tms.test');
  adminKey = (await admin.post('/api/api-keys', { name: 'Admin build server' })).json().key;
  managerKey = (await manager.post('/api/api-keys', { name: 'Italian web app', expiresInDays: 30 })).json().key;
});
afterAll(async () => env?.close());

describe('API key management', () => {
  it('lets Super Admins and Managers create keys, shown once and stored only as a hash', async () => {
    expect(adminKey).toMatch(/^glt_[A-Za-z0-9_-]{40}$/);
    const stored = await env.db.one(`SELECT key_hash, prefix FROM api_keys WHERE name='Admin build server'`);
    expect(stored.key_hash).not.toContain(adminKey);
    expect(adminKey.startsWith(stored.prefix)).toBe(true);
    const list = (await admin.get('/api/api-keys')).json();
    expect(JSON.stringify(list)).not.toContain(adminKey);
    expect(list.find((k: any) => k.name === 'Italian web app').expiresAt).toBeTruthy();
    const audit = await env.db.query(`SELECT after FROM audit_logs WHERE action='api_key.created'`);
    expect(audit.length).toBe(2);
    expect(JSON.stringify(audit)).not.toContain(adminKey);
  });

  it('keeps translators and viewers out of key management', async () => {
    expect((await translator.get('/api/api-keys')).statusCode).toBe(403);
    expect((await translator.post('/api/api-keys', { name: 'x' })).statusCode).toBe(403);
  });

  it('shows Managers only their own keys; Super Admins see and revoke every key', async () => {
    const mine = (await manager.get('/api/api-keys')).json();
    expect(mine.map((k: any) => k.name)).toEqual(['Italian web app']);
    const all = (await admin.get('/api/api-keys')).json();
    expect(all.map((k: any) => k.name).sort()).toEqual(['Admin build server', 'Italian web app']);
    const adminKeyId = all.find((k: any) => k.name === 'Admin build server').id;
    expect((await manager.post(`/api/api-keys/${adminKeyId}/revoke`)).statusCode).toBe(404);
  });

  it('validates the key name', async () => {
    const res = await manager.post('/api/api-keys', { name: '   ' });
    expect(res.statusCode).toBe(400);
  });
});

describe('public API authentication', () => {
  it('rejects requests without a key, with an unknown key, or with only a session cookie', async () => {
    const none = await call('/api/v1/languages');
    expect(none.statusCode).toBe(401);
    expect(none.json().error).toBe('missing_api_key');
    const bad = await call('/api/v1/languages', 'glt_not-a-real-key');
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe('invalid_api_key');
    const cookieOnly = await env.app.inject({ method: 'GET', url: '/api/v1/languages', headers: { cookie: admin.cookie } });
    expect(cookieOnly.statusCode).toBe(401);
  });

  it('accepts the key as a Bearer token or in X-API-Key, and records its use', async () => {
    expect((await call('/api/v1/languages', adminKey)).statusCode).toBe(200);
    expect((await call('/api/v1/languages', null, { 'x-api-key': adminKey })).statusCode).toBe(200);
    const row = await env.db.one(`SELECT use_count, last_used_at FROM api_keys WHERE name='Admin build server'`);
    expect(row.use_count).toBeGreaterThanOrEqual(2);
    expect(row.last_used_at).toBeTruthy();
  });

  it('allows cross-origin browser calls (CORS) including the preflight', async () => {
    const pre = await env.app.inject({ method: 'OPTIONS', url: '/api/v1/languages/it/keywords', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    expect(String(pre.headers['access-control-allow-headers'])).toContain('Authorization');
    const res = await call('/api/v1/languages', adminKey);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('GET /api/v1/languages and /api/v1/platforms', () => {
  it('lists every active language for a Super Admin key', async () => {
    const res = await call('/api/v1/languages', adminKey);
    const { languages } = res.json();
    expect(languages[0]).toEqual({
      code: 'en',
      name: 'English',
      nativeName: expect.any(String),
      direction: 'ltr',
      isSource: true,
      versions: expect.objectContaining({ 'ios-driver': expect.any(Number), 'web-service': expect.any(Number) }),
      updatedAt: expect.any(String),
    });
    expect(Object.keys(languages[0].versions).length).toBe(12);
    expect(languages.length).toBe(30);
    expect(languages.find((l: any) => l.code === 'fa').direction).toBe('rtl');
    expect(languages[0].id).toBeUndefined();
  });

  it('limits a Manager key to the Manager’s languages and platforms', async () => {
    const langs = (await call('/api/v1/languages', managerKey)).json().languages.map((l: any) => l.code);
    expect(langs).toEqual(['en', 'it']);
    const plats = (await call('/api/v1/platforms', managerKey)).json().platforms.map((p: any) => p.slug).sort();
    expect(plats).toEqual(['dashboard', 'web-service']);
  });
});

describe('GET /api/v1/languages/:code/keywords', () => {
  it('returns { keyword: translation } with approved values for one platform', async () => {
    const res = await call('/api/v1/languages/it/keywords?platform=web-service', managerKey);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body).toBe('object');
    expect(Object.values(body).every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
    expect(res.headers['x-keyword-count']).toBe(String(Object.keys(body).length));
    expect(res.headers['x-language']).toBe('it');
    // Compare one value with the database.
    const expected = await env.db.one(
      `SELECT kp.identifier, t.value FROM key_platforms kp JOIN translations t ON t.key_id=kp.key_id
       JOIN translation_keys k ON k.id=kp.key_id
       WHERE kp.platform_id=$1 AND t.language_id=$2 AND t.status='approved' AND t.value<>'' AND NOT k.is_archived LIMIT 1`,
      [P('Web Service'), L('it')],
    );
    expect(body[expected.identifier]).toBe(expected.value);
  });

  it('matches language codes case-insensitively and returns English source text for "en"', async () => {
    const it1 = (await call('/api/v1/languages/IT/keywords?platform=web-service', managerKey)).json();
    const en = (await call('/api/v1/languages/en/keywords?platform=web-service', managerKey)).json();
    expect(Object.keys(it1).length).toBeGreaterThan(0);
    const src = await env.db.one(
      `SELECT kp.identifier, k.source_text FROM key_platforms kp JOIN translation_keys k ON k.id=kp.key_id
       WHERE kp.platform_id=$1 AND k.source_text<>'' AND NOT k.is_archived LIMIT 1`,
      [P('Web Service')],
    );
    expect(en[src.identifier]).toBe(src.source_text);
  });

  it('includes unapproved values only with status=any, and fills gaps from English with fallback=source', async () => {
    const row = await env.db.one(
      `SELECT kp.identifier, k.id AS key_id, k.source_text FROM key_platforms kp JOIN translation_keys k ON k.id=kp.key_id
       WHERE kp.platform_id=$1 AND k.source_text<>'' AND NOT k.is_archived ORDER BY kp.identifier LIMIT 1`,
      [P('Dashboard')],
    );
    const cur = await env.db.one('SELECT version FROM translations WHERE key_id=$1 AND language_id=$2', [row.key_id, L('it')]);
    expect((await admin.put('/api/translations', { keyId: row.key_id, languageId: L('it'), value: 'Bozza di prova', status: 'draft', expectedVersion: cur?.version ?? null })).statusCode).toBe(200);
    const approvedOnly = (await call('/api/v1/languages/it/keywords?platform=dashboard', managerKey)).json();
    expect(approvedOnly[row.identifier]).toBeUndefined();
    const any = (await call('/api/v1/languages/it/keywords?platform=dashboard&status=any', managerKey)).json();
    expect(any[row.identifier]).toBe('Bozza di prova');
    const fallback = (await call('/api/v1/languages/it/keywords?platform=dashboard&fallback=source', managerKey)).json();
    expect(fallback[row.identifier]).toBe(row.source_text);
  });

  it('merges all platforms in scope when no platform is given, one value per keyword', async () => {
    const all = (await call('/api/v1/languages/it/keywords', managerKey)).json();
    const ws = (await call('/api/v1/languages/it/keywords?platform=web-service', managerKey)).json();
    const db = (await call('/api/v1/languages/it/keywords?platform=dashboard', managerKey)).json();
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(Math.max(Object.keys(ws).length, Object.keys(db).length));
    expect(Object.keys(all).length).toBeLessThanOrEqual(Object.keys(ws).length + Object.keys(db).length);
  });

  it('returns clear errors for unknown or forbidden languages and platforms and bad parameters', async () => {
    const expectError = async (url: string, status: number, error: string) => {
      const res = await call(url, managerKey);
      expect(res.statusCode).toBe(status);
      expect(res.json().error).toBe(error);
    };
    await expectError('/api/v1/languages/xx/keywords', 404, 'language_not_found');
    await expectError('/api/v1/languages/fr/keywords', 403, 'language_forbidden');
    await expectError('/api/v1/languages/it/keywords?platform=nope', 404, 'platform_not_found');
    await expectError('/api/v1/languages/it/keywords?platform=dispatcher', 403, 'platform_forbidden');
    await expectError('/api/v1/languages/it/keywords?status=done', 400, 'validation_error');
  });
});

describe('content versions (per platform × language)', () => {
  /** Current versions of every language for one platform, read through the API. */
  const versionsOf = async (platform: string) => {
    const res = await call(`/api/v1/languages?platform=${platform}`, adminKey);
    expect(res.statusCode).toBe(200);
    return Object.fromEntries(res.json().languages.map((l: any) => [l.code, l.version])) as Record<string, number>;
  };
  /** A key that lives only on Web Service, so other platforms must stay untouched. */
  const webOnlyKey = async () =>
    (await env.db.one(
      `SELECT k.id FROM translation_keys k JOIN key_platforms kp ON kp.key_id=k.id AND kp.platform_id=$1
       WHERE NOT k.is_archived AND (SELECT count(*) FROM key_platforms x WHERE x.key_id=k.id)=1 ORDER BY k.id LIMIT 1`,
      [P('Web Service')],
    ))!;
  const save = async (keyId: number, lang: string, value: string, status = 'approved') => {
    const cur = await env.db.one('SELECT version FROM translations WHERE key_id=$1 AND language_id=$2', [keyId, L(lang)]);
    const res = await admin.put('/api/translations', { keyId, languageId: L(lang), value, status, expectedVersion: cur?.version ?? null });
    expect(res.statusCode).toBe(200);
  };

  it('returns one version per platform, and a single version with ?platform=', async () => {
    const res = await call('/api/v1/languages?platform=web-service', adminKey);
    const fa = res.json().languages.find((l: any) => l.code === 'fa');
    expect(fa.version).toBeGreaterThanOrEqual(1);
    expect(fa.versions).toEqual({ 'web-service': fa.version });
    expect((await call('/api/v1/languages?platform=nope', adminKey)).statusCode).toBe(404);
    expect((await call('/api/v1/languages?platform=dispatcher', managerKey)).statusCode).toBe(403);
    const kw = await call('/api/v1/languages/fa/keywords?platform=web-service', adminKey);
    expect(kw.headers['x-content-version']).toBe(String(fa.version));
  });

  it('bumps only that language on that platform when a translation changes', async () => {
    const key = await webOnlyKey();
    const [wsBefore, dashBefore] = [await versionsOf('web-service'), await versionsOf('dashboard')];
    await save(key.id, 'de', 'Neuer Text für den Test');
    const [wsAfter, dashAfter] = [await versionsOf('web-service'), await versionsOf('dashboard')];
    expect(wsAfter.de).toBe(wsBefore.de + 1);
    expect(wsAfter.fr).toBe(wsBefore.fr);
    expect(wsAfter.en).toBe(wsBefore.en);
    expect(dashAfter).toEqual(dashBefore);
  });

  it('does not bump when a save changes nothing, and bumps on review status changes', async () => {
    const key = await webOnlyKey();
    const before = await versionsOf('web-service');
    await save(key.id, 'de', 'Neuer Text für den Test');
    expect((await versionsOf('web-service')).de).toBe(before.de);
    const t = await env.db.one('SELECT id, version FROM translations WHERE key_id=$1 AND language_id=$2', [key.id, L('de')]);
    expect((await admin.post(`/api/translations/${t.id}/review`, { action: 'request_changes', comment: 'Bitte prüfen', expectedVersion: t.version })).statusCode).toBe(200);
    expect((await versionsOf('web-service')).de).toBe(before.de + 1);
  });

  it('bumps every language of a platform when its keyword set changes', async () => {
    const before = await versionsOf('web-service');
    const dashBefore = await versionsOf('dashboard');
    const created = await admin.post('/api/keys', { identifier: 'version_probe_key', sourceText: 'Probe', platformIds: [P('Web Service')] });
    expect(created.statusCode).toBe(200);
    const after = await versionsOf('web-service');
    for (const code of Object.keys(before)) expect(after[code]).toBe(before[code] + 1);
    expect(await versionsOf('dashboard')).toEqual(dashBefore);

    // Editing the English source and archiving the key change the keyword set again.
    const k = await env.db.one('SELECT version FROM translation_keys WHERE id=$1', [created.json().id]);
    expect((await admin.patch(`/api/keys/${created.json().id}`, { expectedVersion: k.version, sourceText: 'Probe 2' })).statusCode).toBe(200);
    const afterSource = await versionsOf('web-service');
    expect(afterSource.en).toBe(after.en + 1);
    expect(afterSource.fr).toBe(after.fr + 1);
  });

  it('bumps the right platforms when a key is shared with or removed from a platform', async () => {
    // A Web-Service-only key whose identifier is free on Dashboard, so it can be shared there.
    const key = (await env.db.one(
      `SELECT k.id FROM translation_keys k JOIN key_platforms kp ON kp.key_id=k.id AND kp.platform_id=$1
       WHERE NOT k.is_archived AND (SELECT count(*) FROM key_platforms x WHERE x.key_id=k.id)=1
         AND NOT EXISTS (SELECT 1 FROM key_platforms d WHERE d.platform_id=$2 AND d.identifier=kp.identifier)
       ORDER BY k.id LIMIT 1`,
      [P('Web Service'), P('Dashboard')],
    ))!;
    const [ws, dash, disp] = [await versionsOf('web-service'), await versionsOf('dashboard'), await versionsOf('dispatcher')];
    expect((await admin.put(`/api/keys/${key.id}/platforms`, { platformIds: [P('Web Service'), P('Dashboard')] })).statusCode).toBe(200);
    expect((await versionsOf('dashboard')).it).toBe(dash.it + 1);
    expect((await versionsOf('web-service')).it).toBe(ws.it);
    expect(await versionsOf('dispatcher')).toEqual(disp);
  });
});

describe('key lifecycle', () => {
  it('stops working when expired, revoked, or when the owner loses API access', async () => {
    const make = async (name: string) => (await manager.post('/api/api-keys', { name })).json();
    const expired = await make('expired');
    await env.db.query(`UPDATE api_keys SET expires_at=now() - interval '1 minute' WHERE id=$1`, [expired.id]);
    expect((await call('/api/v1/languages', expired.key)).json().error).toBe('api_key_expired');

    const revoked = await make('revoked');
    expect((await manager.post(`/api/api-keys/${revoked.id}/revoke`)).statusCode).toBe(200);
    const r = await call('/api/v1/languages', revoked.key);
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('api_key_revoked');
    expect((await env.db.one(`SELECT count(*)::int AS n FROM audit_logs WHERE action='api_key.revoked'`)).n).toBe(1);

    // Demoting the owner to translator disables their keys; restoring the role brings them back.
    await env.db.query(`UPDATE users SET role='translator' WHERE id=$1`, [managerId]);
    expect((await call('/api/v1/languages', managerKey)).json().error).toBe('api_key_disabled');
    await env.db.query(`UPDATE users SET role='manager' WHERE id=$1`, [managerId]);
    expect((await call('/api/v1/languages', managerKey)).statusCode).toBe(200);
    await env.db.query(`UPDATE users SET is_active=false WHERE id=$1`, [managerId]);
    expect((await call('/api/v1/languages', managerKey)).json().error).toBe('api_key_disabled');
    await env.db.query(`UPDATE users SET is_active=true WHERE id=$1`, [managerId]);
  });
});
