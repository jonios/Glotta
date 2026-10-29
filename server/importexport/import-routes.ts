import type { FastifyInstance } from 'fastify';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import type { Db, Queryable } from '../db/client.js';
import { KEYWORD_HEADERS, normalizeLabel } from '../catalog.js';
import { CsvError, csvToWorkbook } from './csv.js';
import { audit, HttpError, idParam, parse, scopeOf } from '../http.js';
import { sha256 } from '../auth/crypto.js';
import { IMPORT_STRATEGIES } from '../../shared/domain.js';
import {
  applyPlan,
  canonicalNames,
  loadSnapshot,
  parseWorkbook,
  planImport,
  slugify,
  suggestPlatform,
  summarize,
  type ImportOptions,
} from './importer.js';
import type { ParsedSheet } from './workbook-parser.js';

const uploadDir = () => resolve(process.env.UPLOAD_DIR || './.data/uploads');

export async function aliasResolver(q: Queryable) {
  const rows = await q.query<{ alias: string; code: string }>('SELECT a.alias, l.code FROM language_aliases a JOIN languages l ON l.id=a.language_id');
  const m = new Map(rows.map((r) => [r.alias, r.code]));
  return (label: string) => m.get(normalizeLabel(label)) ?? null;
}

export async function parseForImport(q: Queryable, buffer: Buffer) {
  const snap = await loadSnapshot(q);
  const sheets = await parseWorkbook(buffer, await aliasResolver(q), canonicalNames(snap));
  return { snap, sheets };
}

function analysisOf(sheets: ParsedSheet[], snap: Awaited<ReturnType<typeof loadSnapshot>>) {
  return sheets.map((s) => {
    const counts = new Map<string, number[]>();
    for (const r of s.rows) counts.set(r.keyword, [...(counts.get(r.keyword) ?? []), r.rowNumber]);
    const dupKeys = [...counts.entries()].filter(([, rows]) => rows.length > 1).map(([key, rows]) => ({ key, rows }));
    const langCols = s.columns.filter((c) => c.role === 'language');
    const blanks: Record<string, number> = {};
    for (const c of langCols.filter((c) => c.primary)) {
      blanks[c.languageCode!] = s.rows.filter((r) => !r.cells.get(c.index)?.text.trim()).length;
    }
    const duplicateLanguageColumns = [...new Set(langCols.filter((c) => !c.primary).map((c) => c.languageCode!))];
    const suggested = suggestPlatform(s.name, snap);
    return {
      name: s.name,
      format: s.format,
      deprecated: s.deprecated,
      headerRow: s.headerRow,
      guideText: s.guideText.slice(0, 4000),
      codeRow: s.codeRow?.values ?? null,
      segmentHeader: s.segmentHeader,
      rowCount: s.rows.length,
      orphanRows: s.orphanRows.length,
      columns: s.columns.filter((c) => c.role !== 'ignored' || c.header).map((c) => ({ ...c, unknownLanguage: c.role === 'language' && !snap.languages.has(c.languageCode!) })),
      duplicateKeys: dupKeys.slice(0, 100),
      duplicateKeyCount: dupKeys.length,
      duplicateLanguageColumns,
      blankCells: blanks,
      suggestedPlatformId: suggested,
      suggestedAction: s.rows.length === 0 ? 'skip' : 'import',
      suggestedNewPlatform: suggested ? null : { name: s.name, slug: slugify(s.name), archived: s.deprecated },
      sample: s.rows.slice(0, 5).map((r) => ({
        row: r.rowNumber,
        keyword: r.keyword,
        segment: r.segment,
        values: Object.fromEntries([...r.cells.entries()].slice(0, 6).map(([i, v]) => [s.columns[i]?.header || `#${i + 1}`, v.text.slice(0, 120)])),
      })),
    };
  });
}

const optionsSchema = z.object({
  strategy: z.enum(IMPORT_STRATEGIES),
  importedStatus: z.enum(['approved', 'needs_review', 'draft']),
  sheets: z
    .array(
      z.object({
        name: z.string().max(200),
        action: z.enum(['import', 'skip']),
        platformId: z.number().int().positive().optional(),
        createPlatform: z
          .object({ name: z.string().trim().min(1).max(100), slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(60), archived: z.boolean() })
          .optional(),
        columnOverrides: z.record(z.string().regex(/^\d+$/), z.string().max(20)).optional(),
      }),
    )
    .max(200),
});

/** Running jobs report progress from memory; the database holds the durable status. */
const progress = new Map<number, { done: number; total: number; phase: string }>();

export async function runImport(db: Db, jobId: number, userId: number, buffer: Buffer, opts: ImportOptions, dryRun: boolean) {
  const { snap, sheets } = await parseForImport(db, buffer);
  const plan = planImport(sheets, snap, opts);
  const report = { summary: summarize(plan), sheets: plan.sheets, samples: plan.samples, dryRun };
  if (dryRun) {
    await db.query(`UPDATE import_jobs SET status='dry_run', options=$2, report=$3 WHERE id=$1`, [jobId, JSON.stringify(opts), JSON.stringify(report)]);
    return report;
  }
  await db.query(`UPDATE import_jobs SET status='running', options=$2 WHERE id=$1`, [jobId, JSON.stringify(opts)]);
  progress.set(jobId, { done: 0, total: 1, phase: 'writing' });
  try {
    await db.tx(async (q) => {
      await applyPlan(q, plan, {
        jobId,
        userId,
        importedStatus: opts.importedStatus,
        onProgress: (done, total) => progress.set(jobId, { done, total, phase: 'writing' }),
      });
      await audit(q, userId, {
        action: 'import.executed',
        resourceType: 'import_job',
        resourceId: jobId,
        after: report.summary,
        jobRef: `import:${jobId}`,
      });
    });
    await db.query(`UPDATE import_jobs SET status='completed', report=$2, progress=total, finished_at=now() WHERE id=$1`, [jobId, JSON.stringify(report)]);
  } catch (err: any) {
    await db.query(`UPDATE import_jobs SET status='failed', error=$2, finished_at=now() WHERE id=$1`, [jobId, String(err?.message ?? err).slice(0, 1000)]);
    throw err;
  } finally {
    progress.delete(jobId);
  }
  return report;
}

export function storeUpload(jobId: number, buffer: Buffer) {
  mkdirSync(uploadDir(), { recursive: true });
  writeFileSync(join(uploadDir(), `${jobId}.xlsx`), buffer);
}

function loadUpload(jobId: number): Buffer {
  const p = join(uploadDir(), `${jobId}.xlsx`);
  if (!existsSync(p)) throw new HttpError(410, 'upload_gone', 'The uploaded file is no longer available. Upload it again.');
  return readFileSync(p);
}

export function importRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  /**
   * Imports touch every language and platform, so they require all-language and
   * all-platform scope in addition to the `import` capability.
   */
  const requireImport = (req: any) => {
    const scope = scopeOf(req);
    scope.require('import');
    if (!scope.isSuperAdmin && !(scope.allLanguages && scope.allPlatforms)) {
      throw new HttpError(403, 'forbidden', 'Workbook imports require access to all languages and platforms');
    }
    return scope;
  };

  app.post('/api/import/upload', { config: { rateLimit: { max: ctx.config.uploadsPerMinute, timeWindow: '1 minute' } } }, async (req) => {
    const scope = requireImport(req);
    const file = await req.file();
    if (!file) throw new HttpError(400, 'no_file', 'Attach an .xlsx, .csv or .tsv file');
    const isCsv = /\.(csv|tsv)$/i.test(file.filename);
    if (!isCsv && !/\.xlsx$/i.test(file.filename)) throw new HttpError(400, 'bad_type', 'Supported files: Excel workbooks (.xlsx) and CSV/TSV text files (.csv, .tsv)');
    const upload = await file.toBuffer();
    if (file.file.truncated) throw new HttpError(413, 'file_too_large', 'The file is too large');
    const isZip = upload.length >= 4 && upload.readUInt32LE(0) === 0x04034b50;
    let buffer = upload;
    let csvInfo: { rows: number; columns: number; delimiter: string } | null = null;
    if (isCsv) {
      // An .xlsx renamed to .csv is still a workbook; anything else must be CSV text.
      if (!isZip) {
        try {
          const converted = await csvToWorkbook(upload, file.filename);
          buffer = converted.workbook;
          csvInfo = { rows: converted.rows, columns: converted.columns, delimiter: converted.delimiter };
        } catch (err) {
          if (err instanceof CsvError) throw new HttpError(400, err.code, err.message, err.line ? { line: err.line } : undefined);
          throw err;
        }
      }
    } else if (!isZip) {
      // ZIP magic number: an .xlsx is an OOXML zip container. Old .xls and renamed CSVs fail here.
      throw new HttpError(400, 'bad_type', 'The file is not a valid .xlsx workbook. Save it as "Excel Workbook (.xlsx)", or export it as CSV UTF-8.');
    }
    let parsed;
    try {
      parsed = await parseForImport(db, buffer);
    } catch {
      throw new HttpError(400, 'unreadable', 'The workbook could not be read. It may be corrupted or password-protected.');
    }
    const usable = parsed.sheets.filter((s) => s.columns.some((c) => c.role === 'keyword'));
    if (!usable.length) {
      throw new HttpError(400, 'no_key_column', `No key column found. The header row (within the first 6 rows) needs a column named ${KEYWORD_HEADERS.map((h) => `"${h}"`).join(', ')}.`);
    }
    if (!usable.some((s) => s.columns.some((c) => c.role === 'language'))) {
      throw new HttpError(400, 'no_language_columns', 'No language columns found. Name columns after a language code or name, for example "en", "fr", "English" or "Persian" (aliases are listed on the Languages page).');
    }
    if (!usable.some((s) => s.rows.length)) throw new HttpError(400, 'no_rows', 'The file has a header but no rows with a key');
    const analysis = analysisOf(parsed.sheets, parsed.snap);
    const job = await db.one<{ id: number }>(
      `INSERT INTO import_jobs (file_name, file_sha256, analysis, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [file.filename.slice(0, 200), sha256(buffer.toString('base64')), JSON.stringify({ sheets: analysis }), scope.userId],
    );
    storeUpload(job!.id, buffer);
    return { jobId: job!.id, fileName: file.filename, fileType: isCsv && csvInfo ? 'csv' : 'xlsx', csv: csvInfo, sheets: analysis };
  });

  app.post('/api/import/jobs/:id/dry-run', async (req) => {
    const scope = requireImport(req);
    const { id } = parse(idParam, req.params);
    const opts = parse(optionsSchema, req.body) as ImportOptions;
    const job = await db.one('SELECT status FROM import_jobs WHERE id=$1', [id]);
    if (!job) throw new HttpError(404, 'not_found', 'Import job not found');
    if (['running', 'completed'].includes(job.status)) throw new HttpError(409, 'job_done', 'This import has already been executed');
    return runImport(db, id, scope.userId, loadUpload(id), opts, true);
  });

  app.post('/api/import/jobs/:id/run', async (req) => {
    const scope = requireImport(req);
    const { id } = parse(idParam, req.params);
    const opts = parse(optionsSchema, req.body) as ImportOptions;
    const job = await db.one('SELECT status FROM import_jobs WHERE id=$1', [id]);
    if (!job) throw new HttpError(404, 'not_found', 'Import job not found');
    if (['running', 'completed'].includes(job.status)) throw new HttpError(409, 'job_done', 'This import has already been executed');
    const buffer = loadUpload(id);
    // Background execution; the client polls the job for progress.
    void runImport(db, id, scope.userId, buffer, opts, false).catch((err) => req.log.error(err));
    return { jobId: id, status: 'running' };
  });

  app.get('/api/import/jobs/:id', async (req) => {
    const scope = requireImport(req);
    const { id } = parse(idParam, req.params);
    const job = await db.one(
      `SELECT id, file_name AS "fileName", status, options, report, error, created_at AS "createdAt", finished_at AS "finishedAt", analysis
       FROM import_jobs WHERE id=$1`,
      [id],
    );
    if (!job) throw new HttpError(404, 'not_found', 'Import job not found');
    void scope;
    return { ...job, progress: progress.get(id) ?? null };
  });

  app.get('/api/import/jobs', async (req) => {
    requireImport(req);
    return db.query(
      `SELECT j.id, j.file_name AS "fileName", j.status, j.created_at AS "createdAt", j.finished_at AS "finishedAt", u.name AS "createdBy",
              j.report->'summary' AS summary,
              (SELECT count(*)::int FROM import_conflicts c WHERE c.import_job_id=j.id AND c.status='open') AS "openConflicts"
       FROM import_jobs j LEFT JOIN users u ON u.id=j.created_by ORDER BY j.created_at DESC LIMIT 50`,
    );
  });
}
