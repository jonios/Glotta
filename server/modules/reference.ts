import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { normalizeLabel } from '../catalog.js';
import { audit, HttpError, idParam, parse, scopeOf } from '../http.js';
import { DEFAULT_SETTINGS } from '../bootstrap.js';

const localeCode = z.string().trim().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use a BCP-47 code such as it, pt-BR or zh-Hant');

export function referenceRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  // ---------------------------------------------------------------- languages
  app.get('/api/languages', async (req) => {
    const scope = scopeOf(req);
    const { includeArchived } = parse(z.object({ includeArchived: z.coerce.boolean().optional() }), req.query);
    const params: unknown[] = [];
    const lf = scope.languageFilter();
    let where = includeArchived && scope.can('manage_languages') ? 'TRUE' : 'l.is_active';
    if (lf !== null) {
      params.push(lf);
      where += ` AND (l.id = ANY($${params.length}::int[])${scope.can('view_source') ? ' OR l.is_source' : ''})`;
    }
    // Completion statistics restricted to keys on platforms the user can see.
    const pf = scope.platformFilter();
    let keyCond = 'k.is_archived = false AND EXISTS (SELECT 1 FROM key_platforms kp JOIN platforms p ON p.id=kp.platform_id WHERE kp.key_id=k.id AND NOT p.is_archived';
    if (pf !== null) {
      params.push(pf);
      keyCond += ` AND kp.platform_id = ANY($${params.length}::int[])`;
    }
    keyCond += ')';
    const rows = await db.query(
      `WITH vk AS (SELECT k.id FROM translation_keys k WHERE ${keyCond})
       SELECT l.id, l.code, l.name, l.native_name AS "nativeName", l.direction, l.is_source AS "isSource",
              l.is_active AS "isActive", l.sort_order AS "sortOrder",
              (SELECT count(*)::int FROM vk) AS "totalKeys",
              (SELECT count(*)::int FROM translations t JOIN vk ON vk.id=t.key_id WHERE t.language_id=l.id AND t.status<>'missing') AS translated,
              (SELECT count(*)::int FROM translations t JOIN vk ON vk.id=t.key_id WHERE t.language_id=l.id AND t.status='approved') AS approved,
              (SELECT count(*)::int FROM translations t JOIN vk ON vk.id=t.key_id WHERE t.language_id=l.id AND t.status='needs_review') AS "needsReview",
              COALESCE((SELECT json_agg(json_build_object('alias', a.alias, 'kind', a.kind) ORDER BY a.alias)
                        FROM language_aliases a WHERE a.language_id=l.id), '[]') AS aliases,
              COALESCE((SELECT max(a.note) FROM language_aliases a WHERE a.language_id=l.id AND a.note<>''), '') AS note
       FROM languages l WHERE ${where}
       ORDER BY l.is_source DESC, l.sort_order, l.name`,
      params,
    );
    return rows;
  });

  const languageBody = z.object({
    code: localeCode,
    name: z.string().trim().min(1).max(100),
    nativeName: z.string().trim().max(100).default(''),
    direction: z.enum(['ltr', 'rtl']).default('ltr'),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(10000).default(100),
    aliases: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  });

  async function setAliases(q: typeof db, languageId: number, code: string, aliases: string[]) {
    const wanted = new Set([code, ...aliases].map(normalizeLabel));
    for (const a of wanted) {
      const owner = await q.one<{ language_id: number }>('SELECT language_id FROM language_aliases WHERE alias=$1', [a]);
      if (owner && owner.language_id !== languageId) {
        throw new HttpError(409, 'alias_taken', `Alias "${a}" already belongs to another language`);
      }
    }
    await q.query('DELETE FROM language_aliases WHERE language_id=$1 AND NOT (alias = ANY($2::text[]))', [languageId, [...wanted]]);
    for (const a of wanted) {
      await q.query(
        `INSERT INTO language_aliases (alias, language_id, kind) VALUES ($1,$2,$3) ON CONFLICT (alias) DO NOTHING`,
        [a, languageId, /^[a-z]{2,3}(-[a-z0-9]+)*$/.test(a) && a.length <= 8 ? 'code' : 'label'],
      );
    }
  }

  app.post('/api/languages', async (req) => {
    const scope = scopeOf(req);
    scope.require('manage_languages');
    const body = parse(languageBody, req.body);
    return db.tx(async (q) => {
      const row = await q.one<{ id: number }>(
        `INSERT INTO languages (code, name, native_name, direction, is_active, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [body.code, body.name, body.nativeName, body.direction, body.isActive, body.sortOrder],
      );
      await setAliases(q as any, row!.id, body.code, body.aliases);
      await audit(q, scope.userId, { action: 'language.created', resourceType: 'language', resourceId: row!.id, after: body }, req.ip);
      return { id: row!.id };
    });
  });

  app.patch('/api/languages/:id', async (req) => {
    const scope = scopeOf(req);
    scope.require('manage_languages');
    const { id } = parse(idParam, req.params);
    const body = parse(languageBody.partial().omit({ code: true }), req.body);
    return db.tx(async (q) => {
      const before = await q.one('SELECT code, name, native_name, direction, is_active, is_source, sort_order FROM languages WHERE id=$1', [id]);
      if (!before) throw new HttpError(404, 'not_found', 'Language not found');
      if (before.is_source && body.isActive === false) throw new HttpError(400, 'source_language', 'The source language cannot be archived');
      await q.query(
        `UPDATE languages SET name=COALESCE($2,name), native_name=COALESCE($3,native_name), direction=COALESCE($4,direction),
           is_active=COALESCE($5,is_active), sort_order=COALESCE($6,sort_order), updated_at=now() WHERE id=$1`,
        [id, body.name ?? null, body.nativeName ?? null, body.direction ?? null, body.isActive ?? null, body.sortOrder ?? null],
      );
      if (body.aliases) await setAliases(q as any, id, before.code, body.aliases);
      await audit(q, scope.userId, { action: 'language.updated', resourceType: 'language', resourceId: id, languageId: id, before, after: body }, req.ip);
      return { ok: true };
    });
  });

  // ---------------------------------------------------------------- platforms
  app.get('/api/platforms', async (req) => {
    const scope = scopeOf(req);
    const { includeArchived } = parse(z.object({ includeArchived: z.coerce.boolean().optional() }), req.query);
    const params: unknown[] = [];
    let where = includeArchived ? 'TRUE' : 'NOT p.is_archived';
    const pf = scope.platformFilter();
    if (pf !== null) {
      params.push(pf);
      where += ` AND p.id = ANY($${params.length}::int[])`;
    }
    const lf = scope.languageFilter();
    let langCond = 'l.is_active AND NOT l.is_source';
    if (lf !== null) {
      params.push(lf);
      langCond += ` AND l.id = ANY($${params.length}::int[])`;
    }
    return db.query(
      `WITH langs AS (SELECT l.id FROM languages l WHERE ${langCond})
       SELECT p.id, p.slug, p.name, p.description, p.kind, p.is_archived AS "isArchived", p.sort_order AS "sortOrder",
              (SELECT count(*)::int FROM key_platforms kp JOIN translation_keys k ON k.id=kp.key_id
                 WHERE kp.platform_id=p.id AND NOT k.is_archived) AS "keyCount",
              (SELECT count(*)::int FROM langs) AS "languageCount",
              (SELECT count(*)::int FROM key_platforms kp JOIN translation_keys k ON k.id=kp.key_id AND NOT k.is_archived
                 JOIN translations t ON t.key_id=k.id JOIN langs ON langs.id=t.language_id
                 WHERE kp.platform_id=p.id AND t.status<>'missing') AS translated,
              (SELECT count(*)::int FROM key_platforms kp JOIN translation_keys k ON k.id=kp.key_id AND NOT k.is_archived
                 JOIN translations t ON t.key_id=k.id JOIN langs ON langs.id=t.language_id
                 WHERE kp.platform_id=p.id AND t.status='approved') AS approved,
              EXISTS (SELECT 1 FROM legacy_sheet_layouts s WHERE s.platform_id=p.id) AS "hasLegacyLayout"
       FROM platforms p WHERE ${where}
       ORDER BY p.is_archived, p.sort_order, p.name`,
      params,
    );
  });

  const platformBody = z.object({
    name: z.string().trim().min(1).max(100),
    slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/, 'Lower-case letters, digits and dashes').max(60),
    description: z.string().max(1000).default(''),
    kind: z.enum(['ios', 'android', 'web', 'document', 'other']).default('other'),
    isArchived: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(10000).default(100),
  });

  app.post('/api/platforms', async (req) => {
    const scope = scopeOf(req);
    scope.require('manage_platforms');
    const body = parse(platformBody, req.body);
    const row = await db.one<{ id: number }>(
      `INSERT INTO platforms (name, slug, description, kind, is_archived, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [body.name, body.slug, body.description, body.kind, body.isArchived, body.sortOrder],
    );
    await audit(db, scope.userId, { action: 'platform.created', resourceType: 'platform', resourceId: row!.id, platformIds: [row!.id], after: body }, req.ip);
    return { id: row!.id };
  });

  app.patch('/api/platforms/:id', async (req) => {
    const scope = scopeOf(req);
    scope.require('manage_platforms');
    const { id } = parse(idParam, req.params);
    if (!scope.canSeePlatform(id)) throw new HttpError(404, 'not_found', 'Platform not found');
    const body = parse(platformBody.partial(), req.body);
    const before = await db.one('SELECT name, slug, description, kind, is_archived, sort_order FROM platforms WHERE id=$1', [id]);
    if (!before) throw new HttpError(404, 'not_found', 'Platform not found');
    await db.query(
      `UPDATE platforms SET name=COALESCE($2,name), slug=COALESCE($3,slug), description=COALESCE($4,description), kind=COALESCE($5,kind),
         is_archived=COALESCE($6,is_archived), sort_order=COALESCE($7,sort_order), updated_at=now() WHERE id=$1`,
      [id, body.name ?? null, body.slug ?? null, body.description ?? null, body.kind ?? null, body.isArchived ?? null, body.sortOrder ?? null],
    );
    await audit(db, scope.userId, { action: 'platform.updated', resourceType: 'platform', resourceId: id, platformIds: [id], before, after: body }, req.ip);
    return { ok: true };
  });

  // ---------------------------------------------------------------- segments
  app.get('/api/segments', async (req) => {
    const scope = scopeOf(req);
    const { search } = parse(z.object({ search: z.string().max(100).optional() }), req.query);
    const params: unknown[] = [];
    const pf = scope.platformFilter();
    let vis = 'TRUE';
    if (pf !== null) {
      params.push(pf);
      vis = `EXISTS (SELECT 1 FROM key_platforms kp WHERE kp.key_id=ks.key_id AND kp.platform_id = ANY($${params.length}::int[]))`;
    }
    let where = 'TRUE';
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where = `s.name_norm LIKE $${params.length}`;
    }
    return db.query(
      `SELECT s.id, s.name, s.description, s.created_at AS "createdAt",
              (SELECT count(*)::int FROM key_segments ks WHERE ks.segment_id=s.id AND ${vis}) AS "keyCount"
       FROM segments s WHERE ${where} ORDER BY s.name_norm LIMIT 1000`,
      params,
    );
  });

  const segmentBody = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(500).default('') });

  app.post('/api/segments', async (req) => {
    const scope = scopeOf(req);
    scope.require('manage_segments');
    const body = parse(segmentBody, req.body);
    const norm = normalizeLabel(body.name);
    const existing = await db.one<{ id: number }>('SELECT id FROM segments WHERE name_norm=$1', [norm]);
    if (existing) throw new HttpError(409, 'segment_exists', `Segment "${body.name}" already exists`);
    const row = await db.one<{ id: number }>('INSERT INTO segments (name, name_norm, description) VALUES ($1,$2,$3) RETURNING id', [
      body.name,
      norm,
      body.description,
    ]);
    await audit(db, scope.userId, { action: 'segment.created', resourceType: 'segment', resourceId: row!.id, after: body }, req.ip);
    return { id: row!.id, name: body.name };
  });

  app.patch('/api/segments/:id', async (req) => {
    const scope = scopeOf(req);
    scope.require('manage_segments');
    const { id } = parse(idParam, req.params);
    const body = parse(segmentBody.partial(), req.body);
    const before = await db.one('SELECT name, description FROM segments WHERE id=$1', [id]);
    if (!before) throw new HttpError(404, 'not_found', 'Segment not found');
    await db.query('UPDATE segments SET name=COALESCE($2,name), name_norm=COALESCE($3,name_norm), description=COALESCE($4,description) WHERE id=$1', [
      id,
      body.name ?? null,
      body.name ? normalizeLabel(body.name) : null,
      body.description ?? null,
    ]);
    await audit(db, scope.userId, { action: 'segment.updated', resourceType: 'segment', resourceId: id, before, after: body }, req.ip);
    return { ok: true };
  });

  app.delete('/api/segments/:id', async (req) => {
    const scope = scopeOf(req);
    scope.require('manage_segments');
    if (!scope.isSuperAdmin && !scope.allPlatforms) {
      // Deleting removes assignments on keys the user may not be able to see.
      throw new HttpError(403, 'forbidden', 'Deleting a segment requires access to all platforms');
    }
    const { id } = parse(idParam, req.params);
    const before = await db.one('SELECT name FROM segments WHERE id=$1', [id]);
    if (!before) throw new HttpError(404, 'not_found', 'Segment not found');
    await db.query('DELETE FROM segments WHERE id=$1', [id]);
    await audit(db, scope.userId, { action: 'segment.deleted', resourceType: 'segment', resourceId: id, before }, req.ip);
    return { ok: true };
  });

  // ---------------------------------------------------------------- settings
  app.get('/api/settings', async (req) => {
    scopeOf(req);
    const rows = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) out[r.key] = r.value;
    return out;
  });

  app.put('/api/settings', async (req) => {
    const scope = scopeOf(req);
    scope.require('manage_settings');
    const body = parse(
      z.object({
        placeholder_rules: z
          .array(z.object({ id: z.string().min(1).max(40), label: z.string().max(80), pattern: z.string().min(1).max(300), enabled: z.boolean() }))
          .max(30)
          .optional(),
        translator_guidelines: z.string().max(20000).optional(),
        default_import_status: z.enum(['approved', 'needs_review', 'draft']).optional(),
        organization_name: z.string().max(100).optional(),
      }),
      req.body,
    );
    for (const r of body.placeholder_rules ?? []) {
      try {
        new RegExp(r.pattern, 'g');
      } catch {
        throw new HttpError(400, 'invalid_pattern', `Rule "${r.label}" is not a valid regular expression`);
      }
    }
    await db.tx(async (q) => {
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        await q.query(
          'INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()',
          [k, JSON.stringify(v)],
        );
      }
      await audit(q, scope.userId, { action: 'settings.updated', resourceType: 'settings', after: Object.keys(body) }, req.ip);
    });
    return { ok: true };
  });
}
