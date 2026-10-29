import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AppConfig } from './config.js';
import type { Db } from './db/client.js';
import { HttpError } from './http.js';
import { authRoutes, registerAuthHook } from './auth/routes.js';
import { referenceRoutes } from './modules/reference.js';
import { userRoutes } from './modules/users.js';
import { keyRoutes } from './modules/keys.js';
import { translationRoutes } from './modules/translations.js';
import { dashboardRoutes } from './modules/dashboard.js';
import { auditRoutes } from './modules/audit.js';
import { importRoutes } from './importexport/import-routes.js';
import { exportRoutes } from './importexport/export-routes.js';
import { apiKeyRoutes } from './modules/api-keys.js';
import { publicApiRoutes } from './modules/public-api.js';
import { missingKeysRoutes } from './modules/missing-keys.js';
import { aiRoutes, type AiRuntime } from './ai/routes.js';
import { loadAiConfig } from './ai/config.js';

export interface Ctx {
  db: Db;
  config: AppConfig;
  /** AI translation runtime (Claude client + worker). Without it, AI routes report "not configured". */
  ai?: AiRuntime;
}

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.config.nodeEnv === 'test' ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.headers.authorization', 'req.headers["x-api-key"]'] },
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: ctx.config.maxUploadMb * 1024 * 1024, files: 1 } });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err.statusCode === 429) return reply.status(429).send({ error: 'rate_limited', message: 'Too many requests, try again shortly' });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: 'file_too_large', message: `File exceeds ${ctx.config.maxUploadMb} MB` });
    if (err.validation || err.statusCode === 400) return reply.status(400).send({ error: 'bad_request', message: err.message });
    // Postgres unique violation → conflict; never leak SQL details.
    if (err.code === '23505') return reply.status(409).send({ error: 'conflict', message: 'A record with the same unique value already exists' });
    req.log.error(err);
    if (process.env.TMS_DEBUG) console.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Unexpected server error' });
  });

  registerAuthHook(app, ctx);
  app.get('/api/health', async () => ({ ok: true, db: ctx.db.driver }));
  authRoutes(app, ctx);
  referenceRoutes(app, ctx);
  userRoutes(app, ctx);
  keyRoutes(app, ctx);
  translationRoutes(app, ctx);
  dashboardRoutes(app, ctx);
  auditRoutes(app, ctx);
  importRoutes(app, ctx);
  exportRoutes(app, ctx);
  apiKeyRoutes(app, ctx);
  publicApiRoutes(app, ctx);
  missingKeysRoutes(app, ctx);
  aiRoutes(app, ctx, ctx.ai ?? { config: { ...loadAiConfig({}), configured: false }, client: null, worker: null });

  app.all('/api/*', async () => {
    throw new HttpError(404, 'not_found', 'Unknown API route');
  });

  // Serve the built SPA in production.
  const dist = resolve('dist');
  if (existsSync(join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not_found' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
