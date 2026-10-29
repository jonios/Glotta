import { z } from 'zod';
import type { Queryable } from '../db/client.js';
import type { Scope } from '../authz/scope.js';
import { csvInts, HttpError } from '../http.js';
import { STATUSES } from '../../shared/domain.js';

export const FLAGS = ['modified', 'untranslated_source', 'duplicates', 'recent', 'conflicts', 'source_changed', 'no_segment'] as const;

const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const parts = (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (!(values as readonly string[]).includes(p)) {
          ctx.addIssue({ code: 'custom', message: `Unknown value ${p}` });
          return z.NEVER;
        }
      }
      return parts as T[number][];
    });

export const keyFilterSchema = z.object({
  platformIds: csvInts,
  languageIds: csvInts,
  segmentIds: csvInts,
  keyIds: csvInts,
  statuses: csvEnum(STATUSES),
  flags: csvEnum(FLAGS),
  search: z.string().trim().max(200).optional(),
  includeArchived: z.union([z.boolean(), z.enum(['true', 'false'])]).optional().transform((v) => v === true || v === 'true'),
  sort: z.enum(['identifier', 'source', 'updated']).default('identifier'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
export type KeyFilter = z.infer<typeof keyFilterSchema>;

export interface ResolvedQuery {
  where: string;
  params: unknown[]; // where + orderBy parameters
  whereParams: unknown[]; // parameters referenced by `where` alone
  languageIds: number[];
  platformIds: number[];
  orderBy: string;
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

export async function allTargetLanguageIds(q: Queryable): Promise<number[]> {
  return (await q.query<{ id: number }>('SELECT id FROM languages WHERE is_active AND NOT is_source ORDER BY sort_order')).map((r) => r.id);
}

export async function allPlatformIds(q: Queryable, includeArchived: boolean): Promise<number[]> {
  return (
    await q.query<{ id: number }>(`SELECT id FROM platforms ${includeArchived ? '' : 'WHERE NOT is_archived'} ORDER BY sort_order`)
  ).map((r) => r.id);
}

/**
 * Builds the WHERE clause for listing keys. Platform and language scope are always applied:
 * requested ids are validated against the Scope (403 when outside it) and the default is the
 * full authorised set, never "everything".
 */
export async function resolveKeyQuery(q: Queryable, scope: Scope, f: KeyFilter): Promise<ResolvedQuery> {
  const platformIds = scope.resolvePlatforms(f.platformIds, await allPlatformIds(q, f.includeArchived));
  const languageIds = scope.resolveLanguages(f.languageIds, await allTargetLanguageIds(q));
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conds: string[] = [];
  conds.push(`EXISTS (SELECT 1 FROM key_platforms kp WHERE kp.key_id=k.id AND kp.platform_id = ANY(${p(platformIds)}::int[]))`);
  if (!f.includeArchived) conds.push('NOT k.is_archived');
  if (f.keyIds?.length) conds.push(`k.id = ANY(${p(f.keyIds)}::int[])`);
  if (f.segmentIds?.length) conds.push(`EXISTS (SELECT 1 FROM key_segments ks WHERE ks.key_id=k.id AND ks.segment_id = ANY(${p(f.segmentIds)}::int[]))`);
  // Parameters are pushed lazily: PostgreSQL rejects bind values the statement does not reference.
  let langsRef: string | null = null;
  const langs = () => (langsRef ??= p(languageIds));
  if (f.statuses?.length) {
    conds.push(`EXISTS (SELECT 1 FROM unnest(${langs()}::int[]) AS lid
      LEFT JOIN translations t ON t.key_id=k.id AND t.language_id=lid
      WHERE COALESCE(t.status,'missing') = ANY(${p(f.statuses)}::text[]))`);
  }
  for (const flag of f.flags ?? []) {
    switch (flag) {
      case 'modified':
        conds.push(`EXISTS (SELECT 1 FROM translations t WHERE t.key_id=k.id AND t.language_id = ANY(${langs()}::int[]) AND t.updated_by IS NOT NULL)`);
        break;
      case 'untranslated_source':
        conds.push(`k.source_text = ''`);
        break;
      case 'duplicates':
        conds.push(`(EXISTS (SELECT 1 FROM translation_keys k2 WHERE k2.identifier=k.identifier AND k2.id<>k.id)
                     OR EXISTS (SELECT 1 FROM import_conflicts c WHERE c.key_id=k.id AND c.status='open' AND c.kind IN ('duplicate_row','source_mismatch')))`);
        break;
      case 'recent':
        conds.push(`(k.updated_at > now() - interval '7 days' OR EXISTS (SELECT 1 FROM translations t WHERE t.key_id=k.id
                     AND t.language_id = ANY(${langs()}::int[]) AND t.updated_at > now() - interval '7 days'))`);
        break;
      case 'conflicts':
        conds.push(`EXISTS (SELECT 1 FROM import_conflicts c WHERE c.key_id=k.id AND c.status='open'
                     AND (c.language_id IS NULL OR c.language_id = ANY(${langs()}::int[])))`);
        break;
      case 'source_changed':
        conds.push(`EXISTS (SELECT 1 FROM translations t WHERE t.key_id=k.id AND t.language_id = ANY(${langs()}::int[]) AND t.source_changed)`);
        break;
      case 'no_segment':
        conds.push('NOT EXISTS (SELECT 1 FROM key_segments ks WHERE ks.key_id=k.id)');
        break;
    }
  }
  if (f.search) {
    const s = p(`%${likeEscape(f.search)}%`);
    const pl = p(platformIds);
    const parts = [
      `k.identifier ILIKE ${s}`,
      `k.description ILIKE ${s}`,
      `EXISTS (SELECT 1 FROM key_segments ks JOIN segments sg ON sg.id=ks.segment_id WHERE ks.key_id=k.id AND sg.name ILIKE ${s})`,
      `EXISTS (SELECT 1 FROM key_platforms kp JOIN platforms pf ON pf.id=kp.platform_id WHERE kp.key_id=k.id AND kp.platform_id = ANY(${pl}::int[]) AND pf.name ILIKE ${s})`,
      // Only translations in authorised languages are searched.
      `EXISTS (SELECT 1 FROM translations t WHERE t.key_id=k.id AND t.language_id = ANY(${langs()}::int[]) AND t.value ILIKE ${s})`,
    ];
    if (scope.can('view_source')) parts.push(`k.source_text ILIKE ${s}`);
    conds.push(`(${parts.join(' OR ')})`);
  }
  const whereParamCount = params.length;
  const dir = f.dir === 'desc' ? 'DESC' : 'ASC';
  const orderBy =
    f.sort === 'source' && scope.can('view_source')
      ? `lower(k.source_text) ${dir}, k.id`
      : f.sort === 'updated'
        ? `GREATEST(k.updated_at, COALESCE((SELECT max(t.updated_at) FROM translations t WHERE t.key_id=k.id AND t.language_id = ANY(${langs()}::int[])), k.updated_at)) ${dir}, k.id`
        : `lower(k.identifier) ${dir}, k.namespace, k.id`;
  return { where: conds.join(' AND '), params, whereParams: params.slice(0, whereParamCount), languageIds, platformIds, orderBy };
}

export interface KeyRow {
  id: number;
  namespace: string;
  identifier: string;
  sourceText: string | null;
  description: string;
  maxLength: number | null;
  isArchived: boolean;
  version: number;
  updatedAt: string;
  platformCount: number;
  segments: { id: number; name: string }[];
  platforms: { id: number; name: string }[];
  openConflicts: number;
  translations: Record<number, TranslationCell>;
}

export interface TranslationCell {
  id: number;
  value: string;
  status: string;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
  reviewedBy: string | null;
  sourceChanged: boolean;
  /** Latest send-back note, while the translation has not been approved since. */
  feedback: { comment: string; reviewer: string | null; createdAt: string } | null;
}

/** Loads page rows plus their translations for the resolved languages only. */
export async function loadKeyRows(q: Queryable, scope: Scope, rq: ResolvedQuery, limit: number, offset: number): Promise<KeyRow[]> {
  const params = [...rq.params, limit, offset];
  const keys = await q.query(
    `SELECT k.id, k.namespace, k.identifier, k.source_text AS "sourceText", k.description, k.max_length AS "maxLength",
            k.is_archived AS "isArchived", k.version, k.updated_at AS "updatedAt",
            (SELECT count(*)::int FROM key_platforms kp WHERE kp.key_id=k.id) AS "platformCount"
     FROM translation_keys k WHERE ${rq.where} ORDER BY ${rq.orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  if (!keys.length) return [];
  const ids = keys.map((k: any) => k.id);
  const [segs, plats, trs, conflicts] = await Promise.all([
    q.query('SELECT ks.key_id, s.id, s.name FROM key_segments ks JOIN segments s ON s.id=ks.segment_id WHERE ks.key_id = ANY($1::int[]) ORDER BY s.name_norm', [ids]),
    q.query(
      `SELECT kp.key_id, p.id, p.name FROM key_platforms kp JOIN platforms p ON p.id=kp.platform_id
       WHERE kp.key_id = ANY($1::int[]) AND kp.platform_id = ANY($2::int[]) ORDER BY p.sort_order`,
      [ids, scope.platformFilter() ?? (await allPlatformIds(q, true))],
    ),
    rq.languageIds.length
      ? q.query(
          `SELECT t.key_id, t.language_id, t.id, t.value, t.status, t.version, t.updated_at, t.source_changed,
                  uu.name AS updated_by_name, ur.name AS reviewed_by_name,
                  lr.action AS last_review_action, lr.comment AS last_review_comment, lr.created_at AS last_review_at, lru.name AS last_reviewer
           FROM translations t LEFT JOIN users uu ON uu.id=t.updated_by LEFT JOIN users ur ON ur.id=t.reviewed_by
           LEFT JOIN LATERAL (
             SELECT r.action, r.comment, r.created_at, r.reviewer_id FROM translation_reviews r
             WHERE r.translation_id=t.id AND r.action <> 'comment' ORDER BY r.created_at DESC, r.id DESC LIMIT 1
           ) lr ON true
           LEFT JOIN users lru ON lru.id=lr.reviewer_id
           WHERE t.key_id = ANY($1::int[]) AND t.language_id = ANY($2::int[])`,
          [ids, rq.languageIds],
        )
      : Promise.resolve([]),
    q.query(
      `SELECT key_id, count(*)::int AS n FROM import_conflicts WHERE status='open' AND key_id = ANY($1::int[])
       AND (language_id IS NULL OR language_id = ANY($2::int[])) GROUP BY key_id`,
      [ids, rq.languageIds],
    ),
  ]);
  const by = <T extends { key_id: number }>(rows: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of rows) m.set(r.key_id, [...(m.get(r.key_id) ?? []), r]);
    return m;
  };
  const segMap = by(segs as any[]);
  const platMap = by(plats as any[]);
  const trMap = by(trs as any[]);
  const confMap = new Map((conflicts as any[]).map((c) => [c.key_id, c.n]));
  const canSource = scope.can('view_source');
  return keys.map((k: any) => ({
    ...k,
    sourceText: canSource ? k.sourceText : null,
    segments: (segMap.get(k.id) ?? []).map((s: any) => ({ id: s.id, name: s.name })),
    platforms: (platMap.get(k.id) ?? []).map((p: any) => ({ id: p.id, name: p.name })),
    openConflicts: confMap.get(k.id) ?? 0,
    translations: Object.fromEntries(
      (trMap.get(k.id) ?? []).map((t: any) => [
        t.language_id,
        {
          id: t.id,
          value: t.value,
          status: t.status,
          version: t.version,
          updatedAt: t.updated_at,
          updatedBy: t.updated_by_name,
          reviewedBy: t.reviewed_by_name,
          sourceChanged: t.source_changed,
          feedback:
            t.last_review_action === 'request_changes' && t.last_review_comment && t.status !== 'approved'
              ? { comment: t.last_review_comment, reviewer: t.last_reviewer, createdAt: t.last_review_at }
              : null,
        },
      ]),
    ),
  }));
}

/** Throws 404 unless the key is linked to a platform in scope. With `writable`, the platform must also be active. */
export async function assertKeyInScope(q: Queryable, scope: Scope, keyId: number, writable = false): Promise<void> {
  const pf = scope.platformFilter();
  const row = await q.one(
    `SELECT 1 FROM translation_keys k WHERE k.id=$1 AND EXISTS (
       SELECT 1 FROM key_platforms kp JOIN platforms p ON p.id=kp.platform_id
       WHERE kp.key_id=k.id ${pf === null ? '' : 'AND kp.platform_id = ANY($2::int[])'} ${writable ? 'AND NOT p.is_archived' : ''})`,
    pf === null ? [keyId] : [keyId, pf],
  );
  if (!row) throw new HttpError(404, 'not_found', 'Key not found');
}
