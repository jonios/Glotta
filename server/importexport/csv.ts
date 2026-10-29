import ExcelJS from 'exceljs';

/**
 * CSV import support. A CSV file is turned into a one-sheet workbook in memory and then goes
 * through exactly the same pipeline as Excel (column mapping, dry run, conflict strategies,
 * audit), so both formats behave identically.
 *
 * Accepted: RFC 4180 CSV — comma, semicolon or tab separated (detected from the header line),
 * fields optionally quoted with ", "" inside quotes for a literal quote, line breaks allowed inside
 * quotes, CRLF/LF/CR line endings. Encodings: UTF-8 (with or without BOM) and UTF-16 LE/BE with
 * BOM (Excel's "Unicode Text"). Anything else is rejected with a readable error, never guessed.
 */

export class CsvError extends Error {
  constructor(readonly code: string, message: string, readonly line?: number) {
    super(message);
  }
}

export const MAX_CSV_COLUMNS = 300;

/** Decodes bytes to text, refusing binary data and invalid UTF-8 instead of producing mojibake. */
export function decodeCsv(buffer: Buffer): string {
  if (buffer.length === 0) throw new CsvError('empty_file', 'The file is empty');
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  const body = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? buffer.subarray(3) : buffer;
  if (body.includes(0)) throw new CsvError('binary_file', 'The file contains binary data — it is not a text CSV file');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new CsvError('bad_encoding', 'The file is not valid UTF-8. Save it as "CSV UTF-8" (Excel) or UTF-8 in your editor and try again.');
  }
}

/** Picks the separator that occurs most in the first line, ignoring quoted text. */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch as keyof typeof counts]++;
  }
  const best = (Object.entries(counts) as [',' | ';' | '\t', number][]).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/** Parses CSV text into rows of cells. Throws CsvError with the line number for malformed input. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false; // a quote only opens a quoted field at the very start of the field
  let line = 1;
  let quoteLine = 0;
  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    if (row.length > MAX_CSV_COLUMNS) throw new CsvError('too_many_columns', `Line ${line} has ${row.length} columns; the limit is ${MAX_CSV_COLUMNS}`, line);
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted && field === '') {
      quoted = true;
      fieldStarted = true;
      quoteLine = line;
    } else if (ch === delimiter) endField();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
      line++;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (quoted) throw new CsvError('unclosed_quote', `A quoted field that starts on line ${quoteLine} is never closed (missing ")`, quoteLine);
  if (field !== '' || row.length) endRow();
  // Drop completely empty rows (blank lines) but keep row numbering meaningful for errors elsewhere.
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Excel sheet names: max 31 characters, none of []:*?/\ — the name also suggests the target platform. */
export function sheetNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return (base || 'CSV import').slice(0, 31);
}

/**
 * Builds an in-memory .xlsx with one sheet from CSV bytes. Every cell is written as text, so values
 * such as "=SUM(A1)", "007" or "1e5" are imported exactly as typed, never evaluated or reformatted.
 */
export async function csvToWorkbook(buffer: Buffer, fileName: string): Promise<{ workbook: Buffer; rows: number; columns: number; delimiter: string }> {
  const text = decodeCsv(buffer);
  const delimiter = detectDelimiter(text);
  const rows = parseCsv(text, delimiter);
  if (!rows.length) throw new CsvError('empty_file', 'The file has no rows');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetNameFromFile(fileName));
  for (const r of rows) {
    const added = ws.addRow(r);
    added.eachCell({ includeEmpty: false }, (cell) => {
      cell.value = String(cell.value ?? '');
    });
  }
  const columns = Math.max(...rows.map((r) => r.length));
  return { workbook: Buffer.from(await wb.xlsx.writeBuffer()), rows: rows.length, columns, delimiter };
}
