import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { loadScope, type Scope } from '../authz/scope.js';
import { HttpError, parse } from '../http.js';
import { sha256 } from '../auth/crypto.js';
import { API_KEY_ROLES } from '../../shared/domain.js';

/** Read the key from `Authorization: Bearer <key>` or `X-API-Key: <key>`. */
function presentedKey(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim() || null;
  const x = req.headers['x-api-key'];
  return typeof x === 'string' && x.trim() ? x.trim() : null;
}

/**
 * Read-only public API (`/api/v1`), authenticated with API keys instead of the session cookie.
 * Each key acts with the language and platform scope of the user who created it.
 */
export function publicApiRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  async function authenticate(req: FastifyRequest): Promise<Scope> {
    const key = presentedKey(req);
    if (!key) throw new HttpError(401, 'missing_api_key', 'Send your API key in the Authorization header: "Authorization: Bearer <key>"');
    const row = await db.one<{ id: number; created_by: number; revoked: boolean; expired: boolean }>(
      `SELECT id, created_by, revoked_at IS NOT NULL AS revoked, (expires_at IS NOT NULL AND expires_at <= now()) AS expired
       FROM api_keys WHERE key_hash=$1`,
      [sha256(key)],
    );
    if (!row) throw new HttpError(401, 'invalid_api_key', 'The API key is not valid');
    if (row.revoked) throw new HttpError(401, 'api_key_revoked', 'This API key has been revoked');
    if (row.expired) throw new HttpError(401, 'api_key_expired', 'This API key has expired');
    // The key only works while its creator is active and still allowed to own API keys.
    const scope = await loadScope(db, row.created_by);
    if (!scope || !API_KEY_ROLES.includes(scope.role)) throw new HttpError(401, 'api_key_disabled', 'The owner of this API key no longer has API access');
    await db.query('UPDATE api_keys SET last_used_at=now(), last_used_ip=$2, use_count=use_count+1 WHERE id=$1', [row.id, req.ip ?? '']);
    return scope;
  }

  // Browser apps on other origins may call the API: keys travel in a header, never in cookies.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/v1/')) return;
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', 'Authorization, X-API-Key');
    reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    reply.header('Access-Control-Expose-Headers', 'X-Keyword-Count, X-Language, X-Platform, X-Content-Version');
    reply.header('Access-Control-Max-Age', '86400');
    reply.header('Cache-Control', 'no-store');
  });
  app.options('/api/v1/*', async (_req, reply) => reply.status(204).send());

  // 120 requests per minute per key (per IP when no key is sent).
  const rateLimit = { max: 120, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => sha256(presentedKey(req) ?? `ip:${req.ip}`) };

  /** Platforms the key can read, or the one requested with ?platform= (404/403 like the keywords endpoint). */
  async function platformsInScope(scope: Scope, slug: string | undefined) {
    if (slug) {
      const p = await db.one<{ id: number; slug: string }>('SELECT id, slug FROM platforms WHERE slug=$1 AND NOT is_archived', [slug]);
      if (!p) throw new HttpError(404, 'platform_not_found', `No platform with slug "${slug}". GET /api/v1/platforms lists the slugs.`);
      if (!scope.canSeePlatform(p.id)) throw new HttpError(403, 'platform_forbidden', `This API key has no access to "${slug}"`);
      return [p];
    }
    const all = await db.query<{ id: number; slug: string }>('SELECT id, slug FROM platforms WHERE NOT is_archived ORDER BY sort_order, name');
    return all.filter((p) => scope.canSeePlatform(p.id));
  }

  /** Content version of one platform × language; pairs never changed since the feature existed are 1. */
  async function contentVersion(platformId: number, languageId: number) {
    const row = await db.one<{ version: number; updated_at: string }>('SELECT version, updated_at FROM content_versions WHERE platform_id=$1 AND language_id=$2', [platformId, languageId]);
    return { version: row?.version ?? 1, updatedAt: row?.updated_at ?? null };
  }

  app.get('/api/v1/languages', { config: { rateLimit } }, async (req) => {
    const scope = await authenticate(req);
    const { platform } = parse(z.object({ platform: z.string().trim().min(1).max(80).optional() }), req.query);
    const platforms = await platformsInScope(scope, platform);
    const rows = await db.query<{ id: number; code: string; name: string; nativeName: string; direction: string; isSource: boolean }>(
      `SELECT id, code, name, native_name AS "nativeName", direction, is_source AS "isSource"
       FROM languages WHERE is_active ORDER BY is_source DESC, sort_order, name`,
    );
    const versions = await db.query<{ platform_id: number; language_id: number; version: number; updated_at: string }>(
      'SELECT platform_id, language_id, version, updated_at FROM content_versions WHERE platform_id = ANY($1::int[])',
      [platforms.map((p) => p.id)],
    );
    const byPair = new Map(versions.map((v) => [`${v.platform_id}:${v.language_id}`, v]));
    return {
      languages: rows
        .filter((l) => scope.canSeeLanguage(l.id))
        .map(({ id, ...l }) => {
          const vs = platforms.map((p) => ({ slug: p.slug, v: byPair.get(`${p.id}:${id}`) }));
          const latest = vs.reduce<string | null>((max, x) => (x.v && (!max || x.v.updated_at > max) ? x.v.updated_at : max), null);
          return {
            ...l,
            // With ?platform=, the single version of that platform; always the per-platform map.
            ...(platform ? { version: vs[0].v?.version ?? 1 } : {}),
            versions: Object.fromEntries(vs.map((x) => [x.slug, x.v?.version ?? 1])),
            updatedAt: latest,
          };
        }),
    };
  });

  app.get('/api/v1/platforms', { config: { rateLimit } }, async (req) => {
    const scope = await authenticate(req);
    const rows = await db.query<{ id: number; slug: string; name: string; kind: string }>(
      'SELECT id, slug, name, kind FROM platforms WHERE NOT is_archived ORDER BY sort_order, name',
    );
    return { platforms: rows.filter((p) => scope.canSeePlatform(p.id)).map(({ id: _id, ...p }) => p) };
  });

  app.get('/api/v1/languages/:code/keywords', { config: { rateLimit } }, async (req, reply) => {
    const scope = await authenticate(req);
    const { code } = parse(z.object({ code: z.string().trim().min(1).max(20) }), req.params);
    const query = parse(
      z.object({
        platform: z.string().trim().min(1).max(80).optional(),
        status: z.enum(['approved', 'any']).default('approved'),
        fallback: z.enum(['none', 'source']).default('none'),
      }),
      req.query,
    );
    const lang = await db.one<{ id: number; code: string; is_source: boolean }>(
      'SELECT id, code, is_source FROM languages WHERE lower(code)=lower($1) AND is_active',
      [code],
    );
    if (!lang) throw new HttpError(404, 'language_not_found', `No active language with code "${code}". GET /api/v1/languages lists the codes.`);
    if (!scope.canSeeLanguage(lang.id)) throw new HttpError(403, 'language_forbidden', `This API key has no access to "${lang.code}"`);

    const platformIds = (await platformsInScope(scope, query.platform)).map((p) => p.id);

    // One value per keyword. Across several platforms the same keyword can belong to different keys;
    // the shared key wins, then the platform listed first.
    const rows = await db.query<{ identifier: string; source_text: string; value: string | null; status: string | null }>(
      `WITH cand AS (
         SELECT kp.identifier, k.id AS key_id, k.namespace, k.source_text, p.sort_order, p.id AS platform_id
         FROM key_platforms kp
         JOIN translation_keys k ON k.id=kp.key_id AND NOT k.is_archived
         JOIN platforms p ON p.id=kp.platform_id
         WHERE kp.platform_id = ANY($1::int[])
       ), pick AS (
         SELECT DISTINCT ON (identifier) identifier, key_id, source_text FROM cand
         ORDER BY identifier, (namespace = 'shared') DESC, sort_order, platform_id, key_id
       )
       SELECT pick.identifier, pick.source_text, t.value, t.status
       FROM pick LEFT JOIN translations t ON t.key_id=pick.key_id AND t.language_id=$2
       ORDER BY pick.identifier`,
      [platformIds, lang.id],
    );
    const out: Record<string, string> = {};
    for (const r of rows) {
      let value = '';
      if (lang.is_source) value = r.source_text;
      else if (r.value && r.status && r.status !== 'missing' && (query.status === 'any' || r.status === 'approved')) value = r.value;
      if (!value && query.fallback === 'source') value = r.source_text;
      if (value) out[r.identifier] = value;
    }
    reply.header('X-Keyword-Count', String(Object.keys(out).length));
    reply.header('X-Language', lang.code);
    if (query.platform) {
      reply.header('X-Platform', query.platform);
      reply.header('X-Content-Version', String((await contentVersion(platformIds[0], lang.id)).version));
    }
    return out;
  });
}
