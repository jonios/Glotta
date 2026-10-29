import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import type { Queryable } from '../db/client.js';
import type { Scope } from '../authz/scope.js';
import { audit, HttpError, idParam, parse, scopeOf } from '../http.js';
import { getSetting } from '../bootstrap.js';
import { assertKeyInScope } from './key-query.js';
import { SAVE_TARGET_STATUSES, type TranslationStatus } from '../../shared/domain.js';
import { validateTranslation, type PlaceholderRule } from '../../shared/placeholders.js';

async function keyPlatforms(q: Queryable, keyId: number): Promise<number[]> {
  return (await q.query<{ platform_id: number }>('SELECT platform_id FROM key_platforms WHERE key_id=$1', [keyId])).map((r) => r.platform_id);
}

function assertTargetLanguage(scope: Scope, languageId: number) {
  if (languageId === scope.sourceLanguageId) {
    throw new HttpError(400, 'source_language', 'Source strings are edited on the key, not as a translation');
  }
  if (!scope.canSeeLanguage(languageId)) throw new HttpError(403, 'language_forbidden', 'You do not have access to this language');
}

export interface SaveInput {
  keyId: number;
  languageId: number;
  value: string;
  status: (typeof SAVE_TARGET_STATUSES)[number];
  expectedVersion: number | null;
  reason?: string;
}

/**
 * Writes one translation with optimistic concurrency. `expectedVersion` is the version the
 * editor loaded (null when it saw no translation); a mismatch returns 409 with the current
 * value so the client can show the conflict instead of overwriting.
 */
export async function saveTranslation(q: Queryable, scope: Scope, input: SaveInput, ip: string) {
  scope.require('edit_translations');
  assertTargetLanguage(scope, input.languageId);
  await assertKeyInScope(q, scope, input.keyId, true);
  const value = input.value;
  let status: TranslationStatus = value.length === 0 ? 'missing' : input.status;
  if (status === 'approved' && !scope.can('approve')) throw new HttpError(403, 'forbidden', 'Missing permission: approve');

  const current = await q.one<{ id: number; value: string; status: TranslationStatus; version: number }>(
    'SELECT id, value, status, version FROM translations WHERE key_id=$1 AND language_id=$2 FOR UPDATE',
    [input.keyId, input.languageId],
  );
  if ((current?.version ?? null) !== input.expectedVersion) {
    throw new HttpError(409, 'version_conflict', 'Someone else saved this translation while you were editing.', {
      current: current ? { value: current.value, status: current.status, version: current.version } : null,
    });
  }
  let row: { id: number; version: number };
  if (current) {
    if (current.value === value && current.status === status) return { id: current.id, version: current.version, status, unchanged: true };
    row = (await q.one(
      `UPDATE translations SET value=$2, status=$3::text, version=version+1, updated_by=$4::int, updated_at=now(), source_changed=false,
         approved_by=CASE WHEN $3::text='approved' THEN $4::int END, approved_at=CASE WHEN $3::text='approved' THEN now() END
       WHERE id=$1 RETURNING id, version`,
      [current.id, value, status, scope.userId],
    ))!;
  } else {
    row = (await q.one(
      `INSERT INTO translations (key_id, language_id, value, status, created_by, updated_by, approved_by, approved_at)
       VALUES ($1,$2,$3,$4::text,$5::int,$5::int, CASE WHEN $4::text='approved' THEN $5::int END, CASE WHEN $4::text='approved' THEN now() END) RETURNING id, version`,
      [input.keyId, input.languageId, value, status, scope.userId],
    ))!;
  }
  await q.query('INSERT INTO translation_history (translation_id, value, status, changed_by, reason) VALUES ($1,$2,$3,$4,$5)', [
    row.id,
    value,
    status,
    scope.userId,
    input.reason ?? 'edit',
  ]);
  await audit(q, scope.userId, {
    action: current ? 'translation.updated' : 'translation.created',
    resourceType: 'translation',
    resourceId: row.id,
    platformIds: await keyPlatforms(q, input.keyId),
    languageId: input.languageId,
    before: current ? { value: current.value, status: current.status } : undefined,
    after: { value, status, keyId: input.keyId },
  }, ip);
  return { id: row.id, version: row.version, status };
}

async function loadTranslationForReview(q: Queryable, scope: Scope, id: number) {
  const t = await q.one<{ id: number; key_id: number; language_id: number; value: string; status: TranslationStatus; version: number }>(
    'SELECT id, key_id, language_id, value, status, version FROM translations WHERE id=$1 FOR UPDATE',
    [id],
  );
  if (!t) throw new HttpError(404, 'not_found', 'Translation not found');
  assertTargetLanguage(scope, t.language_id);
  await assertKeyInScope(q, scope, t.key_id, true);
  return t;
}

export async function reviewTranslation(
  q: Queryable,
  scope: Scope,
  id: number,
  action: 'approve' | 'request_changes' | 'comment',
  comment: string,
  expectedVersion: number | undefined,
  ip: string,
) {
  scope.require(action === 'approve' ? 'approve' : 'review');
  const t = await loadTranslationForReview(q, scope, id);
  if (expectedVersion !== undefined && t.version !== expectedVersion) {
    throw new HttpError(409, 'version_conflict', 'The translation changed since you opened it.', { current: { value: t.value, status: t.status, version: t.version } });
  }
  if (t.status === 'missing') throw new HttpError(400, 'empty', 'An empty translation cannot be reviewed');
  let next: TranslationStatus = t.status;
  if (action === 'approve') next = 'approved';
  if (action === 'request_changes') {
    if (!comment.trim()) throw new HttpError(400, 'comment_required', 'Explain what needs to change');
    next = 'in_progress';
  }
  if (next !== t.status) {
    await q.query(
      `UPDATE translations SET status=$2::text, version=version+1, reviewed_by=$3::int, reviewed_at=now(), source_changed=false,
         approved_by=CASE WHEN $2::text='approved' THEN $3::int END, approved_at=CASE WHEN $2::text='approved' THEN now() END
       WHERE id=$1`,
      [id, next, scope.userId],
    );
    await q.query(`INSERT INTO translation_history (translation_id, value, status, changed_by, reason) VALUES ($1,$2,$3,$4,'review')`, [id, t.value, next, scope.userId]);
  }
  await q.query('INSERT INTO translation_reviews (translation_id, action, comment, reviewer_id) VALUES ($1,$2,$3,$4)', [id, action, comment, scope.userId]);
  await audit(q, scope.userId, {
    action: action === 'approve' ? 'translation.approved' : action === 'request_changes' ? 'translation.rejected' : 'translation.commented',
    resourceType: 'translation',
    resourceId: id,
    platformIds: await keyPlatforms(q, t.key_id),
    languageId: t.language_id,
    before: { status: t.status },
    after: { status: next, comment },
  }, ip);
  return { status: next };
}

export function translationRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.put('/api/translations', async (req) => {
    const scope = scopeOf(req);
    const body = parse(
      z.object({
        keyId: z.number().int().positive(),
        languageId: z.number().int().positive(),
        value: z.string().max(20000),
        status: z.enum(SAVE_TARGET_STATUSES).default('needs_review'),
        expectedVersion: z.number().int().positive().nullable(),
      }),
      req.body,
    );
    const result = await db.tx((q) => saveTranslation(q, scope, body, req.ip));
    const key = await db.one<{ source_text: string; max_length: number | null }>('SELECT source_text, max_length FROM translation_keys WHERE id=$1', [body.keyId]);
    const rules = await getSetting<PlaceholderRule[]>(db, 'placeholder_rules');
    return { ...result, warnings: validateTranslation(key?.source_text ?? '', body.value, { rules, maxLength: key?.max_length }) };
  });

  app.post('/api/translations/:id/review', async (req) => {
    const scope = scopeOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({ action: z.enum(['approve', 'request_changes', 'comment']), comment: z.string().max(2000).default(''), expectedVersion: z.number().int().positive().optional() }),
      req.body,
    );
    return db.tx((q) => reviewTranslation(q, scope, id, body.action, body.comment, body.expectedVersion, req.ip));
  });

  /** Bulk review. All items are authorised first; any failure rolls back the whole batch. */
  app.post('/api/translations/bulk-review', async (req) => {
    const scope = scopeOf(req);
    const body = parse(
      z.object({
        items: z.array(z.object({ keyId: z.number().int().positive(), languageId: z.number().int().positive() })).min(1).max(2000),
        action: z.enum(['approve', 'request_changes']),
        comment: z.string().max(2000).default(''),
      }),
      req.body,
    );
    return db.tx(async (q) => {
      let changed = 0;
      let skipped = 0;
      for (const it of body.items) {
        assertTargetLanguage(scope, it.languageId);
        await assertKeyInScope(q, scope, it.keyId, true);
      }
      for (const it of body.items) {
        const t = await q.one<{ id: number; status: string }>('SELECT id, status FROM translations WHERE key_id=$1 AND language_id=$2', [it.keyId, it.languageId]);
        if (!t || t.status === 'missing' || (body.action === 'approve' && t.status === 'approved')) {
          skipped++;
          continue;
        }
        await reviewTranslation(q, scope, t.id, body.action, body.comment || (body.action === 'request_changes' ? 'Bulk: changes requested' : ''), undefined, req.ip);
        changed++;
      }
      return { changed, skipped };
    });
  });

  // ------------------------------------------------------------------ import conflicts
  app.get('/api/conflicts', async (req) => {
    const scope = scopeOf(req);
    scope.require('view');
    const f = parse(
      z.object({
        status: z.enum(['open', 'kept_current', 'used_incoming', 'dismissed', 'all']).default('open'),
        jobId: z.coerce.number().int().positive().optional(),
        languageId: z.coerce.number().int().positive().optional(),
        kind: z.string().max(40).optional(),
        page: z.coerce.number().int().min(1).default(1),
      }),
      req.query,
    );
    const params: unknown[] = [];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    const conds = ['TRUE'];
    if (f.status !== 'all') conds.push(`c.status=${p(f.status)}`);
    if (f.jobId) conds.push(`c.import_job_id=${p(f.jobId)}`);
    if (f.kind) conds.push(`c.kind=${p(f.kind)}`);
    if (f.languageId) {
      if (!scope.canSeeLanguage(f.languageId)) throw new HttpError(403, 'language_forbidden', 'You do not have access to this language');
      conds.push(`c.language_id=${p(f.languageId)}`);
    }
    const lf = scope.languageFilter();
    if (lf !== null) conds.push(`(c.language_id = ANY(${p(lf)}::int[])${scope.can('view_source') ? ' OR c.language_id IS NULL' : ''})`);
    const pf = scope.platformFilter();
    if (pf !== null) conds.push(`EXISTS (SELECT 1 FROM key_platforms kp WHERE kp.key_id=c.key_id AND kp.platform_id = ANY(${p(pf)}::int[]))`);
    const where = conds.join(' AND ');
    const whereParams = [...params];
    const [total, rows] = await Promise.all([
      db.one<{ n: number }>(`SELECT count(*)::int AS n FROM import_conflicts c WHERE ${where}`, whereParams),
      db.query(
        `SELECT c.id, c.kind, c.sheet, c.row_number AS "row", c.header, c.current_value AS "currentValue", c.incoming_value AS "incomingValue",
                c.status, c.import_job_id AS "jobId", c.key_id AS "keyId", k.identifier, k.namespace,
                l.id AS "languageId", l.code AS "languageCode", l.name AS "languageName"
         FROM import_conflicts c LEFT JOIN translation_keys k ON k.id=c.key_id LEFT JOIN languages l ON l.id=c.language_id
         WHERE ${where} ORDER BY c.id LIMIT 100 OFFSET ${p((f.page - 1) * 100)}`,
        params,
      ),
    ]);
    return { total: total?.n ?? 0, rows };
  });

  app.post('/api/conflicts/:id/resolve', async (req) => {
    const scope = scopeOf(req);
    const { id } = parse(idParam, req.params);
    const { resolution } = parse(z.object({ resolution: z.enum(['kept_current', 'used_incoming', 'dismissed']) }), req.body);
    return db.tx(async (q) => {
      const c = await q.one('SELECT * FROM import_conflicts WHERE id=$1 FOR UPDATE', [id]);
      if (!c) throw new HttpError(404, 'not_found', 'Conflict not found');
      if (c.status !== 'open') throw new HttpError(409, 'already_resolved', 'This conflict was already resolved');
      if (c.key_id) await assertKeyInScope(q, scope, c.key_id, true);
      if (c.language_id) {
        assertTargetLanguage(scope, c.language_id);
        scope.require('edit_translations');
      } else {
        scope.require('edit_source');
      }
      if (resolution === 'used_incoming') {
        if (c.language_id) {
          const t = await q.one<{ version: number; status: string }>('SELECT version, status FROM translations WHERE key_id=$1 AND language_id=$2', [c.key_id, c.language_id]);
          await saveTranslation(
            q,
            scope,
            {
              keyId: c.key_id,
              languageId: c.language_id,
              value: c.incoming_value,
              status: scope.can('approve') ? 'approved' : 'needs_review',
              expectedVersion: t?.version ?? null,
              reason: 'conflict_resolution',
            },
            req.ip,
          );
        } else {
          const k = await q.one<{ source_text: string }>('SELECT source_text FROM translation_keys WHERE id=$1', [c.key_id]);
          await q.query('UPDATE translation_keys SET source_text=$2, version=version+1, updated_at=now(), updated_by=$3 WHERE id=$1', [c.key_id, c.incoming_value, scope.userId]);
          await q.query('INSERT INTO source_revisions (key_id, source_text, changed_by) VALUES ($1,$2,$3)', [c.key_id, c.incoming_value, scope.userId]);
          await q.query(
            `UPDATE translations SET status='in_progress', source_changed=true, version=version+1 WHERE key_id=$1 AND status IN ('approved','needs_review')`,
            [c.key_id],
          );
          await audit(q, scope.userId, { action: 'key.source_changed', resourceType: 'key', resourceId: c.key_id, before: k?.source_text, after: c.incoming_value }, req.ip);
        }
      }
      await q.query('UPDATE import_conflicts SET status=$2, resolved_by=$3, resolved_at=now() WHERE id=$1', [id, resolution, scope.userId]);
      await audit(q, scope.userId, {
        action: 'conflict.resolved',
        resourceType: 'import_conflict',
        resourceId: id,
        languageId: c.language_id,
        after: { resolution },
        jobRef: `import:${c.import_job_id}`,
      }, req.ip);
      return { ok: true };
    });
  });
}
