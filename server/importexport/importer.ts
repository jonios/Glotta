import type { Queryable } from '../db/client.js';
import { normalizeLabel, PLATFORM_SEEDS } from '../catalog.js';
import { applyColumnOverrides, parseWorkbook, type ParsedSheet } from './workbook-parser.js';
import type { ImportStrategy } from '../../shared/domain.js';

/**
 * Import pipeline:  parse → analyse → plan (pure, against an in-memory snapshot) → apply.
 * Dry runs stop after planning. Nothing from the workbook is dropped: each cell either
 * becomes data, an open conflict, or a preserved `legacy_cells` row.
 *
 * Key identity rules (namespace strategy):
 *  - Within one platform an identifier is unique (DB-enforced).
 *  - A row whose keyword already exists on the target platform updates that key (re-import),
 *    or – when the keyword appeared earlier in the same sheet – is a duplicate row whose
 *    differences become conflicts.
 *  - Otherwise an existing key with the same identifier is *shared* with the platform only if
 *    its source text matches and no translation disagrees. A shared key keeps one set of
 *    translations for all platforms.
 *  - Otherwise a new key is created in namespace "shared", or in the platform's own namespace
 *    (its slug) when "shared" already holds a different key with that identifier. Platform-
 *    specific strings therefore never get mixed.
 */

export interface SheetOption {
  name: string;
  action: 'import' | 'skip';
  platformId?: number;
  createPlatform?: { name: string; slug: string; archived: boolean };
  columnOverrides?: Record<number, string>; // column index → language code | 'ignore'
}

export interface ImportOptions {
  sheets: SheetOption[];
  strategy: ImportStrategy;
  importedStatus: 'approved' | 'needs_review' | 'draft';
}

interface SnapKey {
  id: number;
  namespace: string;
  identifier: string;
  source: string;
  platforms: Set<number>;
}
interface SnapTr {
  id: number | null;
  value: string;
  status: string;
}

export interface Snapshot {
  sourceLanguageId: number;
  languages: Map<string, { id: number; code: string; name: string; isSource: boolean }>;
  platforms: Map<number, { id: number; slug: string; name: string; archived: boolean }>;
  keys: Map<number, SnapKey>;
  byIdentifier: Map<string, number[]>;
  byNsIdent: Map<string, number>;
  platformKey: Map<string, number>;
  translations: Map<string, SnapTr>;
  segments: Map<string, number>;
}

const k2 = (a: string | number, b: string | number) => `${a}\u0000${b}`;

export async function loadSnapshot(q: Queryable): Promise<Snapshot> {
  const [langs, plats, keys, kps, trs, segs] = await Promise.all([
    q.query('SELECT id, code, name, is_source FROM languages'),
    q.query('SELECT id, slug, name, is_archived FROM platforms'),
    q.query('SELECT id, namespace, identifier, source_text FROM translation_keys'),
    q.query('SELECT key_id, platform_id, identifier FROM key_platforms'),
    q.query('SELECT id, key_id, language_id, value, status FROM translations'),
    q.query('SELECT id, name_norm FROM segments'),
  ]);
  const s: Snapshot = {
    sourceLanguageId: langs.find((l: any) => l.is_source)?.id ?? -1,
    languages: new Map(langs.map((l: any) => [l.code, { id: l.id, code: l.code, name: l.name, isSource: l.is_source }])),
    platforms: new Map(plats.map((p: any) => [p.id, { id: p.id, slug: p.slug, name: p.name, archived: p.is_archived }])),
    keys: new Map(),
    byIdentifier: new Map(),
    byNsIdent: new Map(),
    platformKey: new Map(),
    translations: new Map(),
    segments: new Map(segs.map((r: any) => [r.name_norm, r.id])),
  };
  for (const k of keys as any[]) addKey(s, { id: k.id, namespace: k.namespace, identifier: k.identifier, source: k.source_text, platforms: new Set() });
  for (const kp of kps as any[]) {
    s.keys.get(kp.key_id)?.platforms.add(kp.platform_id);
    s.platformKey.set(k2(kp.platform_id, kp.identifier), kp.key_id);
  }
  for (const t of trs as any[]) s.translations.set(k2(t.key_id, t.language_id), { id: t.id, value: t.value, status: t.status });
  return s;
}

function addKey(s: Snapshot, k: SnapKey) {
  s.keys.set(k.id, k);
  s.byIdentifier.set(k.identifier, [...(s.byIdentifier.get(k.identifier) ?? []), k.id]);
  s.byNsIdent.set(k2(k.namespace, k.identifier), k.id);
}

// ------------------------------------------------------------------------------- plan types
export interface PlanConflict {
  keyId: number;
  languageId: number | null;
  kind: 'value_mismatch' | 'duplicate_column' | 'duplicate_row' | 'source_mismatch';
  sheet: string;
  row: number;
  header: string;
  current: string;
  incoming: string;
}
export interface PlanLegacyCell {
  sheet: string;
  row: number;
  col: number;
  header: string;
  keyId: number | null;
  languageId: number | null;
  role: 'alternate' | 'unmapped' | 'duplicate_row' | 'excel_error' | 'guide' | 'code_row' | 'orphan';
  value: string;
}
export interface SheetReport {
  sheet: string;
  platform: string;
  skipped: boolean;
  rows: number;
  keysCreated: number;
  keysShared: number;
  keysMatched: number;
  newKeysSkipped: number;
  duplicateRows: number;
  translationsAdded: number;
  translationsUpdated: number;
  translationsUnchanged: number;
  existingKept: number;
  conflicts: number;
  blankCells: number;
  excelErrors: number;
  alternateValues: number;
  unmappedValues: number;
  orphanRows: number;
  sourceChanges: number;
}
export interface Plan {
  newPlatforms: { tempId: number; name: string; slug: string; archived: boolean; kind: string }[];
  newSegments: { tempId: number; name: string; norm: string }[];
  newKeys: { tempId: number; namespace: string; identifier: string; source: string; description: string; legacy: object }[];
  keyPlatforms: { keyId: number; platformId: number; identifier: string; position: number; legacyMeta: string }[];
  keySegments: { keyId: number; segmentId: number }[];
  translationAdds: { keyId: number; languageId: number; value: string }[];
  translationUpdates: { keyId: number; languageId: number; value: string; previous: string }[];
  sourceUpdates: { keyId: number; value: string; previous: string }[];
  descriptionUpdates: { keyId: number; value: string }[];
  conflicts: PlanConflict[];
  legacyCells: PlanLegacyCell[];
  layouts: { sheet: string; platformId: number; layout: object }[];
  guideText: string;
  sheets: SheetReport[];
  samples: { kind: string; sheet: string; row: number; key: string; language?: string; current?: string; incoming?: string }[];
}

export function suggestPlatform(sheetName: string, snap: Snapshot): number | null {
  const seed = PLATFORM_SEEDS.find((p) => normalizeLabel(p.sheet) === normalizeLabel(sheetName));
  for (const p of snap.platforms.values()) {
    if (seed && p.slug === seed.slug) return p.id;
    if (normalizeLabel(p.name) === normalizeLabel(sheetName)) return p.id;
  }
  return null;
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60) || 'platform'
  );
}

export function canonicalNames(snap: Snapshot): Record<string, string> {
  return Object.fromEntries([...snap.languages.values()].map((l) => [l.code, l.name]));
}

// ------------------------------------------------------------------------------------ plan
export function planImport(sheets: ParsedSheet[], snap: Snapshot, opts: ImportOptions): Plan {
  const plan: Plan = {
    newPlatforms: [],
    newSegments: [],
    newKeys: [],
    keyPlatforms: [],
    keySegments: [],
    translationAdds: [],
    translationUpdates: [],
    sourceUpdates: [],
    descriptionUpdates: [],
    conflicts: [],
    legacyCells: [],
    layouts: [],
    guideText: '',
    sheets: [],
    samples: [],
  };
  let temp = -1;
  const keySegSeen = new Set<string>();
  const sourceLang = [...snap.languages.values()].find((l) => l.isSource)!;
  const sample = (s: Plan['samples'][number]) => {
    if (plan.samples.filter((x) => x.kind === s.kind).length < 200) plan.samples.push(s);
  };
  const names = canonicalNames(snap);

  const segmentId = (name: string): number | null => {
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    const norm = normalizeLabel(clean);
    let id = snap.segments.get(norm);
    if (id === undefined) {
      id = temp--;
      snap.segments.set(norm, id);
      plan.newSegments.push({ tempId: id, name: clean, norm });
    }
    return id;
  };
  const linkSegment = (keyId: number, name: string) => {
    const sid = segmentId(name);
    if (sid === null) return;
    const kk = k2(keyId, sid);
    if (keySegSeen.has(kk)) return;
    keySegSeen.add(kk);
    plan.keySegments.push({ keyId, segmentId: sid });
  };
  const attach = (key: SnapKey, platformId: number, position: number, legacyMeta: string) => {
    key.platforms.add(platformId);
    snap.platformKey.set(k2(platformId, key.identifier), key.id);
    plan.keyPlatforms.push({ keyId: key.id, platformId, identifier: key.identifier, position, legacyMeta });
  };
  const createKey = (namespaceHint: string | null, identifier: string, source: string, description: string, legacy: object, platSlug: string): SnapKey => {
    let ns = namespaceHint ?? 'shared';
    if (!namespaceHint && snap.byNsIdent.has(k2(ns, identifier))) ns = platSlug;
    for (let n = 2; snap.byNsIdent.has(k2(ns, identifier)); n++) ns = `${namespaceHint ?? platSlug}-${n}`;
    const key: SnapKey = { id: temp--, namespace: ns, identifier, source, platforms: new Set() };
    addKey(snap, key);
    plan.newKeys.push({ tempId: key.id, namespace: ns, identifier, source, description, legacy });
    return key;
  };

  for (const sheet of sheets) {
    const so = opts.sheets.find((s) => s.name === sheet.name);
    const rep: SheetReport = {
      sheet: sheet.name,
      platform: '',
      skipped: !so || so.action === 'skip',
      rows: sheet.rows.length,
      keysCreated: 0,
      keysShared: 0,
      keysMatched: 0,
      newKeysSkipped: 0,
      duplicateRows: 0,
      translationsAdded: 0,
      translationsUpdated: 0,
      translationsUnchanged: 0,
      existingKept: 0,
      conflicts: 0,
      blankCells: 0,
      excelErrors: 0,
      alternateValues: 0,
      unmappedValues: 0,
      orphanRows: sheet.orphanRows.length,
      sourceChanges: 0,
    };
    plan.sheets.push(rep);
    if (!so || so.action === 'skip') continue;
    if (so.columnOverrides && Object.keys(so.columnOverrides).length) applyColumnOverrides(sheet, so.columnOverrides, names);

    // Target platform (normalized sheets may target several via their Platforms column).
    let platformId = so.platformId ?? null;
    if (!platformId && so.createPlatform) {
      const existing = [...snap.platforms.values()].find((p) => p.slug === so.createPlatform!.slug);
      if (existing) platformId = existing.id;
      else {
        platformId = temp--;
        plan.newPlatforms.push({ tempId: platformId, ...so.createPlatform, kind: 'other' });
        snap.platforms.set(platformId, { id: platformId, slug: so.createPlatform.slug, name: so.createPlatform.name, archived: so.createPlatform.archived });
      }
    }
    if (!platformId && sheet.format === 'legacy') {
      rep.skipped = true;
      continue;
    }
    const plat = platformId ? snap.platforms.get(platformId)! : null;
    rep.platform = plat?.name ?? '(from Platforms column)';

    const langCols = sheet.columns.filter((c) => c.role === 'language' && c.languageCode && snap.languages.has(c.languageCode));
    const srcCol = langCols.find((c) => c.primary && c.languageCode === sourceLang.code);
    const targetCols = langCols.filter((c) => c.primary && c.languageCode !== sourceLang.code);
    const altCols = langCols.filter((c) => !c.primary);
    const unmappedCols = sheet.columns.filter((c) => c.role === 'unmapped' || (c.role === 'language' && c.languageCode && !snap.languages.has(c.languageCode)));

    if (sheet.guideText) {
      plan.legacyCells.push({ sheet: sheet.name, row: 1, col: 0, header: '', keyId: null, languageId: null, role: 'guide', value: sheet.guideText });
      if (!plan.guideText) plan.guideText = sheet.guideText;
    }
    if (sheet.codeRow) {
      sheet.codeRow.values.forEach((v, i) => {
        if (v) plan.legacyCells.push({ sheet: sheet.name, row: sheet.codeRow!.rowNumber, col: i, header: sheet.columns[i]?.header ?? '', keyId: null, languageId: null, role: 'code_row', value: v });
      });
    }
    for (const o of sheet.orphanRows) {
      for (const [col, value] of Object.entries(o.values)) {
        const c = sheet.columns[Number(col)];
        plan.legacyCells.push({
          sheet: sheet.name, row: o.rowNumber, col: Number(col), header: c?.header ?? '', keyId: null,
          languageId: c?.languageCode ? snap.languages.get(c.languageCode)?.id ?? null : null, role: 'orphan', value,
        });
      }
    }
    if (plat && sheet.format === 'legacy') {
      plan.layouts.push({
        sheet: sheet.name,
        platformId: plat.id,
        layout: {
          headerRow: sheet.headerRow,
          hasGuide: !!sheet.guideText,
          codeRow: sheet.codeRow?.values ?? null,
          segmentHeader: sheet.segmentHeader,
          columns: sheet.columns.map((c) => ({ index: c.index, header: c.header, role: c.role, languageCode: c.languageCode, primary: c.primary })),
        },
      });
    }

    const touched = new Set<string>(); // platformId+identifier seen in this sheet
    let position = 0;
    for (const row of sheet.rows) {
      position++;
      const kw = row.keyword;
      const srcCell = srcCol ? row.cells.get(srcCol.index) : undefined;
      const source = srcCell && !srcCell.excelError ? srcCell.text : '';
      if (srcCell?.excelError) {
        rep.excelErrors++;
        plan.legacyCells.push({ sheet: sheet.name, row: row.rowNumber, col: srcCol!.index, header: srcCol!.header, keyId: null, languageId: sourceLang.id, role: 'excel_error', value: srcCell.text });
      }
      // Incoming values per language (primary columns), promoting an alternate when the primary is blank.
      const incoming = new Map<number, { value: string; col: number; header: string }>();
      for (const c of targetCols) {
        const cell = row.cells.get(c.index);
        const lang = snap.languages.get(c.languageCode!)!;
        if (cell?.excelError) {
          rep.excelErrors++;
          continue; // recorded below once the key id is known
        }
        if (cell && cell.text.trim()) incoming.set(lang.id, { value: cell.text, col: c.index, header: c.header });
        else rep.blankCells++;
      }
      for (const c of altCols) {
        const cell = row.cells.get(c.index);
        const lang = snap.languages.get(c.languageCode!)!;
        if (lang.isSource || !cell || !cell.text.trim() || cell.excelError) continue;
        if (!incoming.has(lang.id)) {
          incoming.set(lang.id, { value: cell.text, col: c.index, header: c.header });
          rep.blankCells = Math.max(0, rep.blankCells - 1);
        }
      }

      // Resolve the key.
      let key: SnapKey | undefined;
      const rowPlatforms: number[] = [];
      if (sheet.format === 'normalized') {
        for (const pname of row.platforms ?? []) {
          const p = [...snap.platforms.values()].find((x) => normalizeLabel(x.name) === normalizeLabel(pname) || x.slug === pname);
          if (p) rowPlatforms.push(p.id);
        }
        if (plat && !rowPlatforms.includes(plat.id)) rowPlatforms.push(plat.id);
        const existingId = snap.byNsIdent.get(k2(row.namespace ?? 'shared', kw));
        key = existingId !== undefined ? snap.keys.get(existingId) : undefined;
        if (key) rep.keysMatched++;
        else if (opts.strategy === 'only_missing' || !rowPlatforms.length) {
          rep.newKeysSkipped++;
          continue;
        } else {
          // Never create two keys with one identifier on the same platform.
          const clash = rowPlatforms.find((pid) => snap.platformKey.has(k2(pid, kw)));
          if (clash !== undefined) {
            rep.newKeysSkipped++;
            sample({ kind: 'identifier_clash', sheet: sheet.name, row: row.rowNumber, key: kw });
            continue;
          }
          key = createKey(row.namespace ?? 'shared', kw, source, row.description ?? '', { sheet: sheet.name, row: row.rowNumber }, 'shared');
          rep.keysCreated++;
          for (const pid of rowPlatforms) attach(key, pid, position, '');
          for (const id of incoming.keys()) {
            const v = incoming.get(id)!;
            plan.translationAdds.push({ keyId: key.id, languageId: id, value: v.value });
            snap.translations.set(k2(key.id, id), { id: null, value: v.value, status: opts.importedStatus });
            rep.translationsAdded++;
          }
          for (const sname of row.segment.split(',')) linkSegment(key.id, sname);
          continue;
        }
        for (const pid of rowPlatforms) {
          if (!key.platforms.has(pid)) {
            if (snap.platformKey.has(k2(pid, kw))) {
              sample({ kind: 'identifier_clash', sheet: sheet.name, row: row.rowNumber, key: kw });
              continue;
            }
            if (opts.strategy !== 'only_missing') attach(key, pid, position, '');
          }
        }
        if (row.description !== null && opts.strategy === 'update_existing') plan.descriptionUpdates.push({ keyId: key.id, value: row.description });
        for (const sname of row.segment.split(',')) linkSegment(key.id, sname);
      } else {
        const pid = plat!.id;
        const onPlatform = snap.platformKey.get(k2(pid, kw));
        const dupInSheet = touched.has(kw);
        if (onPlatform !== undefined && dupInSheet) {
          // Same keyword twice in one sheet: merge, but keep every differing value visible.
          key = snap.keys.get(onPlatform)!;
          rep.duplicateRows++;
          linkSegment(key.id, row.segment);
          if (source.trim() && source.trim() !== key.source.trim()) {
            plan.conflicts.push({ keyId: key.id, languageId: null, kind: 'duplicate_row', sheet: sheet.name, row: row.rowNumber, header: srcCol?.header ?? 'English', current: key.source, incoming: source });
            plan.legacyCells.push({ sheet: sheet.name, row: row.rowNumber, col: srcCol!.index, header: srcCol!.header, keyId: key.id, languageId: sourceLang.id, role: 'duplicate_row', value: source });
            rep.conflicts++;
            sample({ kind: 'duplicate_row', sheet: sheet.name, row: row.rowNumber, key: kw, language: sourceLang.code, current: key.source, incoming: source });
          }
          for (const [lid, v] of incoming) {
            const cur = snap.translations.get(k2(key.id, lid));
            if (!cur || !cur.value) {
              addTranslation(key.id, lid, v.value);
            } else if (cur.value.trim() !== v.value.trim()) {
              plan.conflicts.push({ keyId: key.id, languageId: lid, kind: 'duplicate_row', sheet: sheet.name, row: row.rowNumber, header: v.header, current: cur.value, incoming: v.value });
              plan.legacyCells.push({ sheet: sheet.name, row: row.rowNumber, col: v.col, header: v.header, keyId: key.id, languageId: lid, role: 'duplicate_row', value: v.value });
              rep.conflicts++;
            }
          }
          recordRowLegacy(key.id);
          continue;
        }
        if (onPlatform !== undefined) {
          key = snap.keys.get(onPlatform)!;
          rep.keysMatched++;
          if (source.trim() && source.trim() !== key.source.trim()) {
            if (opts.strategy === 'update_existing') {
              plan.sourceUpdates.push({ keyId: key.id, value: source, previous: key.source });
              key.source = source;
              rep.sourceChanges++;
            } else if (opts.strategy === 'manual') {
              plan.conflicts.push({ keyId: key.id, languageId: null, kind: 'source_mismatch', sheet: sheet.name, row: row.rowNumber, header: srcCol?.header ?? 'English', current: key.source, incoming: source });
              rep.conflicts++;
            } else rep.existingKept++;
          } else if (!key.source && source) {
            plan.sourceUpdates.push({ keyId: key.id, value: source, previous: '' });
            key.source = source;
          }
          // A "description" / "note" column (CSV or Excel) updates the translator note like the normalized format does.
          if (row.description !== null && row.description.trim() && opts.strategy === 'update_existing') plan.descriptionUpdates.push({ keyId: key.id, value: row.description });
        } else {
          const candidates = (snap.byIdentifier.get(kw) ?? [])
            .map((id) => snap.keys.get(id)!)
            .filter((k) => !k.platforms.has(pid) && compatible(k, source, incoming))
            .sort((a, b) => (a.namespace === 'shared' ? -1 : 0) - (b.namespace === 'shared' ? -1 : 0));
          if (opts.strategy === 'only_missing') {
            rep.newKeysSkipped++;
            continue;
          }
          if (candidates[0]) {
            key = candidates[0];
            attach(key, pid, position, row.rawSegment);
            rep.keysShared++;
          } else {
            key = createKey(null, kw, source, row.description ?? '', { sheet: sheet.name, row: row.rowNumber }, plat!.slug);
            attach(key, pid, position, row.rawSegment);
            rep.keysCreated++;
          }
        }
        touched.add(kw);
        linkSegment(key.id, row.segment);
      }

      // Apply incoming values to the resolved key.
      for (const [lid, v] of incoming) {
        const cur = snap.translations.get(k2(key.id, lid));
        if (!cur || !cur.value) addTranslation(key.id, lid, v.value);
        else if (cur.value === v.value || cur.value.trim() === v.value.trim()) rep.translationsUnchanged++;
        else if (opts.strategy === 'update_existing') {
          plan.translationUpdates.push({ keyId: key.id, languageId: lid, value: v.value, previous: cur.value });
          sample({ kind: 'updated', sheet: sheet.name, row: row.rowNumber, key: kw, language: langCode(lid), current: cur.value, incoming: v.value });
          cur.value = v.value;
          rep.translationsUpdated++;
        } else if (opts.strategy === 'manual') {
          plan.conflicts.push({ keyId: key.id, languageId: lid, kind: 'value_mismatch', sheet: sheet.name, row: row.rowNumber, header: v.header, current: cur.value, incoming: v.value });
          sample({ kind: 'conflict', sheet: sheet.name, row: row.rowNumber, key: kw, language: langCode(lid), current: cur.value, incoming: v.value });
          rep.conflicts++;
        } else {
          rep.existingKept++;
          sample({ kind: 'kept_existing', sheet: sheet.name, row: row.rowNumber, key: kw, language: langCode(lid), current: cur.value, incoming: v.value });
        }
      }
      recordRowLegacy(key.id);

      function recordRowLegacy(keyId: number) {
        // Alternate duplicate-language columns that disagree with the primary value.
        for (const c of altCols) {
          const cell = row.cells.get(c.index);
          if (!cell || !cell.text.trim() || cell.excelError) continue;
          const lang = snap.languages.get(c.languageCode!)!;
          const primary = lang.isSource ? source : incoming.get(lang.id)?.value ?? snap.translations.get(k2(keyId, lang.id))?.value ?? '';
          if (primary.trim() === cell.text.trim()) continue;
          rep.alternateValues++;
          plan.legacyCells.push({ sheet: sheet.name, row: row.rowNumber, col: c.index, header: c.header, keyId, languageId: lang.id, role: 'alternate', value: cell.text });
          if (!lang.isSource && primary) {
            plan.conflicts.push({ keyId, languageId: lang.id, kind: 'duplicate_column', sheet: sheet.name, row: row.rowNumber, header: c.header, current: primary, incoming: cell.text });
            rep.conflicts++;
            sample({ kind: 'duplicate_column', sheet: sheet.name, row: row.rowNumber, key: kw, language: lang.code, current: primary, incoming: cell.text });
          }
        }
        for (const c of unmappedCols) {
          const cell = row.cells.get(c.index);
          if (!cell || !cell.text.trim()) continue;
          rep.unmappedValues++;
          plan.legacyCells.push({ sheet: sheet.name, row: row.rowNumber, col: c.index, header: c.header, keyId, languageId: null, role: 'unmapped', value: cell.text });
        }
        for (const c of targetCols) {
          const cell = row.cells.get(c.index);
          if (cell?.excelError) {
            plan.legacyCells.push({ sheet: sheet.name, row: row.rowNumber, col: c.index, header: c.header, keyId, languageId: snap.languages.get(c.languageCode!)!.id, role: 'excel_error', value: cell.text });
          }
        }
      }
    }

    function addTranslation(keyId: number, lid: number, value: string) {
      const cur = snap.translations.get(k2(keyId, lid));
      plan.translationAdds.push({ keyId, languageId: lid, value });
      if (cur) cur.value = value;
      else snap.translations.set(k2(keyId, lid), { id: null, value, status: opts.importedStatus });
      rep.translationsAdded++;
    }
  }
  return plan;

  function langCode(id: number) {
    for (const l of snap.languages.values()) if (l.id === id) return l.code;
    return String(id);
  }
  function compatible(k: SnapKey, source: string, incoming: Map<number, { value: string }>) {
    if (k.source.trim() !== source.trim()) return false;
    for (const [lid, v] of incoming) {
      const cur = snap.translations.get(k2(k.id, lid));
      if (cur && cur.value && cur.value.trim() !== v.value.trim()) return false;
    }
    return true;
  }
}

export function summarize(plan: Plan) {
  const sum = <K extends keyof SheetReport>(k: K) => plan.sheets.reduce((a, s) => a + (s[k] as number), 0);
  return {
    sheetsImported: plan.sheets.filter((s) => !s.skipped).length,
    newPlatforms: plan.newPlatforms.length,
    newSegments: plan.newSegments.length,
    keysCreated: sum('keysCreated'),
    keysShared: sum('keysShared'),
    keysMatched: sum('keysMatched'),
    newKeysSkipped: sum('newKeysSkipped'),
    duplicateRows: sum('duplicateRows'),
    translationsAdded: sum('translationsAdded'),
    translationsUpdated: sum('translationsUpdated'),
    translationsUnchanged: sum('translationsUnchanged'),
    existingKept: sum('existingKept'),
    conflicts: plan.conflicts.length,
    blankCells: sum('blankCells'),
    excelErrors: sum('excelErrors'),
    alternateValues: sum('alternateValues'),
    unmappedValues: sum('unmappedValues'),
    orphanRows: sum('orphanRows'),
    sourceChanges: plan.sourceUpdates.length,
    preservedLegacyCells: plan.legacyCells.length,
  };
}

// ---------------------------------------------------------------------------------- apply
function chunks<T>(arr: T[], n = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function applyPlan(
  q: Queryable,
  plan: Plan,
  ctx: { jobId: number; userId: number; importedStatus: string; onProgress?: (done: number, total: number) => void },
): Promise<void> {
  const ids = new Map<number, number>(); // temp id → real id
  const real = (id: number) => (id < 0 ? ids.get(id)! : id);
  const total = plan.newKeys.length + plan.keyPlatforms.length + plan.translationAdds.length + plan.translationUpdates.length + plan.legacyCells.length + plan.conflicts.length;
  let done = 0;
  const tick = (n: number) => ctx.onProgress?.((done += n), total);

  for (const p of plan.newPlatforms) {
    const r = await q.one<{ id: number }>(
      'INSERT INTO platforms (name, slug, kind, is_archived) VALUES ($1,$2,$3,$4) ON CONFLICT (slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id',
      [p.name, p.slug, p.kind, p.archived],
    );
    ids.set(p.tempId, r!.id);
  }
  for (const s of plan.newSegments) {
    const r = await q.one<{ id: number }>(
      'INSERT INTO segments (name, name_norm) VALUES ($1,$2) ON CONFLICT (name_norm) DO UPDATE SET name_norm=EXCLUDED.name_norm RETURNING id',
      [s.name, s.norm],
    );
    ids.set(s.tempId, r!.id);
  }
  for (const batch of chunks(plan.newKeys)) {
    const rows = await q.query<{ id: number }>(
      `INSERT INTO translation_keys (namespace, identifier, source_text, description, legacy, created_by)
       SELECT ns, ident, src, descr, leg::jsonb, $6 FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
         WITH ORDINALITY AS u(ns, ident, src, descr, leg, ord) ORDER BY ord
       RETURNING id`,
      [
        batch.map((k) => k.namespace),
        batch.map((k) => k.identifier),
        batch.map((k) => k.source),
        batch.map((k) => k.description),
        batch.map((k) => JSON.stringify({ ...k.legacy, importJobId: ctx.jobId })),
        ctx.userId,
      ],
    );
    // RETURNING order follows insertion order for a single INSERT … SELECT … ORDER BY.
    batch.forEach((k, i) => ids.set(k.tempId, rows[i].id));
    tick(batch.length);
  }
  for (const batch of chunks(plan.newKeys.filter((k) => k.source))) {
    await q.query(
      'INSERT INTO source_revisions (key_id, source_text, changed_by) SELECT * FROM unnest($1::int[], $2::text[], $3::int[])',
      [batch.map((k) => real(k.tempId)), batch.map((k) => k.source), batch.map(() => ctx.userId)],
    );
  }
  for (const batch of chunks(plan.keyPlatforms)) {
    await q.query(
      `INSERT INTO key_platforms (key_id, platform_id, identifier, position, legacy_meta)
       SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::int[], $5::text[]) ON CONFLICT DO NOTHING`,
      [batch.map((r) => real(r.keyId)), batch.map((r) => real(r.platformId)), batch.map((r) => r.identifier), batch.map((r) => r.position), batch.map((r) => r.legacyMeta)],
    );
    tick(batch.length);
  }
  for (const batch of chunks(plan.keySegments)) {
    await q.query('INSERT INTO key_segments (key_id, segment_id) SELECT * FROM unnest($1::int[], $2::int[]) ON CONFLICT DO NOTHING', [
      batch.map((r) => real(r.keyId)),
      batch.map((r) => real(r.segmentId)),
    ]);
  }
  // Additions only ever fill empty slots: the WHERE guard makes it impossible to overwrite a value.
  for (const batch of chunks(plan.translationAdds)) {
    const rows = await q.query<{ id: number; value: string; status: string }>(
      `INSERT INTO translations (key_id, language_id, value, status, created_by, import_job_id, approved_at)
       SELECT k, l, v, $4::text, $5::int, $6::int, CASE WHEN $4::text='approved' THEN now() END FROM unnest($1::int[], $2::int[], $3::text[]) AS u(k, l, v)
       ON CONFLICT (key_id, language_id) DO UPDATE SET value=EXCLUDED.value, status=EXCLUDED.status, version=translations.version+1,
         import_job_id=EXCLUDED.import_job_id, updated_at=now()
         WHERE translations.value = ''
       RETURNING id, value, status`,
      [batch.map((r) => real(r.keyId)), batch.map((r) => r.languageId), batch.map((r) => r.value), ctx.importedStatus, ctx.userId, ctx.jobId],
    );
    if (rows.length) {
      await q.query(
        `INSERT INTO translation_history (translation_id, value, status, changed_by, reason) SELECT i, v, s, $4, 'import' FROM unnest($1::int[], $2::text[], $3::text[]) AS u(i, v, s)`,
        [rows.map((r) => r.id), rows.map((r) => r.value), rows.map((r) => r.status), ctx.userId],
      );
    }
    tick(batch.length);
  }
  for (const batch of chunks(plan.translationUpdates)) {
    const rows = await q.query<{ id: number; value: string; status: string }>(
      `UPDATE translations t SET value=u.v, status=$4, version=t.version+1, updated_by=$5, updated_at=now(), import_job_id=$6
       FROM unnest($1::int[], $2::int[], $3::text[]) AS u(k, l, v) WHERE t.key_id=u.k AND t.language_id=u.l
       RETURNING t.id, t.value, t.status`,
      [batch.map((r) => real(r.keyId)), batch.map((r) => r.languageId), batch.map((r) => r.value), ctx.importedStatus, ctx.userId, ctx.jobId],
    );
    await q.query(
      `INSERT INTO translation_history (translation_id, value, status, changed_by, reason) SELECT i, v, s, $4, 'import' FROM unnest($1::int[], $2::text[], $3::text[]) AS u(i, v, s)`,
      [rows.map((r) => r.id), rows.map((r) => r.value), rows.map((r) => r.status), ctx.userId],
    );
    tick(batch.length);
  }
  for (const u of plan.sourceUpdates) {
    const id = real(u.keyId);
    await q.query('UPDATE translation_keys SET source_text=$2, version=version+1, updated_at=now(), updated_by=$3 WHERE id=$1', [id, u.value, ctx.userId]);
    await q.query('INSERT INTO source_revisions (key_id, source_text, changed_by) VALUES ($1,$2,$3)', [id, u.value, ctx.userId]);
    if (u.previous) {
      await q.query(`UPDATE translations SET status='in_progress', source_changed=true WHERE key_id=$1 AND status IN ('approved','needs_review') AND (import_job_id IS DISTINCT FROM $2)`, [id, ctx.jobId]);
    }
  }
  for (const d of plan.descriptionUpdates) {
    await q.query('UPDATE translation_keys SET description=$2, updated_at=now() WHERE id=$1', [real(d.keyId), d.value]);
  }
  for (const batch of chunks(plan.conflicts)) {
    await q.query(
      `INSERT INTO import_conflicts (import_job_id, key_id, language_id, kind, sheet, row_number, header, current_value, incoming_value)
       SELECT $1, * FROM unnest($2::int[], $3::int[], $4::text[], $5::text[], $6::int[], $7::text[], $8::text[], $9::text[])`,
      [
        ctx.jobId,
        batch.map((c) => real(c.keyId)),
        batch.map((c) => c.languageId),
        batch.map((c) => c.kind),
        batch.map((c) => c.sheet),
        batch.map((c) => c.row),
        batch.map((c) => c.header),
        batch.map((c) => c.current),
        batch.map((c) => c.incoming),
      ],
    );
    tick(batch.length);
  }
  for (const batch of chunks(plan.legacyCells)) {
    await q.query(
      `INSERT INTO legacy_cells (import_job_id, sheet, row_number, col_number, header, key_id, language_id, role, value)
       SELECT $1, * FROM unnest($2::text[], $3::int[], $4::int[], $5::text[], $6::int[], $7::int[], $8::text[], $9::text[])`,
      [
        ctx.jobId,
        batch.map((c) => c.sheet),
        batch.map((c) => c.row),
        batch.map((c) => c.col),
        batch.map((c) => c.header),
        batch.map((c) => (c.keyId === null ? null : real(c.keyId))),
        batch.map((c) => c.languageId),
        batch.map((c) => c.role),
        batch.map((c) => c.value),
      ],
    );
    tick(batch.length);
  }
  for (const l of plan.layouts) {
    await q.query(
      `INSERT INTO legacy_sheet_layouts (sheet_name, platform_id, layout, import_job_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (sheet_name) DO UPDATE SET platform_id=EXCLUDED.platform_id, layout=EXCLUDED.layout, import_job_id=EXCLUDED.import_job_id, updated_at=now()`,
      [l.sheet, real(l.platformId), JSON.stringify(l.layout), ctx.jobId],
    );
  }
  if (plan.guideText) {
    await q.query(
      `UPDATE settings SET value=$1, updated_at=now() WHERE key='translator_guidelines' AND value = '""'::jsonb`,
      [JSON.stringify(plan.guideText.trim())],
    );
  }
}

export { parseWorkbook };
