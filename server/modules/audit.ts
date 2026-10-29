import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import type { Scope } from '../authz/scope.js';
import { parse, scopeOf } from '../http.js';

/**
 * Audit visibility:
 *  - Super Admin: everything.
 *  - `view_audit`: entries touching only platforms/languages in scope; user/settings/auth
 *    entries additionally require `manage_users`.
 *  - everyone else: their own actions.
 */
export function auditVisibility(scope: Scope, params: unknown[]): { where: string; params: unknown[] } {
  if (scope.isSuperAdmin) return { where: 'TRUE', params };
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  if (!scope.can('view_audit')) return { where: `a.actor_id = ${p(scope.userId)}`, params };
  const conds: string[] = [];
  const lf = scope.languageFilter();
  if (lf !== null) conds.push(`(a.language_id IS NULL OR a.language_id = ANY(${p(lf)}::int[]))`);
  const pf = scope.platformFilter();
  if (pf !== null) conds.push(`(a.platform_ids = '{}' OR a.platform_ids && ${p(pf)}::int[])`);
  if (!scope.can('manage_users')) conds.push(`a.resource_type NOT IN ('user','settings') AND a.action NOT LIKE 'auth.%'`);
  return { where: `(a.actor_id = ${p(scope.userId)} OR (${conds.length ? conds.join(' AND ') : 'TRUE'}))`, params };
}

export function auditRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/audit', async (req) => {
    const scope = scopeOf(req);
    const f = parse(
      z.object({
        action: z.string().max(60).optional(),
        resourceType: z.string().max(40).optional(),
        actorId: z.coerce.number().int().positive().optional(),
        search: z.string().max(100).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const vis = auditVisibility(scope, []);
    const params = vis.params;
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    const conds = [vis.where];
    if (f.action) conds.push(`a.action LIKE ${p(f.action.replace(/[%_\\]/g, '') + '%')}`);
    if (f.resourceType) conds.push(`a.resource_type = ${p(f.resourceType)}`);
    if (f.actorId) conds.push(`a.actor_id = ${p(f.actorId)}`);
    if (f.search) conds.push(`(a.resource_id = ${p(f.search)} OR a.after::text ILIKE ${p('%' + f.search.replace(/[%_\\]/g, '') + '%')})`);
    const where = conds.join(' AND ');
    const whereParams = [...params];
    const [total, rows] = await Promise.all([
      ctx.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs a WHERE ${where}`, whereParams),
      ctx.db.query(
        `SELECT a.id, a.action, a.resource_type AS "resourceType", a.resource_id AS "resourceId", a.before, a.after, a.job_ref AS "jobRef",
                a.created_at AS "createdAt", u.name AS actor, u.email AS "actorEmail", l.code AS "languageCode"
         FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN languages l ON l.id=a.language_id
         WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ${p(f.pageSize)} OFFSET ${p((f.page - 1) * f.pageSize)}`,
        params,
      ),
    ]);
    return { total: total?.n ?? 0, rows, scoped: !scope.isSuperAdmin && !scope.can('view_audit') ? 'own' : scope.isSuperAdmin ? 'all' : 'scope' };
  });
}
