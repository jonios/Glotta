import ExcelJS from 'exceljs';
import {
  COLUMN_OVERRIDES,
  DESCRIPTION_HEADERS,
  KEYWORD_HEADERS,
  NAMESPACE_HEADERS,
  normalizeLabel,
  PLATFORMS_HEADERS,
  SEGMENT_HEADERS,
} from '../catalog.js';

/**
 * Parses an .xlsx workbook into a neutral structure. It understands both the legacy layout
 * (one sheet per platform, language-named columns, forward-filled Screen/Page/Path column,
 * optional guide row and locale-code row) and the normalized export of this application.
 * The parser never alters cell text: whitespace, line breaks, Unicode and placeholders are
 * kept byte-for-byte; only comparisons elsewhere use trimmed values.
 */

export type ColumnRole = 'keyword' | 'segment' | 'namespace' | 'platforms' | 'description' | 'language' | 'unmapped' | 'ignored';

export interface ParsedColumn {
  index: number; // zero-based
  header: string;
  role: ColumnRole;
  languageCode: string | null; // for role=language
  primary: boolean; // first-choice column when several map to one language
  filled: number;
  detectedBy: 'alias' | 'override' | 'code_row' | 'manual' | null;
}

export interface CellValue {
  text: string;
  excelError?: string;
}

export interface ParsedRow {
  rowNumber: number; // 1-based worksheet row
  keyword: string;
  segment: string; // forward-filled, normalised
  rawSegment: string; // the literal cell on this row ('' when forward-filled)
  namespace: string | null;
  platforms: string[] | null;
  description: string | null;
  cells: Map<number, CellValue>; // column index → value (non-empty only)
}

export interface ParsedSheet {
  name: string;
  deprecated: boolean;
  headerRow: number; // 1-based
  guideText: string;
  codeRow: { rowNumber: number; values: (string | null)[] } | null;
  columns: ParsedColumn[];
  rows: ParsedRow[];
  orphanRows: { rowNumber: number; values: Record<number, string> }[];
  format: 'legacy' | 'normalized';
  segmentHeader: string | null;
}

export type AliasResolver = (label: string) => string | null; // returns language code

const EXCEL_ERRORS = new Set(['#N/A', '#REF!', '#VALUE!', '#DIV/0!', '#NAME?', '#NULL!', '#NUM!', '#SPILL!', '#CALC!']);

export function cellText(v: ExcelJS.CellValue): CellValue | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    if (v === '') return null;
    // Cached formula errors are sometimes stored as plain strings; never import them as text.
    return EXCEL_ERRORS.has(v.trim()) ? { text: v, excelError: v.trim() } : { text: v };
  }
  if (typeof v === 'number' || typeof v === 'boolean') return { text: String(v) };
  if (v instanceof Date) return { text: v.toISOString() };
  if (typeof v === 'object') {
    if ('error' in v) return { text: String((v as any).error), excelError: String((v as any).error) };
    if ('richText' in v) {
      const t = (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
      return t === '' ? null : { text: t };
    }
    if ('formula' in v || 'sharedFormula' in v) {
      const r = (v as any).result;
      if (r && typeof r === 'object' && 'error' in r) return { text: String(r.error), excelError: String(r.error) };
      return r === undefined || r === null || r === '' ? null : cellText(r);
    }
    if ('text' in v) return cellText((v as any).text);
  }
  return { text: String(v) };
}

function rowValues(ws: ExcelJS.Worksheet, rowNumber: number, width: number): (CellValue | null)[] {
  const row = ws.getRow(rowNumber);
  const out: (CellValue | null)[] = [];
  for (let c = 1; c <= width; c++) out.push(cellText(row.getCell(c).value));
  return out;
}

function isKeywordHeader(s: string) {
  return KEYWORD_HEADERS.includes(normalizeLabel(s));
}

function resolveHeader(header: string, resolve: AliasResolver): string | null {
  if (!header.trim()) return null;
  const direct = resolve(header);
  if (direct) return direct;
  // "et-EE (Estonian) - new" → "et-EE (Estonian)"; "Francais   k2" handled via alias.
  const stripped = header.replace(/\s+-\s+new$/i, '');
  if (stripped !== header) return resolve(stripped);
  return null;
}

export async function parseWorkbook(
  buffer: Buffer | ArrayBuffer,
  resolve: AliasResolver,
  canonicalNames: Record<string, string> = {},
): Promise<ParsedSheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const sheets: ParsedSheet[] = [];
  for (const ws of wb.worksheets) {
    if (ws.state === 'veryHidden') continue;
    sheets.push(parseSheet(ws, resolve, canonicalNames));
  }
  return sheets;
}

function parseSheet(ws: ExcelJS.Worksheet, resolve: AliasResolver, canonicalNames: Record<string, string>): ParsedSheet {
  const width = Math.max(ws.columnCount, ws.actualColumnCount, 1);
  const lastRow = ws.rowCount;
  // Header: first of the top 6 rows containing a keyword header.
  let headerRow = 1;
  for (let r = 1; r <= Math.min(6, lastRow); r++) {
    if (rowValues(ws, r, width).some((c) => c && isKeywordHeader(c.text))) {
      headerRow = r;
      break;
    }
  }
  // Deprecated sheets put the header under a merged guide cell whose second column reads "Keyword".
  const guideText = [];
  for (let r = 1; r < headerRow; r++) for (const c of rowValues(ws, r, width)) if (c) guideText.push(c.text);

  const headerCells = rowValues(ws, headerRow, width);
  const headers = headerCells.map((c) => (c ? c.text : ''));
  const columns: ParsedColumn[] = headers.map((h, index) => ({ index, header: h, role: 'ignored', languageCode: null, primary: false, filled: 0, detectedBy: null }));

  const keywordCol = headers.findIndex((h) => isKeywordHeader(h));
  if (keywordCol >= 0) columns[keywordCol].role = 'keyword';
  for (const col of columns) {
    if (col.role !== 'ignored') continue;
    const norm = normalizeLabel(col.header);
    if (norm === 'segment' || norm === 'segments' || (SEGMENT_HEADERS.includes(norm) && col.index < keywordCol)) col.role = 'segment';
    else if (NAMESPACE_HEADERS.includes(norm)) col.role = 'namespace';
    else if (PLATFORMS_HEADERS.includes(norm)) col.role = 'platforms';
    else if (DESCRIPTION_HEADERS.includes(norm)) col.role = 'description';
  }
  // The first column of the legacy layout is the segment column whatever its label ("e", "-").
  if (keywordCol === 1 && columns[0].role === 'ignored') columns[0].role = 'segment';

  // Optional row of locale codes directly under the header (Web Service: "key, en, ar, …").
  let codeRow: ParsedSheet['codeRow'] = null;
  let firstData = headerRow + 1;
  const maybeCodes = rowValues(ws, headerRow + 1, width);
  if (keywordCol >= 0 && maybeCodes[keywordCol] && isKeywordHeader(maybeCodes[keywordCol]!.text)) {
    codeRow = { rowNumber: headerRow + 1, values: maybeCodes.map((c) => (c ? c.text : null)) };
    firstData = headerRow + 2;
  }

  const overrides = COLUMN_OVERRIDES[ws.name] ?? {};
  for (const col of columns) {
    if (col.role !== 'ignored') continue;
    if (overrides[col.index]) {
      col.role = 'language';
      col.languageCode = overrides[col.index];
      col.detectedBy = 'override';
      continue;
    }
    const code = resolveHeader(col.header, resolve);
    if (code) {
      col.role = 'language';
      col.languageCode = code;
      col.detectedBy = 'alias';
    } else if (col.header.trim()) {
      col.role = 'unmapped';
    }
  }

  // Rows.
  const rows: ParsedRow[] = [];
  const orphanRows: ParsedSheet['orphanRows'] = [];
  const segmentCol = columns.find((c) => c.role === 'segment')?.index ?? -1;
  const nsCol = columns.find((c) => c.role === 'namespace')?.index ?? -1;
  const platCol = columns.find((c) => c.role === 'platforms')?.index ?? -1;
  const descCol = columns.find((c) => c.role === 'description')?.index ?? -1;
  let currentSegment = '';
  for (let r = firstData; r <= lastRow; r++) {
    const vals = rowValues(ws, r, width);
    if (vals.every((v) => v === null || v.text.trim() === '')) continue;
    if (segmentCol >= 0 && vals[segmentCol]?.text.trim()) currentSegment = vals[segmentCol]!.text.replace(/\s+/g, ' ').trim();
    const kw = keywordCol >= 0 ? vals[keywordCol]?.text ?? '' : '';
    if (!kw.trim()) {
      const values: Record<number, string> = {};
      vals.forEach((v, i) => v && i !== segmentCol && (values[i] = v.text));
      if (Object.keys(values).length) orphanRows.push({ rowNumber: r, values });
      continue;
    }
    const cells = new Map<number, CellValue>();
    vals.forEach((v, i) => {
      if (!v) return;
      if (columns[i] && ['language', 'unmapped', 'ignored'].includes(columns[i].role)) {
        cells.set(i, v);
        if (v.text.trim()) columns[i].filled++;
      }
    });
    rows.push({
      rowNumber: r,
      keyword: kw.trim(),
      segment: currentSegment,
      rawSegment: segmentCol >= 0 ? vals[segmentCol]?.text ?? '' : '',
      namespace: nsCol >= 0 ? vals[nsCol]?.text.trim() || null : null,
      platforms: platCol >= 0 ? (vals[platCol]?.text ?? '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean) : null,
      description: descCol >= 0 ? vals[descCol]?.text ?? '' : null,
      cells,
    });
  }
  // Header-less columns that carry data are surfaced for manual mapping.
  for (const col of columns) if (col.role === 'ignored' && col.filled > 0) col.role = 'unmapped';

  assignPrimaries(columns, canonicalNames);
  return {
    name: ws.name,
    deprecated: /deprecat/i.test(ws.name),
    headerRow,
    guideText: guideText.join('\n\n'),
    codeRow,
    columns,
    rows,
    orphanRows,
    format: nsCol >= 0 && platCol >= 0 ? 'normalized' : 'legacy',
    segmentHeader: segmentCol >= 0 ? headers[segmentCol] : null,
  };
}

/**
 * When several columns map to one language, the column whose header exactly names the
 * language (e.g. "French" over "Francais") is primary; otherwise the fullest, then the first.
 * The source language column is treated the same way.
 */
export function assignPrimaries(columns: ParsedColumn[], canonicalNames: Record<string, string> = {}) {
  const groups = new Map<string, ParsedColumn[]>();
  for (const c of columns) {
    c.primary = false;
    if (c.role === 'language' && c.languageCode) groups.set(c.languageCode, [...(groups.get(c.languageCode) ?? []), c]);
  }
  for (const [code, cols] of groups) {
    const canonical = normalizeLabel(canonicalNames[code] ?? '');
    const exact = cols.filter((c) => {
      const h = normalizeLabel(c.header);
      return h === canonical || h === code.toLowerCase();
    });
    const pool = exact.length ? exact : cols;
    const best = [...pool].sort((a, b) => b.filled - a.filled || a.index - b.index)[0];
    best.primary = true;
  }
}

export function applyColumnOverrides(sheet: ParsedSheet, overrides: Record<number, string>, canonicalNames: Record<string, string>) {
  for (const [idx, target] of Object.entries(overrides)) {
    const col = sheet.columns[Number(idx)];
    if (!col || ['keyword', 'segment', 'namespace', 'platforms', 'description'].includes(col.role)) continue;
    if (target === 'ignore') {
      col.role = 'ignored';
      col.languageCode = null;
    } else {
      col.role = 'language';
      col.languageCode = target;
    }
    col.detectedBy = 'manual';
  }
  assignPrimaries(sheet.columns, canonicalNames);
}
