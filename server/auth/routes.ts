import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { loadScope } from '../authz/scope.js';
import { audit, HttpError, parse, scopeOf } from '../http.js';
import { hashPassword, PASSWORD_RULE, randomToken, sha256, verifyPassword } from './crypto.js';

export const SESSION_COOKIE = 'tms_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PUBLIC_ROUTES = new Set(['/api/auth/login', '/api/auth/accept-invite', '/api/auth/invite-info', '/api/health']);

export async function createSession(ctx: Ctx, userId: number, req: FastifyRequest) {
  const token = randomToken();
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + ctx.config.sessionTtlHours * 3600_000);
  await ctx.db.query(
    'INSERT INTO sessions (id_hash, user_id, csrf_token, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6)',
    [sha256(token), userId, csrf, expires, req.ip ?? '', String(req.headers['user-agent'] ?? '').slice(0, 300)],
  );
  return { token, csrf, expires };
}

/**
 * Session authentication: opaque random token in an HttpOnly, SameSite=Lax cookie; only its
 * SHA-256 is stored. Mutating requests must echo the per-session CSRF token in a header.
 */
export function registerAuthHook(app: FastifyInstance, ctx: Ctx) {
  app.addHook('preHandler', async (req) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    // The public API authenticates with API keys (server/modules/public-api.ts), never with the session cookie.
    if (path.startsWith('/api/v1/')) return;
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const s = await ctx.db.one<{ user_id: number; csrf_token: string; expires_at: Date }>(
        'SELECT user_id, csrf_token, expires_at FROM sessions WHERE id_hash=$1',
        [sha256(token)],
      );
      if (s && new Date(s.expires_at) > new Date()) {
        const scope = await loadScope(ctx.db, s.user_id);
        if (scope) {
          req.scope = scope;
          req.userId = s.user_id;
          req.sessionCsrf = s.csrf_token;
        }
      }
    }
    if (PUBLIC_ROUTES.has(path)) return;
    if (!req.scope) throw new HttpError(401, 'unauthenticated', 'Sign in required');
    if (!SAFE_METHODS.has(req.method) && req.headers['x-csrf-token'] !== req.sessionCsrf) {
      throw new HttpError(403, 'csrf', 'Invalid CSRF token');
    }
  });
}

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const cookieOpts = () => ({
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: ctx.config.cookieSecure,
    path: '/',
  });

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(z.object({ email: z.string().email().max(200), password: z.string().min(1).max(500) }), req.body);
      const user = await ctx.db.one<{ id: number; password_hash: string | null; is_active: boolean }>(
        'SELECT id, password_hash, is_active FROM users WHERE lower(email)=lower($1)',
        [body.email],
      );
      const ok = user ? await verifyPassword(body.password, user.password_hash) : await verifyPassword(body.password, null);
      if (!user || !ok || !user.is_active) {
        throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect, or the account is disabled');
      }
      const s = await createSession(ctx, user.id, req);
      await ctx.db.query('UPDATE users SET last_login_at=now() WHERE id=$1', [user.id]);
      await audit(ctx.db, user.id, { action: 'auth.login', resourceType: 'user', resourceId: user.id }, req.ip);
      reply.setCookie(SESSION_COOKIE, s.token, { ...cookieOpts(), expires: s.expires });
      return { ok: true };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await ctx.db.query('DELETE FROM sessions WHERE id_hash=$1', [sha256(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const scope = scopeOf(req);
    const user = await ctx.db.one('SELECT id, email, name, role FROM users WHERE id=$1', [scope.userId]);
    return { user, scope: scope.toJSON(), csrfToken: req.sessionCsrf };
  });

  app.post('/api/auth/change-password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const scope = scopeOf(req);
    const body = parse(
      z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(PASSWORD_RULE.min, PASSWORD_RULE.message).max(500) }),
      req.body,
    );
    const u = await ctx.db.one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [scope.userId]);
    if (!(await verifyPassword(body.currentPassword, u?.password_hash ?? null))) {
      throw new HttpError(400, 'invalid_password', 'Current password is incorrect');
    }
    await ctx.db.query('UPDATE users SET password_hash=$1, updated_at=now() WHERE id=$2', [await hashPassword(body.newPassword), scope.userId]);
    // Invalidate other sessions.
    const token = req.cookies[SESSION_COOKIE];
    await ctx.db.query('DELETE FROM sessions WHERE user_id=$1 AND id_hash<>$2', [scope.userId, sha256(token ?? '')]);
    await audit(ctx.db, scope.userId, { action: 'auth.password_changed', resourceType: 'user', resourceId: scope.userId }, req.ip);
    return { ok: true };
  });

  app.get('/api/auth/invite-info', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.query);
    const u = await ctx.db.one<{ email: string; name: string; invite_expires_at: Date }>(
      'SELECT email, name, invite_expires_at FROM users WHERE invite_token_hash=$1',
      [sha256(token)],
    );
    if (!u || new Date(u.invite_expires_at) < new Date()) throw new HttpError(404, 'invite_invalid', 'This invitation is invalid or has expired');
    return { email: u.email, name: u.name };
  });

  app.post('/api/auth/accept-invite', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(
      z.object({ token: z.string().min(10).max(200), password: z.string().min(PASSWORD_RULE.min, PASSWORD_RULE.message).max(500) }),
      req.body,
    );
    const u = await ctx.db.one<{ id: number; invite_expires_at: Date; is_active: boolean }>(
      'SELECT id, invite_expires_at, is_active FROM users WHERE invite_token_hash=$1',
      [sha256(body.token)],
    );
    if (!u || new Date(u.invite_expires_at) < new Date() || !u.is_active) {
      throw new HttpError(404, 'invite_invalid', 'This invitation is invalid or has expired');
    }
    await ctx.db.query(
      'UPDATE users SET password_hash=$1, invite_token_hash=NULL, invite_expires_at=NULL, updated_at=now() WHERE id=$2',
      [await hashPassword(body.password), u.id],
    );
    await audit(ctx.db, u.id, { action: 'auth.invite_accepted', resourceType: 'user', resourceId: u.id }, req.ip);
    const s = await createSession(ctx, u.id, req);
    reply.setCookie(SESSION_COOKIE, s.token, { ...cookieOpts(), expires: s.expires });
    return { ok: true };
  });
}
