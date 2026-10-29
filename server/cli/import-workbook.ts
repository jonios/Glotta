// Imports an Excel workbook or a CSV/TSV file from the command line with the same pipeline as the UI wizard.
//   npm run import:workbook -- --file "data/Keywords (5).xlsx" --admin admin@example.com [--strategy skip_existing] [--dry-run]
//   npm run import:workbook -- --file translations.csv --admin admin@example.com
// A CSV becomes one sheet named after the file; it goes to the platform with that name, or a new one.
import { readFileSync } from 'node:fs';
import { csvToWorkbook, CsvError } from '../importexport/csv.js';
import { basename } from 'node:path';
import { openDb, arg } from './common.js';
import { parseForImport, runImport, storeUpload } from '../importexport/import-routes.js';
import { slugify, suggestPlatform, type ImportOptions } from '../importexport/importer.js';
import { sha256 } from '../auth/crypto.js';
import { IMPORT_STRATEGIES, type ImportStrategy } from '../../shared/domain.js';

const file = arg('file');
const adminEmail = arg('admin');
const strategy = (arg('strategy') ?? 'skip_existing') as ImportStrategy;
const dryRun = process.argv.includes('--dry-run');
if (!file || !adminEmail || !IMPORT_STRATEGIES.includes(strategy)) {
  console.error('Usage: npm run import:workbook -- --file <xlsx|csv|tsv> --admin <email> [--strategy skip_existing|only_missing|update_existing|manual] [--dry-run]');
  process.exit(1);
}
const { db } = await openDb();
const admin = await db.one<{ id: number }>(`SELECT id FROM users WHERE email=$1 AND role='super_admin'`, [adminEmail.toLowerCase()]);
if (!admin) {
  console.error(`No Super Admin with email ${adminEmail}. Run npm run admin:create first.`);
  process.exit(1);
}
let buffer: Buffer = readFileSync(file);
if (/\.(csv|tsv)$/i.test(file) && buffer.readUInt32LE(0) !== 0x04034b50) {
  try {
    buffer = (await csvToWorkbook(buffer, basename(file))).workbook;
  } catch (err) {
    console.error(err instanceof CsvError ? `CSV error: ${err.message}` : err);
    process.exit(1);
  }
}
const { snap, sheets } = await parseForImport(db, buffer);
const opts: ImportOptions = {
  strategy,
  importedStatus: 'approved',
  sheets: sheets.map((s) => {
    const pid = suggestPlatform(s.name, snap);
    return pid
      ? { name: s.name, action: s.rows.length ? 'import' : 'skip', platformId: pid }
      : { name: s.name, action: 'import', createPlatform: { name: s.name, slug: slugify(s.name), archived: s.deprecated } };
  }),
};
const job = await db.one<{ id: number }>('INSERT INTO import_jobs (file_name, file_sha256, created_by) VALUES ($1,$2,$3) RETURNING id', [
  basename(file),
  sha256(buffer.toString('base64')),
  admin.id,
]);
storeUpload(job!.id, buffer);
const started = Date.now();
const report = await runImport(db, job!.id, admin.id, buffer, opts, dryRun);
console.log(`${dryRun ? 'Dry run' : 'Import'} #${job!.id} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.table(report.sheets.map((s) => ({ sheet: s.sheet, platform: s.platform, rows: s.rows, created: s.keysCreated, shared: s.keysShared, matched: s.keysMatched, dupRows: s.duplicateRows, added: s.translationsAdded, conflicts: s.conflicts, preservedAlt: s.alternateValues })));
console.log(report.summary);
await db.close();
