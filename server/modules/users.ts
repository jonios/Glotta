import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import type { Queryable } from '../db/client.js';
import type { Scope } from '../authz/scope.js';
import { audit, HttpError, idParam, parse, scopeOf } from '../http.js';
import { randomToken, sha256 } from '../auth/crypto.js';
import { CAPABILITIES, ROLES, type Capability, type Role } from '../../shared/domain.js';

const INVITE_TTL_DAYS = 7;

const accessBody = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.enum(ROLES),
  capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length),
  allLanguages: z.boolean(),
  languageIds: z.array(z.number().int().positive()).max(500),
  allPlatforms: z.boolean(),
  platformIds: z.array(z.number().int().positive()).max(500),
  isActive: z.boolean().optional(),
});
type AccessBody = z.infer<typeof accessBody>;

/**
 * A user manager can only hand out what they hold themselves: no privilege escalation
 * through the permissions screen.
 */
function assertGrantable(scope: Scope, body: AccessBody) {
  if (scope.isSuperAdmin) return;
  if (body.role === 'super_admin') throw new HttpError(403, 'forbidden', 'Only a Super Admin can create Super Admins');
  for (const c of body.capabilities) {
    if (!scope.can(c)) throw new HttpError(403, 'forbidden', `You cannot grant "${c}" because you do not hold it`);
  }
  if (body.allLanguages && !scope.allLanguages) throw new HttpError(403, 'forbidden', 'You cannot grant all-language access');
  if (body.allPlatforms && !scope.allPlatforms) throw new HttpError(403, 'forbidden', 'You cannot grant all-platform access');
  for (const id of body.languageIds) if (!scope.canSeeLanguage(id)) throw new HttpError(403, 'forbidden', 'Language outside your scope');
  for (const id of body.platformIds) if (!scope.canSeePlatform(id)) throw new HttpError(403, 'forbidden', 'Platform outside your scope');
}

async function writeAccess(q: Queryable, userId: number, body: AccessBody) {
  const caps: Capability[] = body.role === 'super_admin' ? [...CAPABILITIES] : [...new Set(body.capabilities)];
  await q.query('DELETE FROM user_capabilities WHERE user_id=$1', [userId]);
  await q.query('DELETE FROM user_languages WHERE user_id=$1', [userId]);
  await q.query('DELETE FROM user_platforms WHERE user_id=$1', [userId]);
  if (caps.length) await q.query('INSERT INTO user_capabilities (user_id, capability) SELECT $1, unnest($2::text[])', [userId, caps]);
  if (!body.allLanguages && body.languageIds.length) {
    await q.query('INSERT INTO user_languages (user_id, language_id) SELECT $1, id FROM languages WHERE id = ANY($2::int[])', [userId, body.languageIds]);
  }
  if (!body.allPlatforms && body.platformIds.length) {
    await q.query('INSERT INTO user_platforms (user_id, platform_id) SELECT $1, id FROM platforms WHERE id = ANY($2::int[])', [userId, body.platformIds]);
  }
}

async function accessSnapshot(q: Queryable, userId: number) {
  return q.one(
    `SELECT u.role, u.is_active, u.all_languages, u.all_platforms,
       ARRAY(SELECT capability FROM user_capabilities WHERE user_id=u.id ORDER BY 1) AS capabilities,
       ARRAY(SELECT l.code FROM user_languages ul JOIN languages l ON l.id=ul.language_id WHERE ul.user_id=u.id ORDER BY 1) AS languages,
       ARRAY(SELECT p.name FROM user_platforms up JOIN platforms p ON p.id=up.platform_id WHERE up.user_id=u.id ORDER BY 1) AS platforms
     FROM users u WHERE u.id=$1`,
    [userId],
  );
}

async function activeSuperAdmins(q: Queryable): Promise<number> {
  const r = await q.one<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE role='super_admin' AND is_active");
  return r?.n ?? 0;
}

/** User management — listing, inviting, editing, (de)activating, resetting — is reserved for Super Admins. */
function requireSuperAdmin(scope: Scope) {
  if (!scope.isSuperAdmin) throw new HttpError(403, 'forbidden', 'Only a Super Admin can manage users');
}

export function userRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/users', async (req) => {
    requireSuperAdmin(scopeOf(req));
    return db.query(
      `SELECT u.id, u.email, u.name, u.role, u.is_active AS "isActive", u.all_languages AS "allLanguages", u.all_platforms AS "allPlatforms",
              u.last_login_at AS "lastLoginAt", u.created_at AS "createdAt",
              (u.password_hash IS NULL) AS "invitePending",
              ARRAY(SELECT capability FROM user_capabilities WHERE user_id=u.id ORDER BY 1) AS capabilities,
              ARRAY(SELECT language_id FROM user_languages WHERE user_id=u.id) AS "languageIds",
              ARRAY(SELECT platform_id FROM user_platforms WHERE user_id=u.id) AS "platformIds"
       FROM users u ORDER BY u.is_active DESC, lower(u.name)`,
    );
  });

  app.post('/api/users', async (req) => {
    const scope = scopeOf(req);
    requireSuperAdmin(scope);
    const body = parse(accessBody.extend({ email: z.string().trim().toLowerCase().email().max(200) }), req.body);
    assertGrantable(scope, body);
    const token = randomToken();
    return db.tx(async (q) => {
      const exists = await q.one('SELECT 1 FROM users WHERE lower(email)=$1', [body.email]);
      if (exists) throw new HttpError(409, 'email_taken', 'A user with this email already exists');
      const row = await q.one<{ id: number }>(
        `INSERT INTO users (email, name, role, all_languages, all_platforms, invite_token_hash, invite_expires_at, invited_by)
         VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' days')::interval, $8) RETURNING id`,
        [body.email, body.name, body.role, body.allLanguages || body.role === 'super_admin', body.allPlatforms || body.role === 'super_admin', sha256(token), String(INVITE_TTL_DAYS), scope.userId],
      );
      await writeAccess(q, row!.id, body);
      await audit(q, scope.userId, { action: 'user.invited', resourceType: 'user', resourceId: row!.id, after: await accessSnapshot(q, row!.id) }, req.ip);
      return { id: row!.id, inviteUrl: `${ctx.config.appUrl}/accept-invite?token=${token}`, expiresInDays: INVITE_TTL_DAYS };
    });
  });

  app.patch('/api/users/:id', async (req) => {
    const scope = scopeOf(req);
    requireSuperAdmin(scope);
    const { id } = parse(idParam, req.params);
    const body = parse(accessBody, req.body);
    assertGrantable(scope, body);
    return db.tx(async (q) => {
      const target = await q.one<{ role: Role; is_active: boolean }>('SELECT role, is_active FROM users WHERE id=$1', [id]);
      if (!target) throw new HttpError(404, 'not_found', 'User not found');
      if (target.role === 'super_admin' && !scope.isSuperAdmin) throw new HttpError(403, 'forbidden', 'Only a Super Admin can modify a Super Admin');
      const losesAdmin = target.role === 'super_admin' && target.is_active && (body.role !== 'super_admin' || body.isActive === false);
      if (losesAdmin && (await activeSuperAdmins(q)) <= 1) {
        throw new HttpError(400, 'last_admin', 'At least one active Super Admin must remain');
      }
      const before = await accessSnapshot(q, id);
      await q.query(
        'UPDATE users SET name=$2, role=$3, all_languages=$4, all_platforms=$5, is_active=COALESCE($6,is_active), updated_at=now() WHERE id=$1',
        [id, body.name, body.role, body.allLanguages || body.role === 'super_admin', body.allPlatforms || body.role === 'super_admin', body.isActive ?? null],
      );
      await writeAccess(q, id, body);
      if (body.isActive === false) await q.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await audit(q, scope.userId, { action: 'user.permissions_changed', resourceType: 'user', resourceId: id, before, after: await accessSnapshot(q, id) }, req.ip);
      return { ok: true };
    });
  });

  app.post('/api/users/:id/status', async (req) => {
    const scope = scopeOf(req);
    requireSuperAdmin(scope);
    const { id } = parse(idParam, req.params);
    const { isActive } = parse(z.object({ isActive: z.boolean() }), req.body);
    if (id === scope.userId && !isActive) throw new HttpError(400, 'self', 'You cannot deactivate your own account');
    return db.tx(async (q) => {
      const target = await q.one<{ role: Role; is_active: boolean }>('SELECT role, is_active FROM users WHERE id=$1', [id]);
      if (!target) throw new HttpError(404, 'not_found', 'User not found');
      if (target.role === 'super_admin' && !scope.isSuperAdmin) throw new HttpError(403, 'forbidden', 'Only a Super Admin can modify a Super Admin');
      if (!isActive && target.role === 'super_admin' && (await activeSuperAdmins(q)) <= 1) {
        throw new HttpError(400, 'last_admin', 'At least one active Super Admin must remain');
      }
      await q.query('UPDATE users SET is_active=$2, updated_at=now() WHERE id=$1', [id, isActive]);
      if (!isActive) await q.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await audit(q, scope.userId, { action: isActive ? 'user.activated' : 'user.deactivated', resourceType: 'user', resourceId: id }, req.ip);
      return { ok: true };
    });
  });

  /** Issues a fresh invite / password-reset link. Revokes existing sessions and the old password. */
  app.post('/api/users/:id/reset-access', async (req) => {
    const scope = scopeOf(req);
    requireSuperAdmin(scope);
    const { id } = parse(idParam, req.params);
    const target = await db.one<{ role: Role }>('SELECT role FROM users WHERE id=$1', [id]);
    if (!target) throw new HttpError(404, 'not_found', 'User not found');
    if (target.role === 'super_admin' && !scope.isSuperAdmin) throw new HttpError(403, 'forbidden', 'Only a Super Admin can reset a Super Admin');
    if (id === scope.userId) throw new HttpError(400, 'self', 'Use "Change password" for your own account');
    const token = randomToken();
    await db.tx(async (q) => {
      await q.query(
        `UPDATE users SET password_hash=NULL, invite_token_hash=$2, invite_expires_at=now() + ($3 || ' days')::interval, updated_at=now() WHERE id=$1`,
        [id, sha256(token), String(INVITE_TTL_DAYS)],
      );
      await q.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await audit(q, scope.userId, { action: 'user.access_reset', resourceType: 'user', resourceId: id }, req.ip);
    });
    return { inviteUrl: `${ctx.config.appUrl}/accept-invite?token=${token}`, expiresInDays: INVITE_TTL_DAYS };
  });

  app.get('/api/users/:id/activity', async (req) => {
    requireSuperAdmin(scopeOf(req));
    const { id } = parse(idParam, req.params);
    return db.query(
      `SELECT id, action, resource_type AS "resourceType", resource_id AS "resourceId", created_at AS "createdAt"
       FROM audit_logs WHERE actor_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [id],
    );
  });
}
