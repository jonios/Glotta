import type { Db, Queryable } from './db/client.js';
import { LANGUAGE_SEEDS, PLATFORM_SEEDS, normalizeLabel } from './catalog.js';
import { DEFAULT_PLACEHOLDER_RULES } from '../shared/placeholders.js';

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  placeholder_rules: DEFAULT_PLACEHOLDER_RULES,
  translator_guidelines: '',
  default_import_status: 'approved',
  organization_name: 'Glotta',
};

/**
 * Seeds reference data (languages, aliases, platforms, settings). Idempotent: existing rows
 * are left untouched so administrators' later edits are never overwritten.
 */
export async function seedReferenceData(db: Db): Promise<void> {
  await db.tx(async (q) => {
    let order = 0;
    for (const l of LANGUAGE_SEEDS) {
      order += 10;
      const row = await q.one<{ id: number }>(
        `INSERT INTO languages (code, name, native_name, direction, is_source, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (code) DO NOTHING RETURNING id`,
        [l.code, l.name, l.nativeName, l.direction ?? 'ltr', !!l.isSource, l.isSource ? 0 : order],
      );
      const id = row?.id ?? (await q.one<{ id: number }>('SELECT id FROM languages WHERE code=$1', [l.code]))!.id;
      for (const a of new Set([l.code, ...l.aliases])) {
        await q.query(
          `INSERT INTO language_aliases (alias, language_id, kind, note) VALUES ($1,$2,$3,$4) ON CONFLICT (alias) DO NOTHING`,
          [normalizeLabel(a), id, /^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(a) && a.length <= 8 ? 'code' : 'label', l.note ?? ''],
        );
      }
    }
    order = 0;
    for (const p of PLATFORM_SEEDS) {
      order += 10;
      await q.query(
        `INSERT INTO platforms (slug, name, kind, is_archived, sort_order, description)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (slug) DO NOTHING`,
        [p.slug, p.name, p.kind, !!p.archived, order, p.description ?? ''],
      );
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      await q.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [k, JSON.stringify(v)]);
    }
  });
}

export async function getSetting<T>(q: Queryable, key: string): Promise<T> {
  const row = await q.one<{ value: T }>('SELECT value FROM settings WHERE key=$1', [key]);
  return (row?.value ?? DEFAULT_SETTINGS[key]) as T;
}
