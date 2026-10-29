import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app.js';
import { scopeOf } from '../http.js';
import { allPlatformIds, allTargetLanguageIds } from './key-query.js';
import { auditVisibility } from './audit.js';

/** All figures are computed from the database and restricted to the caller's scope. */
export function dashboardRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/dashboard', async (req) => {
    const scope = scopeOf(req);
    scope.require('view');
    const platforms = scope.resolvePlatforms(undefined, await allPlatformIds(db, false));
    const languages = scope.resolveLanguages(undefined, await allTargetLanguageIds(db));

    const vk = `SELECT DISTINCT k.id FROM translation_keys k JOIN key_platforms kp ON kp.key_id=k.id
                WHERE NOT k.is_archived AND kp.platform_id = ANY($1::int[])`;
    const totals = await db.one(
      `WITH vk AS (${vk})
       SELECT (SELECT count(*)::int FROM vk) AS keys,
              count(*) FILTER (WHERE t.status<>'missing')::int AS translated,
              count(*) FILTER (WHERE t.status='approved')::int AS approved,
              count(*) FILTER (WHERE t.status='needs_review')::int AS "needsReview",
              count(*) FILTER (WHERE t.status='in_progress')::int AS "inProgress",
              count(*) FILTER (WHERE t.status='draft')::int AS draft,
              count(*) FILTER (WHERE t.updated_at > now() - interval '7 days' AND t.updated_by IS NOT NULL)::int AS "updatedThisWeek"
       FROM vk JOIN translations t ON t.key_id=vk.id AND t.language_id = ANY($2::int[])`,
      [platforms, languages],
    );
    const slots = (totals?.keys ?? 0) * languages.length;

    const byLanguage = await db.query(
      `WITH vk AS (${vk})
       SELECT l.id, l.code, l.name, l.direction,
              count(t.id) FILTER (WHERE t.status<>'missing')::int AS translated,
              count(t.id) FILTER (WHERE t.status='approved')::int AS approved,
              count(t.id) FILTER (WHERE t.status='needs_review')::int AS "needsReview"
       FROM languages l CROSS JOIN vk LEFT JOIN translations t ON t.key_id=vk.id AND t.language_id=l.id
       WHERE l.id = ANY($2::int[]) GROUP BY l.id ORDER BY l.sort_order`,
      [platforms, languages],
    );

    const byPlatform = await db.query(
      `SELECT p.id, p.name, p.slug,
              count(DISTINCT k.id)::int AS keys,
              count(t.id) FILTER (WHERE t.status<>'missing')::int AS translated,
              count(t.id) FILTER (WHERE t.status='approved')::int AS approved
       FROM platforms p JOIN key_platforms kp ON kp.platform_id=p.id JOIN translation_keys k ON k.id=kp.key_id AND NOT k.is_archived
       LEFT JOIN translations t ON t.key_id=k.id AND t.language_id = ANY($2::int[])
       WHERE p.id = ANY($1::int[]) GROUP BY p.id ORDER BY p.sort_order`,
      [platforms, languages],
    );

    const recent = await db.query(
      `SELECT t.id, t.key_id AS "keyId", k.identifier, l.code AS "languageCode", l.id AS "languageId", t.value, t.status,
              t.updated_at AS "updatedAt", u.name AS "updatedBy"
       FROM translations t JOIN translation_keys k ON k.id=t.key_id JOIN languages l ON l.id=t.language_id
       LEFT JOIN users u ON u.id=t.updated_by
       WHERE t.language_id = ANY($2::int[]) AND t.updated_by IS NOT NULL
         AND EXISTS (SELECT 1 FROM key_platforms kp WHERE kp.key_id=k.id AND kp.platform_id = ANY($1::int[]))
       ORDER BY t.updated_at DESC LIMIT 8`,
      [platforms, languages],
    );

    const conflicts = await db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM import_conflicts c WHERE c.status='open'
       AND (c.language_id = ANY($2::int[]) ${scope.can('view_source') ? 'OR c.language_id IS NULL' : ''})
       AND EXISTS (SELECT 1 FROM key_platforms kp WHERE kp.key_id=c.key_id AND kp.platform_id = ANY($1::int[]))`,
      [platforms, languages],
    );

    const jobsVisible = scope.can('import') || scope.can('export');
    const jobs = jobsVisible
      ? await db.query(
          `(SELECT 'import' AS type, j.id, j.file_name AS "fileName", j.status, j.created_at AS "createdAt", u.name AS "createdBy"
            FROM import_jobs j LEFT JOIN users u ON u.id=j.created_by
            WHERE ($1::boolean OR j.created_by=$2) AND j.status <> 'analyzed' ORDER BY j.created_at DESC LIMIT 5)
           UNION ALL
           (SELECT 'export' AS type, j.id, j.file_name, j.format AS status, j.created_at, u.name
            FROM export_jobs j LEFT JOIN users u ON u.id=j.created_by
            WHERE ($1::boolean OR j.created_by=$2) ORDER BY j.created_at DESC LIMIT 5)
           ORDER BY "createdAt" DESC LIMIT 6`,
          [scope.isSuperAdmin || scope.can('import'), scope.userId],
        )
      : [];

    const vis = auditVisibility(scope, []);
    const activity = await db.query(
      `SELECT a.id, a.action, a.resource_type AS "resourceType", a.resource_id AS "resourceId", a.created_at AS "createdAt",
              u.name AS actor, l.code AS "languageCode"
       FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN languages l ON l.id=a.language_id
       WHERE ${vis.where} AND a.action NOT LIKE 'auth.%' ORDER BY a.created_at DESC LIMIT 8`,
      vis.params,
    );

    const needsAttention = [...byLanguage]
      .map((l: any) => ({ ...l, pct: totals?.keys ? l.translated / totals.keys : 0 }))
      .sort((a, b) => a.pct - b.pct || b.needsReview - a.needsReview)
      .slice(0, 5);

    return {
      totals: {
        keys: totals?.keys ?? 0,
        languages: languages.length,
        platforms: platforms.length,
        slots,
        translated: totals?.translated ?? 0,
        approved: totals?.approved ?? 0,
        missing: Math.max(0, slots - (totals?.translated ?? 0)),
        needsReview: totals?.needsReview ?? 0,
        inProgress: totals?.inProgress ?? 0,
        draft: totals?.draft ?? 0,
        updatedThisWeek: totals?.updatedThisWeek ?? 0,
        openConflicts: conflicts?.n ?? 0,
      },
      byLanguage,
      byPlatform,
      recent,
      needsAttention,
      jobs,
      activity,
    };
  });
}
