import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, createUser, ids, importWorkbook, keyOn, WORKBOOK, type TestEnv } from './helpers.js';
import { parseForImport } from '../server/importexport/import-routes.js';

let env: TestEnv;
let adminId: number;
let firstReport: any;

beforeAll(async () => {
  env = await createEnv();
  adminId = await createUser(env.db, { email: 'admin@tms.test', role: 'super_admin' });
  firstReport = (await importWorkbook(env.db, adminId)).report;
});
afterAll(async () => env?.close());

/** Reads a raw cell from the source workbook with ExcelJS directly, independent of the importer. */
async function sourceCell(sheet: string, keyword: string, header: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(WORKBOOK) as any);
  const ws = wb.getWorksheet(sheet)!;
  const headers = (ws.getRow(1).values as any[]).map((h) => String(h ?? '').trim());
  const kcol = headers.indexOf('Keyword');
  const hcol = headers.indexOf(header);
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (String(row.getCell(kcol).value ?? '').trim() === keyword) return row.getCell(hcol).value;
  }
  return undefined;
}

async function valueOn(platform: string, identifier: string, code: string) {
  const { lang } = await ids(env.db);
  const k = await keyOn(env.db, platform, identifier);
  const t = await env.db.one('SELECT value FROM translations WHERE key_id=$1 AND language_id=$2', [k!.id, lang(code)]);
  return t?.value as string | undefined;
}

describe('workbook import', () => {
  it('imports every active and deprecated worksheet, attaching every keyword row to its platform', async () => {
    const sheets = firstReport.sheets.map((s: any) => s.sheet);
    expect(sheets).toEqual(expect.arrayContaining(['iOS Driver', 'Web Service', 'Dispatcher', 'Dashboard', 'Webservice - deprecated']));
    expect(firstReport.sheets.every((s: any) => !s.skipped)).toBe(true);
    for (const s of firstReport.sheets) {
      const c = await env.db.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM key_platforms kp JOIN platforms p ON p.id=kp.platform_id WHERE p.name=$1',
        [s.platform],
      );
      expect(c!.n, s.sheet).toBe(s.rows - s.duplicateRows);
    }
  });

  it('archives the deprecated worksheets as archived platforms', async () => {
    const p = await env.db.query(`SELECT name, is_archived FROM platforms WHERE slug LIKE '%legacy'`);
    expect(p.length).toBe(2);
    expect(p.every((r: any) => r.is_archived)).toBe(true);
  });

  it('maps language aliases onto one language (French/Francais, Русский, header-less German column)', async () => {
    const { lang } = await ids(env.db);
    const alt = await env.db.one(`SELECT language_id FROM legacy_cells WHERE role='alternate' AND header='Francais' LIMIT 1`);
    expect(alt.language_id).toBe(lang('fr'));
    const count = await env.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM languages WHERE code LIKE 'fr%'`);
    expect(count!.n).toBe(1);
    expect(await valueOn('iOS Customer', 'register_title', 'ru')).toBe('Зарегистрироваться');
    expect(await valueOn('iOS Customer', 'register_title', 'de')).toBe('Registrieren');
  });

  it('keeps distinct locales separate (de vs de-AT, pt vs pt-BR, tl vs fil, zh-Hans vs zh-Hant)', async () => {
    const codes = (await env.db.query<{ code: string }>('SELECT code FROM languages')).map((r) => r.code);
    for (const c of ['de', 'de-AT', 'pt', 'pt-BR', 'tl', 'fil', 'zh-Hans', 'zh-Hant']) expect(codes).toContain(c);
  });

  it('handles duplicate language columns: primary value imported, alternate preserved and raised as a conflict', async () => {
    const { lang } = await ids(env.db);
    expect(await valueOn('iOS Driver', 'internet_error_description', 'fr')).toBe(await sourceCell('iOS Driver', 'internet_error_description', 'French'));
    const k = await keyOn(env.db, 'iOS Driver', 'internet_error_description');
    const alt = await env.db.one(`SELECT value FROM legacy_cells WHERE key_id=$1 AND header='Francais' AND role='alternate'`, [k!.id]);
    expect(alt.value).toBe(await sourceCell('iOS Driver', 'internet_error_description', 'Francais'));
    const conflict = await env.db.one(`SELECT kind, status FROM import_conflicts WHERE key_id=$1 AND language_id=$2 AND kind='duplicate_column'`, [k!.id, lang('fr')]);
    expect(conflict).toMatchObject({ kind: 'duplicate_column', status: 'open' });
  });

  it('handles duplicate keys inside a sheet: one key, conflicts for differing values', async () => {
    const cp = firstReport.sheets.find((s: any) => s.sheet === 'Customer PANEL');
    expect(cp.duplicateRows).toBeGreaterThan(50);
    const k = await keyOn(env.db, 'Customer PANEL', 'block');
    expect(k!.source_text).toBe('Block/Building');
    const c = await env.db.one(`SELECT incoming_value FROM import_conflicts WHERE key_id=$1 AND kind='duplicate_row' AND language_id IS NULL`, [k!.id]);
    expect(c.incoming_value).toBe('Block');
  });

  it('shares identical keys across platforms but separates keys whose source differs', async () => {
    const cp = await keyOn(env.db, 'Customer PANEL', 'login');
    const dp = await keyOn(env.db, 'Dispatcher', 'login');
    expect(cp!.id).not.toBe(dp!.id);
    expect(cp!.source_text).toBe('Login');
    expect(dp!.source_text).toBe('login');
    expect(new Set([cp!.namespace, dp!.namespace]).size).toBe(2);
    const shared = await env.db.one<{ n: number }>('SELECT count(*)::int AS n FROM (SELECT key_id FROM key_platforms GROUP BY key_id HAVING count(*)>1) s');
    expect(shared!.n).toBeGreaterThan(0);
  });

  it('preserves Unicode, line breaks and placeholders byte-for-byte', async () => {
    const k = await keyOn(env.db, 'Dashboard Front end (deprecated)', 'ErrorValue‌Between');
    expect(k!.source_text).toContain('{{start}}');
    expect(k!.source_text).toContain('{{startO}}');
    const fa = await valueOn('Dashboard Front end (deprecated)', 'ErrorValue‌Between', 'fa');
    expect(fa).toContain('{{start}}');
    expect(fa).toContain('\n');
    expect(await valueOn('Web Service (deprecated)', 'Error', 'el')).toBe('Παρουσιάστηκε σφάλμα\n');
    const pct = await env.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM translation_keys WHERE source_text ~ '%[sd@]'`);
    expect(pct!.n).toBeGreaterThan(0);
  });

  it('keeps blank cells blank: no empty translation rows are created', async () => {
    const empty = await env.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM translations WHERE value='' OR status='missing'`);
    expect(empty!.n).toBe(0);
    expect(firstReport.summary.blankCells).toBeGreaterThan(0);
  });

  it('preserves guide text, locale-code rows, orphan rows and Excel errors', async () => {
    const roles = await env.db.query<{ role: string; n: number }>('SELECT role, count(*)::int AS n FROM legacy_cells GROUP BY role');
    const by = Object.fromEntries(roles.map((r) => [r.role, r.n]));
    expect(by.guide).toBeGreaterThan(0);
    expect(by.code_row).toBeGreaterThan(0);
    expect(by.orphan).toBeGreaterThan(0);
    const guide = await env.db.one(`SELECT value FROM settings WHERE key='translator_guidelines'`);
    expect(String(guide.value)).toContain('Translation guide');
  });

  it('re-importing the same workbook changes nothing', async () => {
    const q = `SELECT count(*)::int AS n, md5(string_agg(value, '|' ORDER BY id)) AS h FROM translations`;
    const before = await env.db.one(q);
    const { report } = await importWorkbook(env.db, adminId, 'skip_existing');
    expect(await env.db.one(q)).toEqual(before);
    expect(report.summary.keysCreated).toBe(0);
    expect(report.summary.translationsAdded).toBe(0);
  });

  it('never silently overwrites: skip keeps DB values, manual raises conflicts, update is explicit and recorded', async () => {
    const { lang } = await ids(env.db);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(readFileSync(WORKBOOK) as any);
    const ws = wb.getWorksheet('Receipt')!;
    const headers = (ws.getRow(1).values as any[]).map((h) => String(h ?? '').trim());
    ws.getRow(2).getCell(headers.indexOf('Arabic')).value = 'CHANGED VALUE';
    const changed = Buffer.from(await wb.xlsx.writeBuffer());
    const k = await keyOn(env.db, 'Receipt', String(ws.getRow(2).getCell(headers.indexOf('Keyword')).value));
    const get = async () => (await env.db.one('SELECT value FROM translations WHERE key_id=$1 AND language_id=$2', [k!.id, lang('ar')])).value;
    const original = await get();

    const skip = await importWorkbook(env.db, adminId, 'skip_existing', changed);
    expect(skip.report.summary.existingKept).toBeGreaterThanOrEqual(1);
    expect(await get()).toBe(original);

    const manual = await importWorkbook(env.db, adminId, 'manual', changed);
    const c = await env.db.one(`SELECT current_value, incoming_value FROM import_conflicts WHERE import_job_id=$1 AND kind='value_mismatch'`, [manual.jobId]);
    expect(c).toEqual({ current_value: original, incoming_value: 'CHANGED VALUE' });
    expect(await get()).toBe(original);

    const upd = await importWorkbook(env.db, adminId, 'update_existing', changed);
    expect(upd.report.summary.translationsUpdated).toBe(1);
    expect(await get()).toBe('CHANGED VALUE');
    const hist = await env.db.query(
      `SELECT h.value FROM translation_history h JOIN translations t ON t.id=h.translation_id WHERE t.key_id=$1 AND t.language_id=$2`,
      [k!.id, lang('ar')],
    );
    expect(hist.map((h: any) => h.value)).toEqual(expect.arrayContaining([original, 'CHANGED VALUE']));
  });

  it('dry run writes nothing', async () => {
    const q = `SELECT (SELECT count(*) FROM translation_keys)::int AS k, (SELECT count(*) FROM translations)::int AS t`;
    const before = await env.db.one(q);
    const { report } = await importWorkbook(env.db, adminId, 'update_existing', undefined, true);
    expect(report.dryRun).toBe(true);
    expect(await env.db.one(q)).toEqual(before);
  });

  it('analysis detects duplicate language columns and the locale-code row', async () => {
    const { sheets } = await parseForImport(env.db, readFileSync(WORKBOOK));
    const inv = sheets.find((s) => s.name === 'Invoice')!;
    const frCols = inv.columns.filter((c) => c.languageCode === 'fr');
    // "French" ×3 plus "Francais" all map to fr; exactly one is primary.
    expect(frCols.map((c) => c.header.trim())).toEqual(['French', 'French', 'Francais', 'French']);
    expect(frCols.filter((c) => c.primary).length).toBe(1);
    expect(sheets.find((s) => s.name === 'Web Service')!.codeRow?.values[1]).toBe('en');
  });
});
