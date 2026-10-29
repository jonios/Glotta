import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, createUser, ids, importWorkbook, keyOn, login, WORKBOOK, type Client, type TestEnv } from './helpers.js';
import { androidValuesDir, FORMATS, type LocaleBundle } from '../server/exporters/formats.js';
import { parseForImport } from '../server/importexport/import-routes.js';
import { validateTranslation, extractPlaceholders } from '../shared/placeholders.js';

let env: TestEnv;
let admin: Client;
let L: (c: string) => number;
let P: (n: string) => number;

beforeAll(async () => {
  env = await createEnv();
  const id = await createUser(env.db, { email: 'admin@tms.test', role: 'super_admin' });
  await importWorkbook(env.db, id);
  ({ lang: L, plat: P } = await ids(env.db));
  admin = await login(env.app, 'admin@tms.test');
});
afterAll(async () => env?.close());

// ----------------------------------------------------------------- independent decoders
/** Strict parser for Apple's .strings grammar ("key" = "value"; with C comments and escapes). */
function parseAppleStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const ws = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) throw new Error('unterminated comment');
        i = end + 2;
      } else if (text.startsWith('//', i)) {
        while (i < text.length && text[i] !== '\n') i++;
      } else return;
    }
  };
  const str = () => {
    if (text[i] !== '"') throw new Error(`expected quote at ${i}`);
    i++;
    let s = '';
    while (text[i] !== '"') {
      if (i >= text.length) throw new Error('unterminated string');
      if (text[i] === '\\') {
        const c = text[i + 1];
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
        if (!(c in map)) throw new Error(`bad escape \\${c}`);
        s += map[c];
        i += 2;
      } else s += text[i++];
    }
    i++;
    return s;
  };
  ws();
  while (i < text.length) {
    const k = str();
    ws();
    if (text[i++] !== '=') throw new Error('expected =');
    ws();
    const v = str();
    ws();
    if (text[i++] !== ';') throw new Error('expected ;');
    if (k in out) throw new Error(`duplicate key ${k}`);
    out[k] = v;
    ws();
  }
  return out;
}

/** Decodes an Android string resource the way aapt does (escapes and outer quotes). */
function decodeAndroid(raw: string): string {
  let s = raw;
  let quoted = false;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2 && !s.endsWith('\\"')) {
    s = s.slice(1, -1);
    quoted = true;
  }
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      const c = s[++i];
      out += ({ n: '\n', t: '\t', "'": "'", '"': '"', '\\': '\\', '@': '@', '?': '?' } as Record<string, string>)[c] ?? c;
    } else if (!quoted && (s[i] === "'" || s[i] === '"')) {
      throw new Error(`unescaped quote in ${raw}`);
    } else out += s[i];
  }
  return out;
}

function parseAndroid(xml: string): Record<string, string> {
  expect(XMLValidator.validate(xml)).toBe(true);
  const doc = new XMLParser({ ignoreAttributes: false, processEntities: true, trimValues: false, parseTagValue: false, isArray: (n) => n === 'string' }).parse(xml);
  const out: Record<string, string> = {};
  for (const s of doc.resources.string ?? []) {
    const raw = typeof s === 'string' ? s : (s['#text'] ?? '');
    out[s['@_name']] = decodeAndroid(String(raw));
  }
  return out;
}

async function exportFiles(body: object) {
  const res = await admin.post('/api/export/resources', { zip: true, ...body });
  expect(res.statusCode).toBe(200);
  const zip = await JSZip.loadAsync(res.rawPayload);
  const files: Record<string, string> = {};
  for (const [name, f] of Object.entries(zip.files)) if (!f.dir) files[name] = await f.async('string');
  return files;
}

async function dbValues(platform: string, code: string) {
  return new Map(
    (
      await env.db.query<{ identifier: string; value: string }>(
        `SELECT kp.identifier, t.value FROM key_platforms kp JOIN translations t ON t.key_id=kp.key_id
         WHERE kp.platform_id=$1 AND t.language_id=$2 AND t.status<>'missing'`,
        [P(platform), L(code)],
      )
    ).map((r) => [r.identifier, r.value]),
  );
}

// ----------------------------------------------------------------------------- tests
describe('Scenario D — localization exports', () => {
  it('JSON (flat) is valid and equals the database values', async () => {
    const files = await exportFiles({ format: 'json', platformIds: [P('Dashboard')], languageIds: [L('it'), L('fa')] });
    expect(Object.keys(files).sort()).toEqual(['en.json', 'fa.json', 'it.json']);
    const fa = JSON.parse(files['fa.json']);
    const expected = await dbValues('Dashboard', 'fa');
    expect(Object.keys(fa).length).toBe(expected.size);
    for (const [k, v] of expected) expect(fa[k]).toBe(v);
  });

  it('JSON nested groups dotted keys', async () => {
    const out = FORMATS.find((f) => f.id === 'json')!.render(
      [{ code: 'it', isSource: false, entries: [{ identifier: 'order.new', value: 'Nuovo', source: 'New', description: '' }, { identifier: 'order.view', value: 'Vedi', source: 'View', description: '' }] }],
      { nested: true, sourceCode: 'en' },
      () => {},
    );
    expect(JSON.parse(out[0].content)).toEqual({ order: { new: 'Nuovo', view: 'Vedi' } });
  });

  it('Android XML parses, uses correct resource folders and round-trips tricky strings', async () => {
    const files = await exportFiles({ format: 'android', platformIds: [P('Android Driver')], languageIds: [L('it'), L('fa'), L('pt-BR'), L('zh-Hans'), L('zh-Hant'), L('fr')] });
    expect(Object.keys(files).filter((f) => f.endsWith('.xml')).sort()).toEqual([
      'values-fa/strings.xml', 'values-fr/strings.xml', 'values-it/strings.xml', 'values-pt-rBR/strings.xml',
      'values-zh-rCN/strings.xml', 'values-zh-rTW/strings.xml', 'values/strings.xml',
    ]);
    for (const [code, file] of [['fr', 'values-fr/strings.xml'], ['fa', 'values-fa/strings.xml'], ['zh-Hans', 'values-zh-rCN/strings.xml']]) {
      const parsed = parseAndroid(files[file]);
      const expected = await dbValues('Android Driver', code);
      for (const [k, v] of expected) {
        if (k in parsed) expect(parsed[k], `${code}:${k}`).toBe(v);
      }
      expect(Object.keys(parsed).length).toBeGreaterThan(expected.size * 0.9);
    }
    expect(androidValuesDir('he', false)).toBe('values-iw');
    expect(androidValuesDir('fil', false)).toBe('values-b+fil');
    expect(androidValuesDir('ckb', false)).toBe('values-b+ckb');
    expect(androidValuesDir('de-AT', false)).toBe('values-de-rAT');
    expect(androidValuesDir('en', true)).toBe('values');
  });

  it('Android escaping handles apostrophes, quotes, ampersands, @, newlines and placeholders', () => {
    const tricky = ["L'ordine è \"pronto\" & <ok>", '@home', '?query', 'Line 1\nLine 2', 'Hello %1$s, you have %2$d', '%s of %s', ' padded '];
    const out = FORMATS.find((f) => f.id === 'android')!.render(
      [{ code: 'it', isSource: false, entries: tricky.map((v, i) => ({ identifier: `k${i}`, value: v, source: v, description: '' })) }],
      { nested: false, sourceCode: 'en' },
      () => {},
    );
    const parsed = parseAndroid(out[0].content);
    tricky.forEach((v, i) => expect(parsed[`k${i}`]).toBe(v));
    expect(out[0].content).toContain('name="k5" formatted="false"');
  });

  it('iOS .strings parses with a strict grammar and equals the database values', async () => {
    const files = await exportFiles({ format: 'ios-strings', platformIds: [P('iOS Driver')], languageIds: [L('fr'), L('ar'), L('zh-Hant'), L('pt-BR')] });
    expect(Object.keys(files).sort()).toEqual(['ar.lproj/Localizable.strings', 'en.lproj/Localizable.strings', 'fr.lproj/Localizable.strings', 'pt-BR.lproj/Localizable.strings', 'zh-Hant.lproj/Localizable.strings']);
    for (const code of ['fr', 'ar', 'zh-Hant']) {
      const parsed = parseAppleStrings(files[`${code}.lproj/Localizable.strings`]);
      const expected = await dbValues('iOS Driver', code);
      expect(Object.keys(parsed).length).toBe(expected.size);
      for (const [k, v] of expected) expect(parsed[k]).toBe(v);
    }
    const tricky = FORMATS.find((f) => f.id === 'ios-strings')!.render(
      [{ code: 'it', isSource: false, entries: [{ identifier: 'q', value: 'Say "hi"\\ %@\nok', source: '', description: 'a */ comment' }] }],
      { nested: false, sourceCode: 'en' },
      () => {},
    );
    expect(parseAppleStrings(tricky[0].content)).toEqual({ q: 'Say "hi"\\ %@\nok' });
  });

  it('missing translations: skipped by default, empty or English fallback only when chosen', async () => {
    const key = (await keyOn(env.db, 'Track Page', 'CallDriver'))!;
    const missingIt = !(await env.db.one('SELECT 1 FROM translations WHERE key_id=$1 AND language_id=$2', [key.id, L('it')]));
    expect(missingIt).toBe(true);
    const base = { format: 'json', platformIds: [P('Track Page')], languageIds: [L('it')], includeSource: false, zip: false };
    const skip = JSON.parse((await admin.post('/api/export/resources', base)).body);
    expect(skip).toEqual({});
    const empty = JSON.parse((await admin.post('/api/export/resources', { ...base, missing: 'empty' })).body);
    expect(empty.CallDriver).toBe('');
    const fb = JSON.parse((await admin.post('/api/export/resources', { ...base, missing: 'fallback_source' })).body);
    expect(fb.CallDriver).toBe('Call Driver');
  });

  it('other adapters produce parseable output (xcstrings, ARB, YAML-as-JSON scalars, PO, CSV)', async () => {
    const bundles: LocaleBundle[] = [
      { code: 'en', isSource: true, entries: [{ identifier: 'all', value: 'All', source: 'All', description: 'Filter' }] },
      { code: 'it', isSource: false, entries: [{ identifier: 'all', value: 'Tutti, "ok"', source: 'All', description: 'Filter' }] },
    ];
    const r = (id: string) => FORMATS.find((f) => f.id === id)!.render(bundles, { nested: false, sourceCode: 'en' }, () => {});
    const xc = JSON.parse(r('xcstrings')[0].content);
    expect(xc.strings.all.localizations.it.stringUnit.value).toBe('Tutti, "ok"');
    expect(JSON.parse(r('arb')[1].content)).toMatchObject({ '@@locale': 'it', all: 'Tutti, "ok"' });
    expect(r('po')[1].content).toContain('msgstr "Tutti, \\"ok\\""');
    expect(r('csv')[1].content).toContain('"Tutti, ""ok"""');
    expect(r('yaml')[1].content).toContain('"all": "Tutti, \\"ok\\""');
  });
});

describe('Scenario E — Excel compatibility', () => {
  it('legacy export reproduces sheets, headers and values; re-import is a no-op', async () => {
    const res = await admin.post('/api/export/excel', { layout: 'legacy', includeArchived: true });
    expect(res.statusCode).toBe(200);
    const buf = res.rawPayload;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const orig = new ExcelJS.Workbook();
    await orig.xlsx.load(readFileSync(WORKBOOK) as any);
    expect(wb.worksheets.map((w) => w.name).sort()).toEqual(orig.worksheets.map((w) => w.name).sort());
    // Same header labels in the same order (languages added later would be appended).
    const iosNew = (wb.getWorksheet('iOS Driver')!.getRow(1).values as any[]).map(String);
    const iosOld = (orig.getWorksheet('iOS Driver')!.getRow(1).values as any[]).map(String);
    expect(iosNew.slice(0, iosOld.length)).toEqual(iosOld);
    // Both French columns keep their own (different) values.
    const findRow = (ws: ExcelJS.Worksheet, kw: string) => {
      for (let r = 1; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(1).value === kw) return ws.getRow(r);
      throw new Error(kw);
    };
    const col = (ws: ExcelJS.Worksheet, h: string) => (ws.getRow(1).values as any[]).findIndex((v) => String(v).trim() === h);
    const n = findRow(wb.getWorksheet('iOS Driver')!, 'internet_error_description');
    const o = findRow(orig.getWorksheet('iOS Driver')!, 'internet_error_description');
    for (const h of ['French', 'Francais', 'Persian', 'Chinese Traditional (zh-Hant)']) {
      expect(n.getCell(col(wb.getWorksheet('iOS Driver')!, h)).value, h).toBe(o.getCell(col(orig.getWorksheet('iOS Driver')!, h)).value);
    }
    // Web Service keeps its locale-code row under the header.
    expect(wb.getWorksheet('Web Service')!.getRow(2).getCell(1).value).toBe('key');

    const before = await env.db.one(`SELECT count(*)::int AS n, md5(string_agg(value, '|' ORDER BY id)) AS h FROM translations`);
    const { report } = await importWorkbook(env.db, (await env.db.one(`SELECT id FROM users WHERE email='admin@tms.test'`)).id, 'manual', Buffer.from(buf));
    expect(report.summary.keysCreated).toBe(0);
    expect(report.summary.translationsAdded).toBe(0);
    expect(await env.db.one(`SELECT count(*)::int AS n, md5(string_agg(value, '|' ORDER BY id)) AS h FROM translations`)).toEqual(before);
  });

  it('normalized export can be parsed back as a normalized workbook', async () => {
    const res = await admin.post('/api/export/excel', { layout: 'normalized', platformIds: [P('Receipt')], languageIds: [L('it'), L('de')] });
    const { sheets } = await parseForImport(env.db, Buffer.from(res.rawPayload));
    const t = sheets.find((s) => s.name === 'Translations')!;
    expect(t.format).toBe('normalized');
    expect(t.rows.length).toBe(25);
    expect(t.columns.filter((c) => c.role === 'language').map((c) => c.languageCode).sort()).toEqual(['de', 'en', 'it']);
  });
});

describe('placeholder validation', () => {
  it('detects printf, mustache, ICU and legacy xxx placeholders', () => {
    expect(extractPlaceholders('Hi %s, %1$d {{name}} {count} ${v} xxx')).toEqual(['%s', '%1$d', '{{name}}', '{count}', '${v}', 'xxx']);
  });
  it('warns on missing/extra/malformed placeholders but accepts reordered positional args', () => {
    expect(validateTranslation('Hello {{name}}', 'Ciao')).toEqual([expect.objectContaining({ kind: 'missing', token: '{{name}}' })]);
    expect(validateTranslation('Hi', 'Ciao %s')).toEqual([expect.objectContaining({ kind: 'extra' })]);
    expect(validateTranslation('Hello {{name}}', 'Ciao {{name}')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'malformed' })]));
    expect(validateTranslation('%1$s to %2$s', '%2$s da %1$s')).toEqual([]);
    expect(validateTranslation('Order', 'Ordine molto lungo', { maxLength: 5 })[0].kind).toBe('too_long');
  });
  it('save responses include warnings without blocking the save', async () => {
    const k = (await keyOn(env.db, 'Dashboard Front end (deprecated)', 'ErrorValue‌Between'))!;
    await env.db.query('UPDATE platforms SET is_archived=false WHERE slug=$1', ['dashboard-frontend-legacy']);
    const res = await admin.put('/api/translations', { keyId: k.id, languageId: L('it'), value: 'Errore senza segnaposto', status: 'draft', expectedVersion: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings.map((w: any) => w.token)).toEqual(expect.arrayContaining(['{{start}}', '{{startO}}', '{{endO}}']));
  });
});
