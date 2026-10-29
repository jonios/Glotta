import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import type { Queryable } from '../db/client.js';
import type { Scope } from '../authz/scope.js';
import { audit, HttpError, parse, scopeOf, sendFile } from '../http.js';
import { keyFilterSchema, resolveKeyQuery } from '../modules/key-query.js';
import { FORMATS, getFormat, type LocaleBundle } from '../exporters/formats.js';
import { MISSING_POLICIES, STATUSES } from '../../shared/domain.js';

const selectionSchema = z.object({
  platformIds: z.array(z.number().int().positive()).max(100).optional(),
  languageIds: z.array(z.number().int().positive()).max(200).optional(),
  includeSource: z.boolean().default(true),
  segmentIds: z.array(z.number().int().positive()).max(200).optional(),
  keyIds: z.array(z.number().int().positive()).max(50000).optional(),
  statuses: z.array(z.enum(STATUSES)).optional(),
  search: z.string().max(200).optional(),
  includeArchived: z.boolean().default(false),
});

export interface ExportData {
  platforms: { id: number; slug: string; name: string }[];
  languages: { id: number; code: string; name: string; nativeName: string; direction: string; isSource: boolean }[];
  rows: Map<number, { keyId: number; identifier: string; namespace: string; position: number; legacyMeta: string; source: string; description: string }[]>;
  translations: Map<string, { value: string; status: string }>;
  segments: Map<number, string[]>;
  keyPlatformNames: Map<number, string[]>;
}

/**
 * Gathers export data strictly inside the caller's scope. Requested platforms/languages outside
 * the scope are rejected (403), never silently widened.
 */
export async function collectExport(q: Queryable, scope: Scope, sel: z.infer<typeof selectionSchema>): Promise<ExportData> {
  scope.require('export');
  const filter = parse(keyFilterSchema, {});
  const rq = await resolveKeyQuery(q, scope, {
    ...filter,
    platformIds: sel.platformIds,
    languageIds: sel.languageIds,
    segmentIds: sel.segmentIds,
    keyIds: sel.keyIds,
    statuses: sel.statuses,
    search: sel.search,
    includeArchived: sel.includeArchived,
  });
  // Source text is loaded whenever the user may see it (needed for fallbacks and PO msgids);
  // `includeSource` only controls whether a source-language file/column is emitted.
  const canSource = scope.can('view_source');
  const includeSource = sel.includeSource && canSource;
  const langRows = await q.query(
    `SELECT id, code, name, native_name AS "nativeName", direction, is_source AS "isSource" FROM languages
     WHERE (id = ANY($1::int[]) OR ($2 AND is_source)) ORDER BY is_source DESC, sort_order`,
    [rq.languageIds, includeSource],
  );
  const platforms = await q.query('SELECT id, slug, name FROM platforms WHERE id = ANY($1::int[]) ORDER BY sort_order', [rq.platformIds]);
  const keyRows = await q.query(
    `SELECT kp.platform_id, kp.key_id, kp.identifier, kp.position, kp.legacy_meta, k.namespace, k.source_text, k.description
     FROM key_platforms kp JOIN translation_keys k ON k.id=kp.key_id
     WHERE kp.platform_id = ANY($${rq.whereParams.length + 1}::int[]) AND ${rq.where}
     ORDER BY kp.platform_id, kp.position, lower(kp.identifier)`,
    [...rq.whereParams, rq.platformIds],
  );
  const keyIds = [...new Set(keyRows.map((r: any) => r.key_id as number))];
  const langIds = langRows.filter((l: any) => !l.isSource).map((l: any) => l.id);
  const [trs, segs, kpn] = await Promise.all([
    keyIds.length && langIds.length
      ? q.query('SELECT key_id, language_id, value, status FROM translations WHERE key_id = ANY($1::int[]) AND language_id = ANY($2::int[])', [keyIds, langIds])
      : [],
    keyIds.length
      ? q.query('SELECT ks.key_id, s.name FROM key_segments ks JOIN segments s ON s.id=ks.segment_id WHERE ks.key_id = ANY($1::int[]) ORDER BY s.name_norm', [keyIds])
      : [],
    keyIds.length
      ? q.query(
          'SELECT kp.key_id, p.name FROM key_platforms kp JOIN platforms p ON p.id=kp.platform_id WHERE kp.key_id = ANY($1::int[]) AND kp.platform_id = ANY($2::int[]) ORDER BY p.sort_order',
          [keyIds, scope.platformFilter() ?? rq.platformIds],
        )
      : [],
  ]);
  const rows = new Map<number, any[]>();
  for (const r of keyRows as any[]) {
    rows.set(r.platform_id, [
      ...(rows.get(r.platform_id) ?? []),
      { keyId: r.key_id, identifier: r.identifier, namespace: r.namespace, position: r.position, legacyMeta: r.legacy_meta, source: canSource ? r.source_text : '', description: r.description },
    ]);
  }
  const segments = new Map<number, string[]>();
  for (const s of segs as any[]) segments.set(s.key_id, [...(segments.get(s.key_id) ?? []), s.name]);
  const keyPlatformNames = new Map<number, string[]>();
  for (const s of kpn as any[]) keyPlatformNames.set(s.key_id, [...(keyPlatformNames.get(s.key_id) ?? []), s.name]);
  return {
    platforms: platforms as any,
    languages: langRows as any,
    rows,
    translations: new Map((trs as any[]).map((t) => [`${t.key_id}:${t.language_id}`, { value: t.value, status: t.status }])),
    segments,
    keyPlatformNames,
  };
}

function safeSheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31).trim() || 'Sheet';
  let n = 2;
  let out = base;
  while (used.has(out.toLowerCase())) out = `${base.slice(0, 28)} ${n++}`;
  used.add(out.toLowerCase());
  return out;
}

function styleHeader(ws: ExcelJS.Worksheet, row = 1) {
  const r = ws.getRow(row);
  r.font = { bold: true };
  r.alignment = { vertical: 'middle', wrapText: true };
  ws.views = [{ state: 'frozen', ySplit: row }];
}

export async function buildNormalizedWorkbook(data: ExportData, includeStatus: boolean): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Translation Management System';
  const ws = wb.addWorksheet('Translations');
  const langs = data.languages;
  const header = ['Namespace', 'Keyword', 'Platforms', 'Segments', 'Description', ...langs.flatMap((l) => (includeStatus && !l.isSource ? [l.code, `${l.code} status`] : [l.code]))];
  ws.addRow(header);
  const seen = new Set<number>();
  for (const p of data.platforms) {
    for (const r of data.rows.get(p.id) ?? []) {
      if (seen.has(r.keyId)) continue; // a shared key appears once, listing all its platforms
      seen.add(r.keyId);
      const values: string[] = [r.namespace, r.identifier, (data.keyPlatformNames.get(r.keyId) ?? []).join(', '), (data.segments.get(r.keyId) ?? []).join(', '), r.description];
      for (const l of langs) {
        if (l.isSource) values.push(r.source);
        else {
          const t = data.translations.get(`${r.keyId}:${l.id}`);
          values.push(t?.value ?? '');
          if (includeStatus) values.push(t?.status ?? 'missing');
        }
      }
      ws.addRow(values);
    }
  }
  ws.columns.forEach((c, i) => (c.width = i < 2 ? 28 : i < 5 ? 22 : 36));
  styleHeader(ws);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };

  const lw = wb.addWorksheet('Languages');
  lw.addRow(['Code', 'Name', 'Native name', 'Direction', 'Source']);
  for (const l of langs) lw.addRow([l.code, l.name, l.nativeName, l.direction, l.isSource ? 'yes' : '']);
  styleHeader(lw);
  lw.columns.forEach((c) => (c.width = 22));

  const rd = wb.addWorksheet('README');
  rd.addRow(['Normalized translation export']);
  rd.addRow(['Edit only the language columns. Keep Namespace and Keyword unchanged so the file can be re-imported.']);
  rd.addRow(['Language columns use locale codes (see the Languages sheet). Empty cells are untranslated and are never imported as blanks over existing values.']);
  rd.getColumn(1).width = 120;
  return wb;
}

interface LegacyLayout {
  headerRow: number;
  hasGuide: boolean;
  codeRow: (string | null)[] | null;
  segmentHeader: string | null;
  columns: { index: number; header: string; role: string; languageCode: string | null; primary: boolean }[];
}

/**
 * Rebuilds the customer-facing workbook: one sheet per platform with the original column
 * headers, order, guide row and locale-code row. Language columns the caller cannot access
 * are omitted. Values come from the database; alternate duplicate columns ("Francais" next to
 * "French") are filled with their preserved legacy values so the file round-trips.
 */
export async function buildLegacyWorkbook(q: Queryable, scope: Scope, data: ExportData): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const used = new Set<string>();
  const langByCode = new Map(data.languages.map((l) => [l.code, l]));
  const layouts = await q.query<{ sheet_name: string; platform_id: number; layout: LegacyLayout }>(
    'SELECT sheet_name, platform_id, layout FROM legacy_sheet_layouts WHERE platform_id = ANY($1::int[])',
    [data.platforms.map((p) => p.id)],
  );
  const guide = await q.one<{ value: string }>(`SELECT value FROM legacy_cells WHERE role='guide' ORDER BY id DESC LIMIT 1`);
  const fullScope = scope.isSuperAdmin || scope.allLanguages;
  const keyIds = [...new Set([...data.rows.values()].flat().map((r) => r.keyId))];
  const alternates = keyIds.length
    ? await q.query<{ sheet: string; col_number: number; key_id: number; value: string; role: string }>(
        `SELECT DISTINCT ON (sheet, col_number, key_id) sheet, col_number, key_id, value, role FROM legacy_cells
         WHERE key_id = ANY($1::int[]) AND role IN ('alternate','unmapped') ORDER BY sheet, col_number, key_id, id DESC`,
        [keyIds],
      )
    : [];
  const altMap = new Map(alternates.map((a) => [`${a.sheet}\u0000${a.col_number}\u0000${a.key_id}`, a.value]));

  for (const p of data.platforms) {
    const rows = data.rows.get(p.id) ?? [];
    const lay = layouts.find((l) => l.platform_id === p.id);
    const sheetName = lay?.sheet_name ?? p.name;
    let cols: LegacyLayout['columns'];
    if (lay) {
      cols = lay.layout.columns.filter((c) => {
        if (c.role === 'keyword' || c.role === 'segment') return true;
        if (c.role === 'language') return !!c.languageCode && langByCode.has(c.languageCode);
        if (c.role === 'unmapped') return fullScope;
        return c.role === 'ignored' && !c.header ? false : false;
      });
    } else {
      cols = [
        { index: 0, header: 'Segment', role: 'segment', languageCode: null, primary: true },
        { index: 1, header: 'Keyword', role: 'keyword', languageCode: null, primary: true },
        ...data.languages.map((l, i) => ({ index: 2 + i, header: l.isSource ? 'English' : l.name, role: 'language', languageCode: l.code, primary: true })),
      ];
    }
    // Languages added after the import (or missing from the original sheet) are appended.
    for (const l of data.languages) {
      if (!cols.some((c) => c.role === 'language' && c.languageCode === l.code)) {
        cols.push({ index: -1, header: l.name, role: 'language', languageCode: l.code, primary: true });
      }
    }
    const ws = wb.addWorksheet(safeSheetName(sheetName, used));
    if (lay?.layout.hasGuide && guide?.value) {
      ws.addRow([guide.value]);
      ws.getRow(1).alignment = { wrapText: true, vertical: 'top' };
      ws.getRow(1).height = 120;
    }
    ws.addRow(cols.map((c) => c.header));
    const headerRowNumber = ws.rowCount;
    if (lay?.layout.codeRow) ws.addRow(cols.map((c) => (c.index >= 0 ? lay.layout.codeRow![c.index] ?? '' : c.languageCode ?? '')));
    let lastMeta = '';
    for (const r of rows) {
      const segs = data.segments.get(r.keyId) ?? [];
      const values = cols.map((c) => {
        switch (c.role) {
          case 'keyword':
            return r.identifier;
          case 'segment': {
            if (lay) return r.legacyMeta; // exact original cell (forward-fill style)
            const s = segs.join(', ');
            const out = s !== lastMeta ? s : '';
            lastMeta = s;
            return out;
          }
          case 'unmapped':
            return altMap.get(`${sheetName}\u0000${c.index}\u0000${r.keyId}`) ?? '';
          case 'language': {
            const l = langByCode.get(c.languageCode!)!;
            const primary = l.isSource ? r.source : data.translations.get(`${r.keyId}:${l.id}`)?.value ?? '';
            if (!c.primary && c.index >= 0) return altMap.get(`${sheetName}\u0000${c.index}\u0000${r.keyId}`) ?? primary;
            return primary;
          }
          default:
            return '';
        }
      });
      ws.addRow(values);
    }
    styleHeader(ws, headerRowNumber);
    ws.columns.forEach((c, i) => (c.width = cols[i]?.role === 'language' ? 32 : 24));
  }
  if (!data.platforms.length) wb.addWorksheet('Empty');
  return wb;
}

export function exportRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/export/formats', async (req) => {
    scopeOf(req);
    return FORMATS.map((f) => ({ id: f.id, label: f.label, extension: f.extension, description: f.description, supportsNested: !!f.supportsNested, multiLocale: !!f.multiLocale }));
  });

  app.post('/api/export/resources', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const scope = scopeOf(req);
    const body = parse(
      selectionSchema.extend({
        format: z.string().max(40),
        nested: z.boolean().default(false),
        missing: z.enum(MISSING_POLICIES).default('skip'),
        include: z.enum(['any', 'reviewed', 'approved']).default('any'),
        zip: z.boolean().default(false),
      }),
      req.body,
    );
    const fmt = getFormat(body.format);
    if (!fmt) throw new HttpError(400, 'unknown_format', 'Unknown export format');
    const data = await collectExport(db, scope, body);
    const warnings: string[] = [];
    const files: { path: string; content: string }[] = [];
    const src = data.languages.find((l) => l.isSource);
    const okStatus = (s: string) => (body.include === 'approved' ? s === 'approved' : body.include === 'reviewed' ? s === 'approved' || s === 'needs_review' : s !== 'missing');
    let entryCount = 0;
    for (const p of data.platforms) {
      const rows = data.rows.get(p.id) ?? [];
      const bundles: LocaleBundle[] = data.languages.map((l) => ({
        code: l.code,
        isSource: l.isSource,
        entries: rows.map((r) => {
          let value: string | null;
          if (l.isSource) value = r.source || null;
          else {
            const t = data.translations.get(`${r.keyId}:${l.id}`);
            value = t && t.value && okStatus(t.status) ? t.value : null;
          }
          if (value === null && body.missing === 'empty') value = '';
          // English fallback only when explicitly requested.
          if (value === null && body.missing === 'fallback_source' && r.source) value = r.source;
          if (value !== null) entryCount++;
          return { identifier: r.identifier, value, source: r.source, description: r.description };
        }),
      }));
      const out = fmt.render(bundles, { nested: body.nested, sourceCode: src?.code ?? 'en' }, (m) => warnings.push(`${p.name}: ${m}`));
      const prefix = data.platforms.length > 1 ? `${p.slug}/` : '';
      for (const f of out) files.push({ path: prefix + f.path, content: f.content });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const baseName = `${data.platforms.length === 1 ? data.platforms[0].slug : 'platforms'}-${fmt.id}-${stamp}`;
    await db.tx(async (q) => {
      const job = await q.one<{ id: number }>(
        `INSERT INTO export_jobs (kind, format, params, file_name, entry_count, warnings, created_by) VALUES ('resources',$1,$2,$3,$4,$5,$6) RETURNING id`,
        [fmt.id, JSON.stringify(body), baseName, entryCount, JSON.stringify(warnings.slice(0, 500)), scope.userId],
      );
      await audit(q, scope.userId, {
        action: 'export.generated',
        resourceType: 'export_job',
        resourceId: job!.id,
        platformIds: data.platforms.map((p) => p.id),
        after: { format: fmt.id, languages: data.languages.map((l) => l.code), platforms: data.platforms.map((p) => p.name), entries: entryCount },
        jobRef: `export:${job!.id}`,
      }, req.ip);
    });
    reply.header('X-Export-Warnings', String(warnings.length));
    if (files.length === 1 && !body.zip && !warnings.length) {
      const f = files[0];
      const name = f.path.split('/').pop()!;
      const type = fmt.id === 'android' ? 'application/xml' : fmt.id === 'csv' ? 'text/csv' : 'text/plain';
      return sendFile(reply, `${baseName}-${name}`, `${type}; charset=utf-8`, Buffer.from(f.content, 'utf8'));
    }
    const zip = new JSZip();
    for (const f of files) zip.file(f.path, f.content);
    if (warnings.length) zip.file('EXPORT-WARNINGS.txt', warnings.join('\n') + '\n');
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return sendFile(reply, `${baseName}.zip`, 'application/zip', buf);
  });

  app.post('/api/export/excel', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const scope = scopeOf(req);
    const body = parse(selectionSchema.extend({ layout: z.enum(['normalized', 'legacy']), includeStatus: z.boolean().default(false) }), req.body);
    const data = await collectExport(db, scope, body);
    const wb = body.layout === 'legacy' ? await buildLegacyWorkbook(db, scope, data) : await buildNormalizedWorkbook(data, body.includeStatus);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const fileName = `translations-${body.layout}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    await db.tx(async (q) => {
      const job = await q.one<{ id: number }>(
        `INSERT INTO export_jobs (kind, format, params, file_name, entry_count, created_by) VALUES ($1,'xlsx',$2,$3,$4,$5) RETURNING id`,
        [`excel_${body.layout}`, JSON.stringify(body), fileName, [...data.rows.values()].reduce((a, r) => a + r.length, 0), scope.userId],
      );
      await audit(q, scope.userId, {
        action: 'export.generated',
        resourceType: 'export_job',
        resourceId: job!.id,
        platformIds: data.platforms.map((p) => p.id),
        after: { format: `xlsx-${body.layout}`, languages: data.languages.map((l) => l.code), platforms: data.platforms.map((p) => p.name) },
        jobRef: `export:${job!.id}`,
      }, req.ip);
    });
    return sendFile(reply, fileName, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf);
  });

  app.get('/api/export/jobs', async (req) => {
    const scope = scopeOf(req);
    scope.require('export');
    return db.query(
      `SELECT j.id, j.kind, j.format, j.file_name AS "fileName", j.entry_count AS "entryCount", jsonb_array_length(j.warnings) AS warnings,
              j.created_at AS "createdAt", u.name AS "createdBy"
       FROM export_jobs j LEFT JOIN users u ON u.id=j.created_by
       WHERE $1::boolean OR j.created_by=$2 ORDER BY j.created_at DESC LIMIT 30`,
      [scope.isSuperAdmin, scope.userId],
    );
  });
}
