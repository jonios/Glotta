import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import type { Queryable } from '../db/client.js';
import type { Scope } from '../authz/scope.js';
import { normalizeLabel } from '../catalog.js';
import { audit, csvInts, HttpError, idParam, parse, scopeOf } from '../http.js';
import { allPlatformIds, allTargetLanguageIds, assertKeyInScope, keyFilterSchema, loadKeyRows, resolveKeyQuery } from './key-query.js';

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((s) => !/[\u0000-\u001f]/.test(s), 'Identifier cannot contain control characters');
const namespaceSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]*$/i, 'Letters, digits, dot, dash, underscore').max(80);

async function platformNames(q: Queryable, ids: number[]): Promise<Map<number, string>> {
  const rows = await q.query<{ id: number; name: string }>('SELECT id, name FROM platforms WHERE id = ANY($1::int[])', [ids]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function keyPlatformIds(q: Queryable, keyId: number): Promise<number[]> {
  return (await q.query<{ platform_id: number }>('SELECT platform_id FROM key_platforms WHERE key_id=$1', [keyId])).map((r) => r.platform_id);
}

/** Ensures adding `identifier` to these platforms keeps (platform, identifier) unique. */
async function assertIdentifierFree(q: Queryable, identifier: string, platformIds: number[], exceptKeyId?: number) {
  if (!platformIds.length) return;
  const clash = await q.one<{ name: string; key_id: number }>(
    `SELECT p.name, kp.key_id FROM key_platforms kp JOIN platforms p ON p.id=kp.platform_id
     WHERE kp.identifier=$1 AND kp.platform_id = ANY($2::int[]) AND kp.key_id <> COALESCE($3, -1) LIMIT 1`,
    [identifier, platformIds, exceptKeyId ?? null],
  );
  if (clash) {
    throw new HttpError(409, 'identifier_conflict', `${clash.name} already has a different key named "${identifier}"`, { keyId: clash.key_id });
  }
}

export async function setKeySegments(q: Queryable, scope: Scope, keyId: number, segmentIds: number[], ip: string) {
  const before = await q.query<{ name: string }>(
    'SELECT s.name FROM key_segments ks JOIN segments s ON s.id=ks.segment_id WHERE ks.key_id=$1 ORDER BY 1',
    [keyId],
  );
  await q.query('DELETE FROM key_segments WHERE key_id=$1', [keyId]);
  if (segmentIds.length) {
    await q.query('INSERT INTO key_segments (key_id, segment_id) SELECT $1, id FROM segments WHERE id = ANY($2::int[]) ON CONFLICT DO NOTHING', [
      keyId,
      segmentIds,
    ]);
  }
  const after = await q.query<{ name: string }>(
    'SELECT s.name FROM key_segments ks JOIN segments s ON s.id=ks.segment_id WHERE ks.key_id=$1 ORDER BY 1',
    [keyId],
  );
  await q.query('UPDATE translation_keys SET updated_at=now(), updated_by=$2 WHERE id=$1', [keyId, scope.userId]);
  await audit(
    q,
    scope.userId,
    {
      action: 'key.segments_changed',
      resourceType: 'key',
      resourceId: keyId,
      platformIds: await keyPlatformIds(q, keyId),
      before: before.map((r) => r.name),
      after: after.map((r) => r.name),
    },
    ip,
  );
}

export function keyRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  // Workspace listing: server-side filtering, sorting and pagination.
  app.get('/api/keys', async (req) => {
    const scope = scopeOf(req);
    scope.require('view');
    const f = parse(keyFilterSchema, req.query);
    const rq = await resolveKeyQuery(db, scope, f);
    const [total, rows] = await Promise.all([
      db.one<{ n: number }>(`SELECT count(*)::int AS n FROM translation_keys k WHERE ${rq.where}`, rq.whereParams),
      loadKeyRows(db, scope, rq, f.pageSize, (f.page - 1) * f.pageSize),
    ]);
    return { total: total?.n ?? 0, page: f.page, pageSize: f.pageSize, languageIds: rq.languageIds, rows };
  });

  // Ordered ids for the same filter (used for prev/next navigation and "select all matching").
  app.get('/api/keys/ids', async (req) => {
    const scope = scopeOf(req);
    scope.require('view');
    const f = parse(keyFilterSchema, req.query);
    const rq = await resolveKeyQuery(db, scope, f);
    const rows = await db.query<{ id: number }>(`SELECT k.id FROM translation_keys k WHERE ${rq.where} ORDER BY ${rq.orderBy} LIMIT 20000`, rq.params);
    return rows.map((r) => r.id);
  });

  app.get('/api/keys/:id', async (req) => {
    const scope = scopeOf(req);
    scope.require('view');
    const { id } = parse(idParam, req.params);
    const { languageIds } = parse(z.object({ languageIds: csvInts }), req.query);
    await assertKeyInScope(db, scope, id);
    const langs = scope.resolveLanguages(languageIds, await allTargetLanguageIds(db));
    const rq = await resolveKeyQuery(db, scope, {
      ...parse(keyFilterSchema, {}),
      keyIds: [id],
      languageIds: langs,
      includeArchived: true,
    });
    const [row] = await loadKeyRows(db, scope, rq, 1, 0);
    if (!row) throw new HttpError(404, 'not_found', 'Key not found');
    const trIds = Object.values(row.translations).map((t) => t.id);
    const [history, reviews, sourceRevisions, alternates, conflicts, writablePlatforms] = await Promise.all([
      trIds.length
        ? db.query(
            `SELECT h.id, t.language_id AS "languageId", h.value, h.status, h.reason, h.created_at AS "createdAt", u.name AS "changedBy"
             FROM translation_history h JOIN translations t ON t.id=h.translation_id LEFT JOIN users u ON u.id=h.changed_by
             WHERE h.translation_id = ANY($1::int[]) ORDER BY h.created_at DESC, h.id DESC LIMIT 100`,
            [trIds],
          )
        : [],
      trIds.length
        ? db.query(
            `SELECT r.id, t.language_id AS "languageId", r.action, r.comment, r.created_at AS "createdAt", u.name AS reviewer
             FROM translation_reviews r JOIN translations t ON t.id=r.translation_id LEFT JOIN users u ON u.id=r.reviewer_id
             WHERE r.translation_id = ANY($1::int[]) ORDER BY r.created_at DESC LIMIT 50`,
            [trIds],
          )
        : [],
      scope.can('view_source')
        ? db.query(
            `SELECT r.id, r.source_text AS "sourceText", r.created_at AS "createdAt", u.name AS "changedBy"
             FROM source_revisions r LEFT JOIN users u ON u.id=r.changed_by WHERE r.key_id=$1 ORDER BY r.created_at DESC LIMIT 20`,
            [id],
          )
        : [],
      langs.length
        ? db.query(
            `SELECT lc.id, lc.sheet, lc.row_number AS "row", lc.header, lc.language_id AS "languageId", lc.role, lc.value
             FROM legacy_cells lc WHERE lc.key_id=$1 AND lc.language_id = ANY($2::int[]) AND lc.role IN ('alternate','duplicate_row')
             ORDER BY lc.sheet, lc.col_number`,
            [id, langs],
          )
        : [],
      db.query(
        `SELECT c.id, c.kind, c.language_id AS "languageId", c.sheet, c.row_number AS "row", c.header,
                c.current_value AS "currentValue", c.incoming_value AS "incomingValue", c.status
         FROM import_conflicts c WHERE c.key_id=$1 AND c.status='open' AND (c.language_id IS NULL OR c.language_id = ANY($2::int[]))
         ORDER BY c.id`,
        [id, langs],
      ),
      db.query<{ id: number }>(
        `SELECT p.id FROM key_platforms kp JOIN platforms p ON p.id=kp.platform_id WHERE kp.key_id=$1 AND NOT p.is_archived`,
        [id],
      ),
    ]);
    const editable = writablePlatforms.some((p) => scope.canSeePlatform(p.id));
    return {
      ...row,
      // Number of platforms outside the caller's scope that also use this key (names are not disclosed).
      hiddenPlatformCount: row.platformCount - row.platforms.length,
      editable,
      history,
      reviews,
      sourceRevisions,
      alternates,
      conflicts: conflicts.filter((c: any) => c.kind !== 'source_mismatch' || scope.can('view_source')),
    };
  });

  app.post('/api/keys', async (req) => {
    const scope = scopeOf(req);
    scope.require('manage_keys');
    const body = parse(
      z.object({
        namespace: namespaceSchema.optional(),
        identifier: identifierSchema,
        sourceText: z.string().max(10000).default(''),
        description: z.string().max(2000).default(''),
        maxLength: z.number().int().positive().max(100000).nullable().default(null),
        platformIds: z.array(z.number().int().positive()).min(1, 'Assign at least one platform'),
        segmentIds: z.array(z.number().int().positive()).default([]),
      }),
      req.body,
    );
    scope.resolvePlatforms(body.platformIds, await allPlatformIds(db, false));
    if (body.sourceText && !scope.can('edit_source')) throw new HttpError(403, 'forbidden', 'Missing permission: edit_source');
    if (body.segmentIds.length && !scope.can('manage_segments')) throw new HttpError(403, 'forbidden', 'Missing permission: manage_segments');
    return db.tx(async (q) => {
      await assertIdentifierFree(q, body.identifier, body.platformIds);
      const taken = async (ns: string) => !!(await q.one('SELECT 1 FROM translation_keys WHERE namespace=$1 AND identifier=$2', [ns, body.identifier]));
      let namespace = body.namespace;
      if (namespace) {
        if (await taken(namespace)) throw new HttpError(409, 'key_exists', `Key "${body.identifier}" already exists in namespace "${namespace}"`);
      } else {
        // The UI no longer asks for a namespace: use "shared", or the first platform's slug when another key
        // with this name already lives in "shared" (same rule as splitting a key per platform).
        namespace = 'shared';
        if (await taken(namespace)) {
          const plat = await q.one<{ slug: string }>('SELECT slug FROM platforms WHERE id=$1', [body.platformIds[0]]);
          namespace = plat!.slug;
          for (let n = 2; await taken(namespace); n++) namespace = `${plat!.slug}-${n}`;
        }
      }
      const row = await q.one<{ id: number }>(
        `INSERT INTO translation_keys (namespace, identifier, source_text, description, max_length, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
        [namespace, body.identifier, body.sourceText, body.description, body.maxLength, scope.userId],
      );
      const id = row!.id;
      for (const pid of body.platformIds) {
        await q.query(
          `INSERT INTO key_platforms (key_id, platform_id, identifier, position)
           VALUES ($1,$2,$3, COALESCE((SELECT max(position)+1 FROM key_platforms WHERE platform_id=$2), 0))`,
          [id, pid, body.identifier],
        );
      }
      if (body.segmentIds.length) {
        await q.query('INSERT INTO key_segments (key_id, segment_id) SELECT $1, id FROM segments WHERE id = ANY($2::int[])', [id, body.segmentIds]);
      }
      if (body.sourceText) await q.query('INSERT INTO source_revisions (key_id, source_text, changed_by) VALUES ($1,$2,$3)', [id, body.sourceText, scope.userId]);
      await audit(q, scope.userId, { action: 'key.created', resourceType: 'key', resourceId: id, platformIds: body.platformIds, after: { ...body, namespace } }, req.ip);
      return { id };
    });
  });

  app.patch('/api/keys/:id', async (req) => {
    const scope = scopeOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        expectedVersion: z.number().int().positive(),
        identifier: identifierSchema.optional(),
        sourceText: z.string().max(10000).optional(),
        description: z.string().max(2000).optional(),
        maxLength: z.number().int().positive().max(100000).nullable().optional(),
        isArchived: z.boolean().optional(),
      }),
      req.body,
    );
    if (body.sourceText !== undefined) scope.require('edit_source');
    if (body.identifier !== undefined || body.description !== undefined || body.maxLength !== undefined || body.isArchived !== undefined) {
      scope.require('manage_keys');
    }
    await assertKeyInScope(db, scope, id, true);
    return db.tx(async (q) => {
      const before = await q.one('SELECT identifier, source_text, description, max_length, is_archived, version FROM translation_keys WHERE id=$1 FOR UPDATE', [id]);
      if (!before) throw new HttpError(404, 'not_found', 'Key not found');
      if (before.version !== body.expectedVersion) {
        throw new HttpError(409, 'version_conflict', 'This key was changed by someone else. Reload to see the latest version.', { current: before });
      }
      const pids = await keyPlatformIds(q, id);
      if (body.identifier !== undefined && body.identifier !== before.identifier) {
        if (!scope.allPlatforms && !scope.isSuperAdmin && pids.some((p) => !scope.canSeePlatform(p))) {
          throw new HttpError(403, 'forbidden', 'Renaming a key shared with platforms outside your scope is not allowed');
        }
        await assertIdentifierFree(q, body.identifier, pids, id);
        await q.query('UPDATE key_platforms SET identifier=$2 WHERE key_id=$1', [id, body.identifier]);
      }
      await q.query(
        `UPDATE translation_keys SET identifier=COALESCE($2,identifier), source_text=COALESCE($3,source_text), description=COALESCE($4,description),
           max_length=CASE WHEN $5::boolean THEN $6 ELSE max_length END, is_archived=COALESCE($7,is_archived),
           version=version+1, updated_at=now(), updated_by=$8 WHERE id=$1`,
        [
          id,
          body.identifier ?? null,
          body.sourceText ?? null,
          body.description ?? null,
          body.maxLength !== undefined,
          body.maxLength ?? null,
          body.isArchived ?? null,
          scope.userId,
        ],
      );
      if (body.sourceText !== undefined && body.sourceText !== before.source_text) {
        await q.query('INSERT INTO source_revisions (key_id, source_text, changed_by) VALUES ($1,$2,$3)', [id, body.sourceText, scope.userId]);
        // Finished translations now refer to an outdated source: send them back for attention.
        const affected = await q.query<{ id: number; value: string }>(
          `UPDATE translations SET status='in_progress', source_changed=true, version=version+1, updated_at=now()
           WHERE key_id=$1 AND status IN ('approved','needs_review') RETURNING id, value`,
          [id],
        );
        for (const t of affected) {
          await q.query(`INSERT INTO translation_history (translation_id, value, status, changed_by, reason) VALUES ($1,$2,'in_progress',$3,'source_change')`, [
            t.id,
            t.value,
            scope.userId,
          ]);
        }
        await audit(q, scope.userId, {
          action: 'key.source_changed',
          resourceType: 'key',
          resourceId: id,
          platformIds: pids,
          before: before.source_text,
          after: body.sourceText,
        }, req.ip);
      }
      const meta = { identifier: body.identifier, description: body.description, maxLength: body.maxLength, isArchived: body.isArchived };
      if (Object.values(meta).some((v) => v !== undefined)) {
        await audit(q, scope.userId, {
          action: body.isArchived !== undefined ? (body.isArchived ? 'key.archived' : 'key.restored') : 'key.updated',
          resourceType: 'key',
          resourceId: id,
          platformIds: pids,
          before: { identifier: before.identifier, description: before.description, maxLength: before.max_length, isArchived: before.is_archived },
          after: meta,
        }, req.ip);
      }
      return { ok: true, version: before.version + 1 };
    });
  });

  app.put('/api/keys/:id/segments', async (req) => {
    const scope = scopeOf(req);
    scope.require('manage_segments');
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({ segmentIds: z.array(z.number().int().positive()).max(200), createNames: z.array(z.string().trim().min(1).max(120)).max(20).default([]) }),
      req.body,
    );
    await assertKeyInScope(db, scope, id, true);
    return db.tx(async (q) => {
      const ids = [...body.segmentIds];
      for (const name of body.createNames) {
        const norm = normalizeLabel(name);
        const row = await q.one<{ id: number }>(
          `INSERT INTO segments (name, name_norm) VALUES ($1,$2) ON CONFLICT (name_norm) DO UPDATE SET name_norm=EXCLUDED.name_norm RETURNING id`,
          [name, norm],
        );
        ids.push(row!.id);
      }
      await setKeySegments(q, scope, id, [...new Set(ids)], req.ip);
      return { ok: true };
    });
  });

  /**
   * Shares the key with the given platforms. Only platforms inside the caller's scope can be
   * added or removed; memberships outside the scope are left exactly as they are.
   */
  app.put('/api/keys/:id/platforms', async (req) => {
    const scope = scopeOf(req);
    scope.require('manage_keys');
    const { id } = parse(idParam, req.params);
    const { platformIds } = parse(z.object({ platformIds: z.array(z.number().int().positive()).max(200) }), req.body);
    await assertKeyInScope(db, scope, id, true);
    scope.resolvePlatforms(platformIds, await allPlatformIds(db, true));
    return db.tx(async (q) => {
      const key = await q.one<{ identifier: string }>('SELECT identifier FROM translation_keys WHERE id=$1', [id]);
      const current = await keyPlatformIds(q, id);
      const managed = current.filter((p) => scope.canSeePlatform(p));
      const outside = current.filter((p) => !scope.canSeePlatform(p));
      const next = [...new Set([...outside, ...platformIds])];
      if (!next.length) throw new HttpError(400, 'no_platform', 'A key must belong to at least one platform. Archive it instead.');
      const add = platformIds.filter((p) => !current.includes(p));
      const remove = managed.filter((p) => !platformIds.includes(p));
      await assertIdentifierFree(q, key!.identifier, add, id);
      for (const pid of add) {
        await q.query(
          `INSERT INTO key_platforms (key_id, platform_id, identifier, position)
           VALUES ($1,$2,$3, COALESCE((SELECT max(position)+1 FROM key_platforms WHERE platform_id=$2), 0))`,
          [id, pid, key!.identifier],
        );
      }
      if (remove.length) await q.query('DELETE FROM key_platforms WHERE key_id=$1 AND platform_id = ANY($2::int[])', [id, remove]);
      await q.query('UPDATE translation_keys SET updated_at=now(), updated_by=$2 WHERE id=$1', [id, scope.userId]);
      const names = await platformNames(q, [...current, ...add]);
      await audit(q, scope.userId, {
        action: 'key.platforms_changed',
        resourceType: 'key',
        resourceId: id,
        platformIds: [...new Set([...current, ...add])],
        before: managed.map((p) => names.get(p)),
        after: platformIds.map((p) => names.get(p)),
      }, req.ip);
      return { ok: true, added: add.length, removed: remove.length };
    });
  });

  /**
   * Turns one platform's use of a shared key into a separate, platform-specific key:
   * the platform is detached from the shared key and gets its own copy (source + translations)
   * in the platform's namespace, which can then diverge independently.
   */
  app.post('/api/keys/:id/split', async (req) => {
    const scope = scopeOf(req);
    scope.require('manage_keys');
    const { id } = parse(idParam, req.params);
    const { platformId } = parse(z.object({ platformId: z.number().int().positive() }), req.body);
    if (!scope.canSeePlatform(platformId)) throw new HttpError(403, 'platform_forbidden', 'Platform outside your scope');
    await assertKeyInScope(db, scope, id, true);
    return db.tx(async (q) => {
      const key = await q.one('SELECT * FROM translation_keys WHERE id=$1', [id]);
      const current = await keyPlatformIds(q, id);
      if (!current.includes(platformId)) throw new HttpError(400, 'not_member', 'The key is not used by this platform');
      if (current.length < 2) throw new HttpError(400, 'not_shared', 'The key is used by only one platform; it is already platform-specific');
      const plat = await q.one<{ slug: string }>('SELECT slug FROM platforms WHERE id=$1', [platformId]);
      let ns = plat!.slug;
      for (let n = 2; await q.one('SELECT 1 FROM translation_keys WHERE namespace=$1 AND identifier=$2', [ns, key.identifier]); n++) ns = `${plat!.slug}-${n}`;
      const kp = await q.one('SELECT position, legacy_meta FROM key_platforms WHERE key_id=$1 AND platform_id=$2', [id, platformId]);
      const copy = await q.one<{ id: number }>(
        `INSERT INTO translation_keys (namespace, identifier, source_text, description, max_length, legacy, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
        [ns, key.identifier, key.source_text, key.description, key.max_length, JSON.stringify({ ...key.legacy, splitFrom: id }), scope.userId],
      );
      await q.query('DELETE FROM key_platforms WHERE key_id=$1 AND platform_id=$2', [id, platformId]);
      await q.query('INSERT INTO key_platforms (key_id, platform_id, identifier, position, legacy_meta) VALUES ($1,$2,$3,$4,$5)', [
        copy!.id,
        platformId,
        key.identifier,
        kp.position,
        kp.legacy_meta,
      ]);
      await q.query('INSERT INTO key_segments (key_id, segment_id) SELECT $1, segment_id FROM key_segments WHERE key_id=$2', [copy!.id, id]);
      await q.query(
        `INSERT INTO translations (key_id, language_id, value, status, created_by, updated_by, approved_by, approved_at)
         SELECT $1, language_id, value, status, created_by, updated_by, approved_by, approved_at FROM translations WHERE key_id=$2`,
        [copy!.id, id],
      );
      await audit(q, scope.userId, {
        action: 'key.split',
        resourceType: 'key',
        resourceId: id,
        platformIds: current,
        after: { newKeyId: copy!.id, namespace: ns, platformId },
      }, req.ip);
      return { id: copy!.id, namespace: ns };
    });
  });

  app.post('/api/keys/bulk', async (req) => {
    const scope = scopeOf(req);
    const body = parse(
      z.object({
        keyIds: z.array(z.number().int().positive()).min(1).max(5000),
        addSegmentIds: z.array(z.number().int().positive()).max(50).default([]),
        removeSegmentIds: z.array(z.number().int().positive()).max(50).default([]),
        addPlatformIds: z.array(z.number().int().positive()).max(50).default([]),
        archive: z.boolean().optional(),
      }),
      req.body,
    );
    if (body.addSegmentIds.length || body.removeSegmentIds.length) scope.require('manage_segments');
    if (body.addPlatformIds.length || body.archive !== undefined) scope.require('manage_keys');
    if (body.addPlatformIds.length) scope.resolvePlatforms(body.addPlatformIds, await allPlatformIds(db, false));
    return db.tx(async (q) => {
      for (const id of body.keyIds) await assertKeyInScope(q, scope, id, true); // all-or-nothing
      for (const id of body.keyIds) {
        if (body.addSegmentIds.length || body.removeSegmentIds.length) {
          const cur = (await q.query<{ segment_id: number }>('SELECT segment_id FROM key_segments WHERE key_id=$1', [id])).map((r) => r.segment_id);
          const next = [...new Set([...cur.filter((s) => !body.removeSegmentIds.includes(s)), ...body.addSegmentIds])];
          await setKeySegments(q, scope, id, next, req.ip);
        }
        if (body.addPlatformIds.length) {
          const key = await q.one<{ identifier: string }>('SELECT identifier FROM translation_keys WHERE id=$1', [id]);
          const cur = await keyPlatformIds(q, id);
          const add = body.addPlatformIds.filter((p) => !cur.includes(p));
          await assertIdentifierFree(q, key!.identifier, add, id);
          for (const pid of add) {
            await q.query(
              `INSERT INTO key_platforms (key_id, platform_id, identifier, position)
               VALUES ($1,$2,$3, COALESCE((SELECT max(position)+1 FROM key_platforms WHERE platform_id=$2), 0))`,
              [id, pid, key!.identifier],
            );
          }
          if (add.length) await audit(q, scope.userId, { action: 'key.platforms_changed', resourceType: 'key', resourceId: id, platformIds: [...cur, ...add], after: { added: add } }, req.ip);
        }
        if (body.archive !== undefined) {
          await q.query('UPDATE translation_keys SET is_archived=$2, version=version+1, updated_at=now(), updated_by=$3 WHERE id=$1', [id, body.archive, scope.userId]);
          await audit(q, scope.userId, { action: body.archive ? 'key.archived' : 'key.restored', resourceType: 'key', resourceId: id, platformIds: await keyPlatformIds(q, id) }, req.ip);
        }
      }
      return { ok: true, count: body.keyIds.length };
    });
  });
}
