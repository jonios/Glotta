import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import type { Scope } from '../authz/scope.js';
import { audit, HttpError, idParam, parse, scopeOf } from '../http.js';
import { randomToken, sha256 } from '../auth/crypto.js';
import { API_KEY_ROLES } from '../../shared/domain.js';

export const API_KEY_PREFIX = 'glt_';

function requireKeyManager(scope: Scope) {
  if (!API_KEY_ROLES.includes(scope.role)) throw new HttpError(403, 'forbidden', 'Only Super Admins and Translation Managers can manage API keys');
}

/**
 * API key management for the dashboard (session-authenticated). Super Admins see and revoke every key;
 * Translation Managers see and revoke only their own. The full key is returned once, at creation.
 */
export function apiKeyRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/api-keys', async (req) => {
    const scope = scopeOf(req);
    requireKeyManager(scope);
    return db.query(
      `SELECT k.id, k.name, k.prefix, k.created_at AS "createdAt", k.expires_at AS "expiresAt",
              k.last_used_at AS "lastUsedAt", k.use_count AS "useCount", k.revoked_at AS "revokedAt",
              u.id AS "createdById", u.name AS "createdBy", r.name AS "revokedBy",
              CASE WHEN k.revoked_at IS NOT NULL THEN 'revoked'
                   WHEN k.expires_at IS NOT NULL AND k.expires_at <= now() THEN 'expired'
                   ELSE 'active' END AS status
       FROM api_keys k JOIN users u ON u.id=k.created_by LEFT JOIN users r ON r.id=k.revoked_by
       WHERE ${scope.isSuperAdmin ? 'TRUE' : 'k.created_by=$1'}
       ORDER BY (k.revoked_at IS NULL) DESC, k.created_at DESC`,
      scope.isSuperAdmin ? [] : [scope.userId],
    );
  });

  app.post('/api/api-keys', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const scope = scopeOf(req);
    requireKeyManager(scope);
    const body = parse(
      z.object({
        name: z.string().trim().min(1, 'Give the key a name').max(100),
        expiresInDays: z.number().int().positive().max(3650).nullable().default(null),
      }),
      req.body,
    );
    const key = API_KEY_PREFIX + randomToken(30);
    const prefix = key.slice(0, API_KEY_PREFIX.length + 6);
    return db.tx(async (q) => {
      const row = await q.one<{ id: number; createdAt: string; expiresAt: string | null }>(
        `INSERT INTO api_keys (name, prefix, key_hash, created_by, expires_at)
         VALUES ($1,$2,$3,$4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5::int * interval '1 day') END)
         RETURNING id, created_at AS "createdAt", expires_at AS "expiresAt"`,
        [body.name, prefix, sha256(key), scope.userId, body.expiresInDays],
      );
      await audit(q, scope.userId, { action: 'api_key.created', resourceType: 'api_key', resourceId: row!.id, after: { name: body.name, prefix, expiresInDays: body.expiresInDays } }, req.ip);
      return { id: row!.id, name: body.name, prefix, key, createdAt: row!.createdAt, expiresAt: row!.expiresAt };
    });
  });

  app.post('/api/api-keys/:id/revoke', async (req) => {
    const scope = scopeOf(req);
    requireKeyManager(scope);
    const { id } = parse(idParam, req.params);
    return db.tx(async (q) => {
      const k = await q.one<{ created_by: number; revoked_at: string | null; name: string; prefix: string }>('SELECT created_by, revoked_at, name, prefix FROM api_keys WHERE id=$1', [id]);
      // Managers can't tell other people's keys exist.
      if (!k || (!scope.isSuperAdmin && k.created_by !== scope.userId)) throw new HttpError(404, 'not_found', 'API key not found');
      if (k.revoked_at) return { ok: true };
      await q.query('UPDATE api_keys SET revoked_at=now(), revoked_by=$2 WHERE id=$1', [id, scope.userId]);
      await audit(q, scope.userId, { action: 'api_key.revoked', resourceType: 'api_key', resourceId: id, before: { name: k.name, prefix: k.prefix } }, req.ip);
      return { ok: true };
    });
  });
}
