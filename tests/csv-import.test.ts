import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvToWorkbook, CsvError, decodeCsv, detectDelimiter, parseCsv, sheetNameFromFile } from '../server/importexport/csv.js';
import { createEnv, createUser, ids, login, type Client, type TestEnv } from './helpers.js';

// ------------------------------------------------------------------ helpers

let env: TestEnv;
let admin: Client;
let P: (n: string) => number;
let L: (c: string) => number;

/** Real multipart upload through the HTTP API, exactly as the browser sends it. */
async function upload(fileName: string, content: Buffer | string, client: Client = admin) {
  const boundary = '----glottaTestBoundary7MA4YWxkTrZu0gW';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return env.app.inject({ method: 'POST', url: '/api/import/upload', payload: body, headers: { cookie: client.cookie, 'x-csrf-token': client.csrf, 'content-type': `multipart/form-data; boundary=${boundary}` } });
}

/** Upload → (options from the analysis) → dry run → run → wait until finished. */
async function importFile(fileName: string, content: Buffer | string, opts: { strategy?: string; status?: string; platform?: string; create?: { name: string; slug: string } } = {}) {
  const up = await upload(fileName, content);
  if (up.statusCode !== 200) throw new Error(`upload failed: ${up.statusCode} ${up.body}`);
  const { jobId, sheets } = up.json();
  const options = {
    strategy: opts.strategy ?? 'skip_existing',
    importedStatus: opts.status ?? 'approved',
    sheets: sheets.map((s: any) => ({
      name: s.name,
      action: 'import',
      ...(opts.create ? { createPlatform: { ...opts.create, archived: false } } : { platformId: opts.platform ? P(opts.platform) : s.suggestedPlatformId }),
    })),
  };
  const dry = await admin.post(`/api/import/jobs/${jobId}/dry-run`, options);
  if (dry.statusCode !== 200) throw new Error(`dry run failed: ${dry.statusCode} ${dry.body}`);
  expect((await admin.post(`/api/import/jobs/${jobId}/run`, options)).statusCode).toBe(200);
  let job: any;
  for (let i = 0; i < 200; i++) {
    job = (await admin.get(`/api/import/jobs/${jobId}`)).json();
    if (['completed', 'failed'].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(job.status).toBe('completed');
  return { analysis: up.json(), dryRun: dry.json(), report: job.report };
}

const value = (platform: string, identifier: string, lang: string) =>
  env.db.one<{ value: string; status: string }>(
    `SELECT t.value, t.status FROM translations t JOIN key_platforms kp ON kp.key_id=t.key_id JOIN platforms p ON p.id=kp.platform_id
     WHERE p.name=$1 AND kp.identifier=$2 AND t.language_id=$3`,
    [platform, identifier, L(lang)],
  );
const source = (platform: string, identifier: string) =>
  env.db.one<{ source_text: string; description: string }>(
    `SELECT k.source_text, k.description FROM translation_keys k JOIN key_platforms kp ON kp.key_id=k.id JOIN platforms p ON p.id=kp.platform_id WHERE p.name=$1 AND kp.identifier=$2`,
    [platform, identifier],
  );

async function xlsx(rows: unknown[][], sheet = 'Web Service') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

beforeAll(async () => {
  env = await createEnv();
  await createUser(env.db, { email: 'admin@tms.test', role: 'super_admin' });
  ({ plat: P, lang: L } = await ids(env.db));
  admin = await login(env.app, 'admin@tms.test');
});
afterAll(async () => env?.close());

// ------------------------------------------------------------------ CSV parsing

describe('CSV parsing', () => {
  it('handles quotes, escaped quotes, separators and line breaks inside fields, and all line endings', () => {
    const text = 'key,en,fr\r\nhello,"Hello, world","Bonjour, le monde"\r\nquote,"Say ""hi""","Dis ""salut"""\nmulti,"Line 1\nLine 2","Ligne 1\r\nLigne 2"\rlast,End,Fin';
    expect(parseCsv(text)).toEqual([
      ['key', 'en', 'fr'],
      ['hello', 'Hello, world', 'Bonjour, le monde'],
      ['quote', 'Say "hi"', 'Dis "salut"'],
      ['multi', 'Line 1\nLine 2', 'Ligne 1\r\nLigne 2'],
      ['last', 'End', 'Fin'],
    ]);
  });

  it('detects comma, semicolon and tab separators from the header line', () => {
    expect(detectDelimiter('key;en;fr\na;b;c')).toBe(';');
    expect(detectDelimiter('key\ten\tfr')).toBe('\t');
    expect(detectDelimiter('key,en,fr')).toBe(',');
    expect(detectDelimiter('"a;b",en,fr')).toBe(',');
    expect(parseCsv('key;en\nsave;"Save; now"')).toEqual([['key', 'en'], ['save', 'Save; now']]);
  });

  it('skips blank lines, keeps empty cells, and keeps text exactly (spaces, Unicode, placeholders)', () => {
    expect(parseCsv('key,en,fa\n\n  \nk1,,سلام {name}\n k2 , %s items ,\n')).toEqual([['key', 'en', 'fa'], ['k1', '', 'سلام {name}'], [' k2 ', ' %s items ', '']]);
  });

  it('reports an unclosed quote with its line number', () => {
    try {
      parseCsv('key,en\nok,fine\nbad,"never closed\nmore');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CsvError);
      expect((e as CsvError).code).toBe('unclosed_quote');
      expect((e as CsvError).line).toBe(3);
    }
  });

  it('decodes UTF-8 with and without BOM and UTF-16, and rejects binary or non-UTF-8 data', () => {
    expect(decodeCsv(Buffer.from('﻿key,en', 'utf8'))).toBe('key,en');
    expect(decodeCsv(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('key,fa\nk,سلام', 'utf16le')]))).toBe('key,fa\nk,سلام');
    expect(() => decodeCsv(Buffer.from([0x6b, 0x65, 0x79, 0xe9, 0x2c]))).toThrow(/UTF-8/);
    expect(() => decodeCsv(Buffer.from([0x50, 0x00, 0x01, 0x02]))).toThrow(/binary/);
    expect(() => decodeCsv(Buffer.alloc(0))).toThrow(/empty/);
  });

  it('writes every cell as text, so formulas, leading zeros and numbers are kept as typed', async () => {
    const { workbook } = await csvToWorkbook(Buffer.from('key,en\nf,=SUM(A1:A2)\nz,007\nn,1e5'), 'x.csv');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(workbook as any);
    const ws = wb.worksheets[0];
    expect([ws.getCell('B2').value, ws.getCell('B3').value, ws.getCell('B4').value]).toEqual(['=SUM(A1:A2)', '007', '1e5']);
    expect(sheetNameFromFile('my:app/strings [v2].csv')).toBe('my app strings v2');
  });
});

// ------------------------------------------------------------------ CSV import end to end

describe('CSV import', () => {
  const csv = [
    'key,segment,description,en,fr,fa,ar',
    'welcome,Home,Shown on first launch,"Welcome, {name}!","Bienvenue, {name} !","خوش آمدید، {name}!","مرحبا، {name}!"',
    'items,Cart,,"You have %d items","Vous avez %d articles","%d مورد دارید",',
    'quote,Cart,,"Say ""hello""","Dites « bonjour »",,',
    'multiline,Help,,"Line one\nLine two","Ligne un\nLigne deux",,',
    ',Orphan,,"no key on this row",,,',
  ].join('\r\n');

  it('analyses the file like a one-sheet workbook and maps the columns', async () => {
    const res = await upload('Web Service.csv', csv);
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.fileType).toBe('csv');
    expect(a.csv).toMatchObject({ delimiter: ',', rows: 6, columns: 7 });
    expect(a.sheets).toHaveLength(1);
    const s = a.sheets[0];
    expect(s.name).toBe('Web Service');
    expect(s.suggestedPlatformId).toBe(P('Web Service'));
    expect(s.rowCount).toBe(4);
    expect(s.orphanRows).toBe(1);
    const roles = Object.fromEntries(s.columns.map((c: any) => [c.header, c.role === 'language' ? c.languageCode : c.role]));
    expect(roles).toMatchObject({ key: 'keyword', segment: 'segment', description: 'description', en: 'en', fr: 'fr', fa: 'fa', ar: 'ar' });
  });

  it('imports values exactly — placeholders, quotes, line breaks, RTL text — and creates segments and notes', async () => {
    const { report } = await importFile('Web Service.csv', csv);
    expect(report.summary.translationsAdded).toBeGreaterThan(0);
    expect((await source('Web Service', 'welcome'))).toMatchObject({ source_text: 'Welcome, {name}!', description: 'Shown on first launch' });
    expect((await value('Web Service', 'welcome', 'fa'))).toMatchObject({ value: 'خوش آمدید، {name}!', status: 'approved' });
    expect((await value('Web Service', 'items', 'fr'))!.value).toBe('Vous avez %d articles');
    expect((await source('Web Service', 'quote'))!.source_text).toBe('Say "hello"');
    expect((await value('Web Service', 'multiline', 'fr'))!.value).toBe('Ligne un\nLigne deux');
    expect(await value('Web Service', 'items', 'ar')).toBeUndefined(); // an empty cell is never written
    const seg = await env.db.one(`SELECT s.name FROM segments s JOIN key_segments ks ON ks.segment_id=s.id JOIN key_platforms kp ON kp.key_id=ks.key_id WHERE kp.identifier='items' AND kp.platform_id=$1`, [P('Web Service')]);
    expect(seg.name).toBe('Cart');
    expect(await env.db.one(`SELECT 1 FROM key_platforms WHERE identifier='' AND platform_id=$1`, [P('Web Service')])).toBeUndefined();
  });

  it('re-importing the same file changes nothing (idempotent)', async () => {
    const { dryRun } = await importFile('Web Service.csv', csv);
    expect(dryRun.summary.keysCreated).toBe(0);
    expect(dryRun.summary.translationsAdded).toBe(0);
    expect(dryRun.summary.translationsUpdated ?? 0).toBe(0);
  });

  it('updates existing values only with the update strategy, and records conflicts with "ask me"', async () => {
    const changed = csv.replace('Vous avez %d articles', 'Vous avez %d produits');
    const skip = await importFile('Web Service.csv', changed);
    expect((await value('Web Service', 'items', 'fr'))!.value).toBe('Vous avez %d articles');
    expect(skip.dryRun.summary.translationsUpdated ?? 0).toBe(0);
    await importFile('Web Service.csv', changed, { strategy: 'manual' });
    const conflict = await env.db.one(`SELECT incoming_value FROM import_conflicts WHERE status='open' AND incoming_value='Vous avez %d produits'`);
    expect(conflict).toBeTruthy();
    await importFile('Web Service.csv', changed, { strategy: 'update_existing' });
    expect((await value('Web Service', 'items', 'fr'))!.value).toBe('Vous avez %d produits');
  });

  it('accepts semicolon-separated UTF-8 with BOM (Excel "CSV UTF-8"), TSV, and UTF-16 files', async () => {
    await importFile('Dashboard.csv', '﻿key;en;de\r\nsave_btn;Save;Speichern\r\n');
    expect((await value('Dashboard', 'save_btn', 'de'))!.value).toBe('Speichern');
    await importFile('Dashboard.tsv', 'key\ten\tit\ncancel_btn\tCancel\tAnnulla\n');
    expect((await value('Dashboard', 'cancel_btn', 'it'))!.value).toBe('Annulla');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('key\ten\tfa\r\nback_btn\tBack\tبازگشت\r\n', 'utf16le')]);
    await importFile('Dashboard.csv', utf16);
    expect((await value('Dashboard', 'back_btn', 'fa'))!.value).toBe('بازگشت');
  });

  it('can create a new platform from a CSV file and maps language names as well as codes', async () => {
    await importFile('Partner Portal.csv', 'Keyword,English,Persian,Francais\nhi,Hi,سلام,Salut\n', { create: { name: 'Partner Portal', slug: 'partner-portal' } });
    expect((await value('Partner Portal', 'hi', 'fa'))!.value).toBe('سلام');
    expect((await value('Partner Portal', 'hi', 'fr'))!.value).toBe('Salut');
  });

  it('reports duplicate keys and unknown language columns before anything is written', async () => {
    const res = await upload('Dashboard.csv', 'key,en,Klingon\ndup,One,tlhIngan\ndup,Two,Hol\n');
    expect(res.statusCode).toBe(200);
    const s = res.json().sheets[0];
    expect(s.duplicateKeyCount).toBe(1);
    expect(s.duplicateKeys[0]).toMatchObject({ key: 'dup' });
    expect(s.columns.find((c: any) => c.header === 'Klingon').role).toBe('unmapped');
  });
});

describe('import errors: invalid files and missing fields', () => {
  const expectError = async (fileName: string, content: Buffer | string, status: number, error: string) => {
    const res = await upload(fileName, content);
    expect(res.statusCode, res.body).toBe(status);
    expect(res.json().error).toBe(error);
    return res.json();
  };

  it('rejects empty files, header-only files, and files without a key or language column', async () => {
    await expectError('a.csv', '', 400, 'empty_file');
    await expectError('a.csv', '\n\n  \n', 400, 'empty_file');
    await expectError('a.csv', 'key,en,fr\n', 400, 'no_rows');
    const noKey = await expectError('a.csv', 'name,en\nhello,Hello\n', 400, 'no_key_column');
    expect(noKey.message).toContain('"key"');
    await expectError('a.csv', 'key,colour,size\nhello,red,big\n', 400, 'no_language_columns');
  });

  it('rejects broken CSV, wrong encodings, binary data and unsupported file types with clear messages', async () => {
    const unclosed = await expectError('a.csv', 'key,en\nhello,"Hello\n', 400, 'unclosed_quote');
    expect(unclosed.details.line).toBe(2);
    await expectError('a.csv', Buffer.from([0x6b, 0x65, 0x79, 0x2c, 0x65, 0x6e, 0x0a, 0x6b, 0x2c, 0xe9, 0x74, 0xe9]), 400, 'bad_encoding');
    await expectError('a.csv', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]), 400, 'binary_file');
    await expectError('a.txt', 'key,en\nk,v\n', 400, 'bad_type');
    await expectError('old.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), 400, 'bad_type');
    await expectError('fake.xlsx', 'key,en\nk,v\n', 400, 'bad_type');
    await expectError('broken.xlsx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not really a zip')]), 400, 'unreadable');
  });

  it('requires the import permission and full scope', async () => {
    await createUser(env.db, { email: 'tr@tms.test', role: 'translator', caps: ['view', 'edit_translations'], allLanguages: true, allPlatforms: true });
    const tr = await login(env.app, 'tr@tms.test');
    const res = await upload('Web Service.csv', 'key,en\nk,v\n', tr);
    expect(res.statusCode).toBe(403);
  });
});

describe('Excel import edge cases', () => {
  it('imports a generated workbook and treats an .xlsx renamed to .csv as a workbook', async () => {
    const buf = await xlsx([
      ['Keyword', 'English', 'Italian', 'German'],
      ['xl_save', 'Save', 'Salva', 'Speichern'],
      ['xl_count', '{count} files', '{count} file', null],
    ]);
    await importFile('strings.xlsx', buf, { platform: 'Web Service' });
    expect((await value('Web Service', 'xl_save', 'it'))!.value).toBe('Salva');
    expect((await value('Web Service', 'xl_count', 'it'))!.value).toBe('{count} file');
    expect(await value('Web Service', 'xl_count', 'de')).toBeUndefined();
    const renamed = await upload('really-excel.csv', await xlsx([['key', 'en'], ['k', 'v']]));
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().fileType).toBe('xlsx');
  });

  it('keeps numbers and Excel errors out of translations and finds the header below a guide row', async () => {
    const buf = await xlsx([['Translator guide: keep placeholders'], ['key', 'en', 'fr'], ['num_cell', 42, '#N/A'], ['ok_cell', 'OK', "D'accord"]], 'Dashboard');
    const res = await upload('guide.xlsx', buf);
    const s = res.json().sheets[0];
    expect(s.headerRow).toBe(2);
    expect(s.guideText).toContain('Translator guide');
    await importFile('guide.xlsx', buf);
    expect((await source('Dashboard', 'num_cell'))!.source_text).toBe('42');
    expect(await value('Dashboard', 'num_cell', 'fr')).toBeUndefined(); // "#N/A" is not a translation
    expect((await value('Dashboard', 'ok_cell', 'fr'))!.value).toBe("D'accord");
  });

  it('rejects workbooks without a key column', async () => {
    const res = await upload('nokey.xlsx', await xlsx([['Name', 'English'], ['a', 'b']]));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('no_key_column');
  });
});
