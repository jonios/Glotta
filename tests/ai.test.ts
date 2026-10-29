import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig, type AiConfig } from '../server/ai/config.js';
import type { BatchResult, ModelReply, TranslatorClient } from '../server/ai/claude.js';
import { TranslationWorker } from '../server/ai/worker.js';
import { checkValue, validateReply } from '../server/ai/validate.js';
import { createEnv, createUser, ids, login, type Client, type TestEnv } from './helpers.js';

// ------------------------------------------------------------------ fake Claude

type Item = { id: string; text: string };
type Handler = (items: Item[], call: number) => ModelReply | Error;

const reply = (translations: { id: string; text: string }[], stopReason = 'end_turn'): ModelReply => ({
  text: JSON.stringify({ translations }),
  stopReason,
  model: 'claude-test',
  usage: { input: 100, output: 50, cacheRead: 10 },
});
/** "Translates" by tagging the text; placeholders survive untouched. */
const tag = (items: Item[]) => reply(items.map((i) => ({ id: i.id, text: `FA:${i.text}` })));

class FakeClaude implements TranslatorClient {
  calls: Item[][] = [];
  handler: Handler = tag;
  submitted: { customId: string; items: Item[] }[] = [];
  batchCancelled = false;

  static itemsOf(params: Anthropic.MessageCreateParamsNonStreaming): Item[] {
    const content = params.messages[0].content as string;
    return JSON.parse(content.slice(content.indexOf('\n\n') + 2)).items.map((i: Item) => ({ id: i.id, text: i.text }));
  }
  async translate(params: Anthropic.MessageCreateParamsNonStreaming) {
    const items = FakeClaude.itemsOf(params);
    this.calls.push(items);
    const r = this.handler(items, this.calls.length);
    if (r instanceof Error) throw r;
    return r;
  }
  async submitBatch(requests: { customId: string; params: Anthropic.MessageCreateParamsNonStreaming }[]) {
    this.submitted = requests.map((r) => ({ customId: r.customId, items: FakeClaude.itemsOf(r.params) }));
    return 'msgbatch_test';
  }
  async batchStatus() {
    return 'ended' as const;
  }
  async *batchResults(): AsyncIterable<BatchResult> {
    for (const s of this.submitted) yield { customId: s.customId, type: 'succeeded', reply: tag(s.items) };
  }
  async cancelBatch() {
    this.batchCancelled = true;
  }
}

const rateLimited = () => new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers({ 'retry-after': '0' }));
const badRequest = () => new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 'bad', new Headers());
const silentLog = { info() {}, warn() {}, error() {} };

// ------------------------------------------------------------------ fixture

let env: TestEnv;
let fake: FakeClaude;
let worker: TranslationWorker;
let config: AiConfig;
let L: (c: string) => number;
let P: (n: string) => number;
let admin: Client;
let manager: Client;
let translator: Client;
let newLang: number;
const KEYS: Record<string, number> = {};

async function addKey(identifier: string, source: string, platforms: string[]) {
  const res = await admin.post('/api/keys', { identifier, sourceText: source, platformIds: platforms.map(P) });
  expect(res.statusCode).toBe(200);
  KEYS[identifier] = res.json().id;
}
const tr = (key: string, lang = newLang) => env.db.one<{ value: string; status: string; version: number }>('SELECT value, status, version FROM translations WHERE key_id=$1 AND language_id=$2', [KEYS[key], lang]);
const job = (id: number) => admin.get(`/api/ai/jobs/${id}`).then((r) => r.json());
async function startJob(body: Record<string, unknown>, client: Client = admin) {
  return client.post('/api/ai/jobs', { targetLanguageId: newLang, ...body });
}
/** Starts a job that must be created, failing the test with the server's reason otherwise. */
async function mustStart(body: Record<string, unknown>) {
  const res = await startJob(body);
  if (res.statusCode !== 201) throw new Error(`job not created: ${res.statusCode} ${res.body}`);
  return res.json().id as number;
}

beforeAll(async () => {
  config = { ...loadAiConfig({}), configured: true, apiKey: 'test', batchSize: 3, concurrency: 2, maxRetries: 2, maxItemAttempts: 2, messageBatchMinKeys: 0, jobsPerMinute: 1000 };
  fake = new FakeClaude();
  env = await createEnv({ ai: (db) => (worker = new TranslationWorker(db, fake, config, silentLog, 1), { config, client: fake, worker }) });
  const adminId = await createUser(env.db, { email: 'admin@tms.test', role: 'super_admin' });
  expect(adminId).toBeGreaterThan(0);
  ({ lang: L, plat: P } = await ids(env.db));
  await createUser(env.db, { email: 'manager@tms.test', role: 'manager', caps: ['view', 'view_source', 'edit_translations', 'review', 'approve'], languages: [L('it')], platforms: [P('Web Service')] });
  await createUser(env.db, { email: 'translator@tms.test', role: 'translator', caps: ['view', 'view_source', 'edit_translations'], allLanguages: true, allPlatforms: true });
  admin = await login(env.app, 'admin@tms.test');
  manager = await login(env.app, 'manager@tms.test');
  translator = await login(env.app, 'translator@tms.test');

  // Adding a language uses the existing workflow; Auto Translate then fills it.
  const created = await admin.post('/api/languages', { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili' });
  expect(created.statusCode).toBe(200);
  newLang = created.json().id;

  await addKey('greeting', 'Hello {name}, you have {{count}} messages', ['Web Service', 'Dashboard']);
  await addKey('price', 'Total: %s (%d items) ${value}', ['Web Service']);
  await addKey('bold', 'Press <b>Save</b> to continue', ['Web Service']);
  await addKey('plural', '{count, plural, one {# order} other {# orders}}', ['Web Service']);
  await addKey('empty_src', '', ['Web Service']);
  await addKey('dash_only', 'Only on the dashboard', ['Dashboard']);
  await addKey('disp_only', 'Only on dispatcher', ['Dispatcher']);
});
afterAll(async () => env?.close());
beforeEach(() => {
  fake.handler = tag;
  fake.calls = [];
});

describe('configuration and authorization', () => {
  it('reports status without exposing the API key', async () => {
    const s = (await admin.get('/api/ai/status')).json();
    expect(s.configured).toBe(true);
    expect(JSON.stringify(s)).not.toContain('test"');
    expect(s.models.standard).toBe('claude-opus-5-5');
  });

  it('refuses translators, out-of-scope managers, approved overwrites by managers, and unconfirmed overwrites', async () => {
    expect((await startJob({}, translator)).statusCode).toBe(403);
    expect((await startJob({ targetLanguageId: L('fr') }, manager)).statusCode).toBe(403);
    expect((await startJob({ targetLanguageId: L('it'), platformIds: [P('Dispatcher')] }, manager)).statusCode).toBe(403);
    expect((await startJob({ targetLanguageId: L('it'), overwrite: 'all', confirmOverwrite: true }, manager)).statusCode).toBe(403);
    const unconfirmed = await startJob({ overwrite: 'unapproved' });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error).toBe('confirm_overwrite');
    expect((await env.app.inject({ method: 'POST', url: '/api/ai/jobs', payload: {} })).statusCode).toBe(401);
  });

  it('reports "not configured" without inventing credentials', async () => {
    const plain = await createEnv();
    await createUser(plain.db, { email: 'a@tms.test', role: 'super_admin' });
    const c = await login(plain.app, 'a@tms.test');
    expect((await c.get('/api/ai/status')).json().configured).toBe(false);
    const res = await c.post('/api/ai/jobs', { targetLanguageId: (await ids(plain.db)).lang('fr') });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('ai_not_configured');
    await plain.close();
  });
});

describe('missing keys report', () => {
  it('compares per platform, flags empty sources, and respects platform-specific keys', async () => {
    const all = (await admin.get(`/api/missing-keys?languageId=${newLang}&pageSize=500`)).json();
    const keys = all.rows.map((r: any) => r.identifiers[0]);
    expect(keys).toEqual(expect.arrayContaining(['greeting', 'price', 'bold', 'plural', 'empty_src', 'dash_only', 'disp_only']));
    expect(all.summary.empty_source).toBe(1);
    const ws = (await admin.get(`/api/missing-keys?languageId=${newLang}&platformIds=${P('Web Service')}&kind=missing`)).json();
    const wsKeys = ws.rows.map((r: any) => r.identifiers[0]);
    expect(wsKeys).not.toContain('dash_only');
    expect(wsKeys).not.toContain('disp_only');
    expect(ws.rows.find((r: any) => r.identifiers[0] === 'greeting').platforms).toEqual(['Web Service']);
    expect(ws.eligibleKeyIds).not.toContain(KEYS.empty_src);
    const search = (await admin.get(`/api/missing-keys?languageId=${newLang}&q=dispatcher`)).json();
    expect(search.rows.map((r: any) => r.identifiers[0])).toEqual(['disp_only']);
    const csv = await admin.get(`/api/missing-keys?languageId=${newLang}&format=csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('greeting');
  });
});

describe('Auto Translate a new language', () => {
  let jobId: number;

  it('previews eligible keys and cost inputs before starting', async () => {
    const p = (await admin.post('/api/ai/jobs/preview', { targetLanguageId: newLang, platformIds: [P('Web Service'), P('Dashboard')] })).json();
    expect(p.eligible).toBe(5); // greeting, price, bold, plural, dash_only
    expect(p.emptySource).toBe(1);
    expect(p.batches).toBe(2);
    expect(p.mode).toBe('interactive');
    expect(p.estimate.inputTokens).toBeGreaterThan(0);
  });

  it('translates in batches, writes reviewable values, keeps placeholders, and tracks progress from the database', async () => {
    const res = await startJob({ platformIds: [P('Web Service'), P('Dashboard')] });
    expect(res.statusCode).toBe(201);
    jobId = res.json().id;
    expect(res.json().status).toBe('queued');
    expect((await startJob({ platformIds: [P('Web Service'), P('Dashboard')] })).statusCode).toBe(409); // duplicate job

    const before = await env.db.one<{ version: number }>('SELECT version FROM content_versions WHERE platform_id=$1 AND language_id=$2', [P('Web Service'), newLang]);
    await worker.drain();
    const j = await job(jobId);
    expect(j.status).toBe('completed');
    expect(j.counts).toEqual({ pending: 0, translated: 5, skipped: 1, failed: 0 });
    expect(j.progress).toBe(100);
    expect(j.inputTokens).toBeGreaterThan(0);
    expect(fake.calls.length).toBe(2); // two application batches, not one request per key
    expect(await tr('greeting')).toMatchObject({ value: 'FA:Hello {name}, you have {{count}} messages', status: 'needs_review' });
    expect(await tr('empty_src')).toBeUndefined(); // never an empty string written for a failure
    const history = await env.db.one(`SELECT reason FROM translation_history h JOIN translations t ON t.id=h.translation_id WHERE t.key_id=$1 AND t.language_id=$2`, [KEYS.greeting, newLang]);
    expect(history.reason).toBe('ai');
    // One bump per write statement for this language/platform, not one per key.
    const after = await env.db.one<{ version: number }>('SELECT version FROM content_versions WHERE platform_id=$1 AND language_id=$2', [P('Web Service'), newLang]);
    expect(after!.version - (before?.version ?? 1)).toBeLessThanOrEqual(2);
    // Not published: the public API serves approved translations only by default.
    expect((await tr('price'))!.status).toBe('needs_review');
  });

  it('skips existing translations by default and never overwrites reviewed work without an explicit mode', async () => {
    const res = await startJob({ platformIds: [P('Web Service'), P('Dashboard')] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('nothing_to_translate');
    // Approve one value; "unapproved" mode re-translates the rest but leaves the approved one alone.
    const t = await env.db.one('SELECT id, version FROM translations WHERE key_id=$1 AND language_id=$2', [KEYS.bold, newLang]);
    expect((await admin.post(`/api/translations/${t.id}/review`, { action: 'approve', expectedVersion: t.version })).statusCode).toBe(200);
    fake.handler = (items) => reply(items.map((i) => ({ id: i.id, text: `NEW:${i.text}` })));
    const p = (await admin.post('/api/ai/jobs/preview', { targetLanguageId: newLang, platformIds: [P('Web Service')], overwrite: 'unapproved', confirmOverwrite: true })).json();
    expect(p.excluded.approved).toBe(1);
    const r2 = await startJob({ platformIds: [P('Web Service')], overwrite: 'unapproved', confirmOverwrite: true });
    expect(r2.statusCode).toBe(201);
    await worker.drain();
    expect((await tr('bold'))!.value).toBe('FA:Press <b>Save</b> to continue');
    expect((await tr('price'))!.value).toMatch(/^NEW:/);
  });
});

describe('validation of model output', () => {
  it('rejects broken placeholders, ICU and markup, and matches results by id only', () => {
    expect(checkValue('Hi {name}', 'Hola')?.reason).toBe('invalid_placeholders');
    expect(checkValue('Hi {name}', 'Hola {nombre}')?.reason).toBe('invalid_placeholders');
    expect(checkValue('%s of %d', '%d de %s')).toBeNull();
    expect(checkValue('Press <b>Save</b>', 'Drücke Speichern')?.reason).toBe('invalid_markup');
    expect(checkValue('{n, plural, one {# day} other {# days}}', '{n, plural, one {# Tag} other {# Tage}}')).toBeNull();
    expect(checkValue('{n, plural, one {# day} other {# days}}', '{n, plural, one {# Tag} other {# Tage}')?.reason).toBe('invalid_icu');
    expect(checkValue('{n, plural, one {# day} other {# days}}', '{m, plural, one {# Tag} other {# Tage}}')?.reason).toBe('invalid_icu');
    expect(checkValue('Hello', '   ')?.reason).toBe('empty');

    const v = validateReply(JSON.stringify({ translations: [{ id: '2', text: 'B' }, { id: '1', text: 'A' }, { id: '99', text: 'X' }, { id: '2', text: 'B2' }] }), [{ id: '1', source: 'a' }, { id: '2', source: 'b' }, { id: '3', source: 'c' }]);
    expect(v.outcomes.find((o) => o.id === '1')).toMatchObject({ ok: true, value: 'A' });
    expect(v.outcomes.find((o) => o.id === '2')).toMatchObject({ ok: false, reason: 'duplicate_in_reply' });
    expect(v.outcomes.find((o) => o.id === '3')).toMatchObject({ ok: false, reason: 'missing_in_reply' });
    expect(v.unexpected).toContain('99');
    expect(validateReply('not json', [{ id: '1', source: 'a' }]).malformed).toBeTruthy();
    expect(validateReply('{"translations":[{"id":"1"}]}', [{ id: '1', source: 'a' }]).malformed).toBeTruthy();
  });
});

describe('failures, retries, cancellation and recovery', () => {
  let target: number;
  beforeAll(async () => {
    target = (await admin.post('/api/languages', { code: 'yo', name: 'Yoruba' })).json().id;
  });
  const run = async (body: Record<string, unknown>) => await mustStart({ targetLanguageId: target, platformIds: [P('Web Service')], ...body });

  it('handles partial batch failures, retries invalid keys, and fails them after the attempt limit', async () => {
    // The model keeps dropping the placeholder of "greeting" and omits "price" once.
    fake.handler = (items, call) =>
      reply(
        items
          .filter((i) => !(call === 1 && i.text.startsWith('Total')))
          .map((i) => ({ id: i.id, text: i.text.startsWith('Hello') ? 'Hujambo' : `YO:${i.text}` })),
      );
    const id = await run({});
    await worker.drain();
    const j = await job(id);
    expect(j.status).toBe('completed_with_errors');
    expect(j.counts.failed).toBe(1);
    expect(j.counts.translated).toBe(3);
    const items = (await admin.get(`/api/ai/jobs/${id}/items?status=failed`)).json().rows;
    expect(items[0]).toMatchObject({ reason: 'invalid_placeholders', attempts: 2 });
    expect(await tr('greeting', target)).toBeUndefined();
    expect((await tr('price', target))!.value).toBe('YO:Total: %s (%d items) ${value}');

    // Retrying sends only the failed key again; successful keys are not re-translated.
    fake.calls = [];
    fake.handler = tag;
    const retry = await admin.post(`/api/ai/jobs/${id}/retry`, {});
    expect(retry.json().requeued).toBe(1);
    await worker.drain();
    expect(fake.calls.flat().map((i) => i.id)).toEqual([String(KEYS.greeting)]);
    expect((await job(id)).status).toBe('completed');
    const v = (await tr('price', target))!.version;
    expect((await admin.post(`/api/ai/jobs/${id}/retry`, {})).statusCode).toBe(400); // nothing left: idempotent
    expect((await tr('price', target))!.version).toBe(v);
  });

  it('retries rate limits with backoff and does not retry permanent errors', async () => {
    const lang = (await admin.post('/api/languages', { code: 'ha', name: 'Hausa' })).json().id;
    fake.handler = (items, call) => (call <= 2 ? rateLimited() : tag(items));
    const id = await mustStart({ targetLanguageId: lang, platformIds: [P('Dashboard')] });
    await worker.drain();
    expect((await job(id)).status).toBe('completed');

    fake.calls = [];
    fake.handler = () => badRequest();
    const id2 = await mustStart({ targetLanguageId: lang, platformIds: [P('Web Service')] });
    await worker.drain();
    const j = await job(id2);
    expect(j.status).toBe('failed');
    expect(fake.calls.length).toBe(j.batches.total); // one request per batch, no retries for a 400
    expect(j.batches.retries).toBe(0);
    expect(j.reasons[0].reason).toBe('bad_request');
  });

  it('treats malformed replies as retryable and never writes them', async () => {
    const lang = (await admin.post('/api/languages', { code: 'ig', name: 'Igbo' })).json().id;
    fake.handler = (items, call) => (call === 1 ? { ...tag(items), text: '{"translations": [' } : tag(items));
    const id = await mustStart({ targetLanguageId: lang, platformIds: [P('Dashboard')] });
    await worker.drain();
    expect((await job(id)).counts).toMatchObject({ translated: 2, failed: 0 });
  });

  it('splits a batch whose output was cut off', async () => {
    const lang = (await admin.post('/api/languages', { code: 'zu', name: 'Zulu' })).json().id;
    fake.handler = (items) => (items.length > 1 ? { ...tag(items), stopReason: 'max_tokens', text: '{"transl' } : tag(items));
    const id = await mustStart({ targetLanguageId: lang, platformIds: [P('Web Service')] });
    await worker.drain();
    expect((await job(id)).counts).toMatchObject({ translated: 4, failed: 0 });
    expect(fake.calls.every((c) => c.length === 1 || c.length > 1)).toBe(true);
  });

  it('cancels safely and resumes later without duplicating work', async () => {
    const lang = (await admin.post('/api/languages', { code: 'xh', name: 'Xhosa' })).json().id;
    const id = await mustStart({ targetLanguageId: lang, platformIds: [P('Web Service')] });
    expect((await admin.post(`/api/ai/jobs/${id}/cancel`)).statusCode).toBe(200);
    await worker.drain();
    const c = await job(id);
    expect(c.status).toBe('cancelled');
    expect(c.counts.pending).toBe(4);
    expect(fake.calls.length).toBe(0);
    expect((await admin.post(`/api/ai/jobs/${id}/resume`)).json().requeued).toBe(4);
    await worker.drain();
    expect((await job(id)).counts).toMatchObject({ translated: 4, pending: 0 });
  });

  it('recovers a batch left running by a crashed worker', async () => {
    const lang = (await admin.post('/api/languages', { code: 'af', name: 'Afrikaans' })).json().id;
    const id = await mustStart({ targetLanguageId: lang, platformIds: [P('Dashboard')] });
    // Simulate a crash mid-batch: running, lease already expired, nothing in flight.
    await env.db.query(`UPDATE translation_jobs SET status='running' WHERE id=$1`, [id]);
    await env.db.query(`UPDATE translation_job_batches SET status='running', attempts=1, lease_until=now() - interval '1 minute' WHERE job_id=$1`, [id]);
    const restarted = new TranslationWorker(env.db, fake, config, silentLog, 1);
    await restarted.drain();
    expect((await job(id)).counts).toMatchObject({ translated: 2, pending: 0 });
  });

  it('skips keys whose source text or translation changed while the job ran', async () => {
    const lang = (await admin.post('/api/languages', { code: 'so', name: 'Somali' })).json().id;
    const id = await mustStart({ targetLanguageId: lang, platformIds: [P('Web Service')] });
    // Before the worker runs: the source of "bold" changes, and someone types a translation for "price".
    const k = await env.db.one('SELECT version FROM translation_keys WHERE id=$1', [KEYS.bold]);
    expect((await admin.patch(`/api/keys/${KEYS.bold}`, { expectedVersion: k.version, sourceText: 'Press <b>Save</b> now' })).statusCode).toBe(200);
    expect((await admin.put('/api/translations', { keyId: KEYS.price, languageId: lang, value: 'Jumla: %s (%d) ${value}', status: 'draft', expectedVersion: null })).statusCode).toBe(200);
    await worker.drain();
    const items = (await admin.get(`/api/ai/jobs/${id}/items?status=skipped`)).json().rows;
    const reasons = Object.fromEntries(items.map((i: any) => [i.keyId, i.reason]));
    expect(reasons[KEYS.bold]).toBe('source_changed');
    expect(reasons[KEYS.price]).toBe('changed_meanwhile');
    expect((await tr('price', lang))!.value).toBe('Jumla: %s (%d) ${value}');
  });
});

describe('selected keys and the Message Batches API', () => {
  it('translates only the selected keys from the missing-keys report', async () => {
    const lang = (await admin.post('/api/languages', { code: 'mg', name: 'Malagasy' })).json().id;
    const id = await mustStart({ targetLanguageId: lang, keyIds: [KEYS.dash_only], platformIds: [P('Dashboard')] });
    await worker.drain();
    expect((await job(id)).counts.translated).toBe(1);
    const report = (await admin.get(`/api/missing-keys?languageId=${lang}&kind=missing`)).json();
    expect(report.rows.map((r: any) => r.identifiers[0])).not.toContain('dash_only');
  });

  it('runs large jobs through Message Batches and records the failures of the last attempt', async () => {
    const lang = (await admin.post('/api/languages', { code: 'ny', name: 'Chichewa' })).json().id;
    const big = { ...config, messageBatchMinKeys: 2, batchPollMs: 0 };
    const fake2 = new FakeClaude();
    const w2 = new TranslationWorker(env.db, fake2, big, silentLog, 1);
    // Create the job through the service the routes use, with the lower threshold.
    const { createJob } = await import('../server/ai/jobs.js');
    const adminRow = await env.db.one('SELECT id FROM users WHERE email=$1', ['admin@tms.test']);
    const src = await env.db.one('SELECT id FROM languages WHERE is_source');
    const created = await env.db.tx((q) =>
      createJob(q, big, { scope: { sourceLanguageId: src.id, targetLanguageId: lang, platformIds: [P('Web Service')], keyIds: null, overwrite: 'missing' }, sourceIsDefault: true, tier: 'standard', resultStatus: 'needs_review', mode: 'auto', batchSize: 3, userId: adminRow.id }),
    );
    expect(created.preview.mode).toBe('message_batches');
    await w2.drain();
    expect(fake2.submitted.length).toBe(2);
    const j = await job(created.id);
    expect(j.counts).toMatchObject({ translated: 4, failed: 0 });
    expect(j.usedMessageBatches).toBe(true);
  });
});
