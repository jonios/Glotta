import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import type { Scope } from '../authz/scope.js';
import { allPlatformIds } from '../modules/key-query.js';
import { audit, HttpError, idParam, parse, scopeOf } from '../http.js';
import { API_KEY_ROLES } from '../../shared/domain.js';
import type { AiConfig } from './config.js';
import type { TranslatorClient } from './claude.js';
import type { TranslationWorker } from './worker.js';
import { buildPreview, createJob, findCandidates, jobSummary, OVERWRITE_MODES, requeueItems, type JobScope } from './jobs.js';

export interface AiRuntime {
  config: AiConfig;
  client: TranslatorClient | null;
  worker: TranslationWorker | null;
}

/** Auto Translate is for the roles that manage translation work, with edit rights. */
function requireAiAccess(scope: Scope) {
  if (!API_KEY_ROLES.includes(scope.role) || !scope.can('edit_translations')) {
    throw new HttpError(403, 'forbidden', 'Only Super Admins and Translation Managers with edit rights can run Auto Translate');
  }
}

const jobInput = z.object({
  targetLanguageId: z.number().int().positive(),
  sourceLanguageId: z.number().int().positive().optional(),
  platformIds: z.array(z.number().int().positive()).max(200).optional(),
  keyIds: z.array(z.number().int().positive()).min(1).max(20_000).optional(),
  overwrite: z.enum(OVERWRITE_MODES).default('missing'),
  /** Required for overwrite modes that replace existing human work. */
  confirmOverwrite: z.boolean().default(false),
  tier: z.enum(['standard', 'economy']).default('standard'),
  resultStatus: z.enum(['needs_review', 'draft']).default('needs_review'),
  mode: z.enum(['auto', 'interactive']).default('auto'),
  batchSize: z.number().int().positive().optional(),
});

export function aiRoutes(app: FastifyInstance, ctx: Ctx, ai: AiRuntime) {
  const { db } = ctx;
  const { config } = ai;

  /** Validates languages and platforms against the caller's scope and returns the job scope. */
  async function resolveScope(scope: Scope, body: z.infer<typeof jobInput>) {
    requireAiAccess(scope);
    const target = await db.one<{ id: number; is_source: boolean; is_active: boolean }>('SELECT id, is_source, is_active FROM languages WHERE id=$1', [body.targetLanguageId]);
    if (!target || !target.is_active) throw new HttpError(404, 'language_not_found', 'Target language not found');
    if (target.is_source) throw new HttpError(400, 'bad_target', 'The source language cannot be a translation target');
    if (!scope.canSeeLanguage(target.id)) throw new HttpError(403, 'language_forbidden', 'You have no access to this language');
    const sourceId = body.sourceLanguageId ?? (await db.one<{ id: number }>('SELECT id FROM languages WHERE is_source'))!.id;
    const source = await db.one<{ id: number; is_source: boolean; is_active: boolean }>('SELECT id, is_source, is_active FROM languages WHERE id=$1', [sourceId]);
    if (!source || !source.is_active) throw new HttpError(404, 'language_not_found', 'Source language not found');
    if (source.id === target.id) throw new HttpError(400, 'same_language', 'Source and target must differ');
    if (!scope.canSeeLanguage(source.id)) throw new HttpError(403, 'language_forbidden', 'You have no access to the source language');
    const platformIds = scope.resolvePlatforms(body.platformIds, await allPlatformIds(db, false));
    if (!platformIds.length) throw new HttpError(400, 'no_platforms', 'Choose at least one platform');
    if (body.overwrite === 'all' && !scope.isSuperAdmin) throw new HttpError(403, 'forbidden', 'Only Super Admins can overwrite approved translations');
    if ((body.overwrite === 'unapproved' || body.overwrite === 'all') && !body.confirmOverwrite) {
      throw new HttpError(400, 'confirm_overwrite', 'This overwrite mode replaces existing translations; confirm it explicitly (confirmOverwrite: true)');
    }
    if (body.tier === 'economy' && !config.models.economy) throw new HttpError(400, 'no_economy_model', 'No economy model is configured (ANTHROPIC_MODEL_ECONOMY)');
    const batchSize = Math.min(config.maxBatchSize, body.batchSize ?? config.batchSize);
    const jobScope: JobScope = { sourceLanguageId: source.id, targetLanguageId: target.id, platformIds, keyIds: body.keyIds ? [...new Set(body.keyIds)] : null, overwrite: body.overwrite };
    return { jobScope, sourceIsDefault: source.is_source, batchSize };
  }

  async function loadVisibleJob(scope: Scope, id: number) {
    requireAiAccess(scope);
    const job = await db.one<{ id: number; target_language_id: number; platform_ids: number[]; created_by: number }>('SELECT id, target_language_id, platform_ids, created_by FROM translation_jobs WHERE id=$1', [id]);
    if (!job || !scope.canSeeLanguage(job.target_language_id) || !job.platform_ids.every((p) => scope.canSeePlatform(p))) throw new HttpError(404, 'not_found', 'Job not found');
    return job;
  }

  app.get('/api/ai/status', async (req) => {
    const scope = scopeOf(req);
    return {
      configured: config.configured,
      canUse: API_KEY_ROLES.includes(scope.role) && scope.can('edit_translations'),
      workerRunning: !!ai.worker && config.workerEnabled,
      models: { standard: config.models.standard, economy: config.models.economy ?? null },
      batchSize: config.batchSize,
      maxBatchSize: config.maxBatchSize,
      concurrency: config.concurrency,
      maxKeysPerJob: config.maxKeysPerJob,
      messageBatchMinKeys: config.messageBatchMinKeys,
      costEstimates: !!config.prices.standard,
      setupHelp: config.configured ? null : 'Set ANTHROPIC_API_KEY in the server .env (and optionally ANTHROPIC_MODEL), then restart the server. See README.md → AI translation.',
    };
  });

  app.post('/api/ai/jobs/preview', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(jobInput, req.body);
    const { jobScope, sourceIsDefault, batchSize } = await resolveScope(scopeOf(req), body);
    const candidates = await findCandidates(db, jobScope, sourceIsDefault);
    return buildPreview(config, candidates, jobScope, body.tier, body.mode, batchSize);
  });

  app.post('/api/ai/jobs', { config: { rateLimit: { max: config.jobsPerMinute, timeWindow: '1 minute' } } }, async (req, reply) => {
    const scope = scopeOf(req);
    const body = parse(jobInput, req.body);
    if (!config.configured || !ai.client) throw new HttpError(503, 'ai_not_configured', 'Auto Translate is not configured: set ANTHROPIC_API_KEY on the server and restart');
    const { jobScope, sourceIsDefault, batchSize } = await resolveScope(scope, body);
    const created = await db.tx(async (q) => {
      const res = await createJob(q, config, { scope: jobScope, sourceIsDefault, tier: body.tier, resultStatus: body.resultStatus, mode: body.mode, batchSize, userId: scope.userId });
      await audit(
        q,
        scope.userId,
        {
          action: 'ai.job_created',
          resourceType: 'translation_job',
          resourceId: res.id,
          languageId: jobScope.targetLanguageId,
          platformIds: jobScope.platformIds,
          after: { overwrite: jobScope.overwrite, keys: res.preview.eligible, model: res.preview.model, mode: res.preview.mode, selectedKeys: jobScope.keyIds?.length ?? null },
        },
        req.ip,
      );
      return res;
    });
    ai.worker?.nudge();
    reply.status(201);
    return jobSummary(db, created.id);
  });

  app.get('/api/ai/jobs', async (req) => {
    const scope = scopeOf(req);
    requireAiAccess(scope);
    const q = parse(
      z.object({ languageId: z.coerce.number().int().positive().optional(), page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }),
      req.query,
    );
    const params: unknown[] = [];
    let where = 'TRUE';
    if (q.languageId) {
      params.push(q.languageId);
      where += ` AND j.target_language_id=$${params.length}`;
    }
    const rows = await db.query<{ id: number; target_language_id: number; platform_ids: number[] }>(
      `SELECT j.id, j.target_language_id, j.platform_ids FROM translation_jobs j WHERE ${where} ORDER BY j.created_at DESC LIMIT 500`,
      params,
    );
    const visible = rows.filter((j) => scope.canSeeLanguage(j.target_language_id) && j.platform_ids.every((p) => scope.canSeePlatform(p)));
    const page = visible.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    return { total: visible.length, rows: await Promise.all(page.map((j) => jobSummary(db, j.id))) };
  });

  app.get('/api/ai/jobs/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    await loadVisibleJob(scopeOf(req), id);
    return jobSummary(db, id);
  });

  app.get('/api/ai/jobs/:id/items', async (req) => {
    const { id } = parse(idParam, req.params);
    await loadVisibleJob(scopeOf(req), id);
    const q = parse(
      z.object({
        status: z.enum(['pending', 'translated', 'skipped', 'failed']).optional(),
        page: z.coerce.number().int().positive().default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const params: unknown[] = [id];
    let where = 'i.job_id=$1';
    if (q.status) {
      params.push(q.status);
      where += ` AND i.status=$${params.length}`;
    }
    const total = (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM translation_job_items i WHERE ${where}`, params))!.n;
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await db.query(
      `SELECT i.id, i.key_id AS "keyId", i.status, i.reason, i.error, i.attempts, i.source_text AS "sourceText", i.result_value AS "value", i.updated_at AS "updatedAt",
              (SELECT string_agg(DISTINCT kp.identifier, ', ') FROM key_platforms kp WHERE kp.key_id=i.key_id) AS identifier
       FROM translation_job_items i WHERE ${where} ORDER BY i.status <> 'failed', i.id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { total, rows };
  });

  app.post('/api/ai/jobs/:id/cancel', async (req) => {
    const scope = scopeOf(req);
    const { id } = parse(idParam, req.params);
    const job = await loadVisibleJob(scope, id);
    const r = await db.query(`UPDATE translation_jobs SET status='cancel_requested', updated_at=now() WHERE id=$1 AND status IN ('queued','running') RETURNING id`, [job.id]);
    if (!r.length) throw new HttpError(409, 'not_active', 'Only queued or running jobs can be cancelled');
    await audit(db, scope.userId, { action: 'ai.job_cancel_requested', resourceType: 'translation_job', resourceId: id, languageId: job.target_language_id }, req.ip);
    ai.worker?.nudge();
    return jobSummary(db, id);
  });

  app.post('/api/ai/jobs/:id/retry', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const scope = scopeOf(req);
    const { id } = parse(idParam, req.params);
    if (!ai.client) throw new HttpError(503, 'ai_not_configured', 'Auto Translate is not configured');
    const job = await loadVisibleJob(scope, id);
    const { itemIds } = parse(z.object({ itemIds: z.array(z.number().int().positive()).max(20_000).optional() }), req.body ?? {});
    const result = await db.tx(async (q) => {
      const r = await requeueItems(q, id, 'failed', itemIds);
      await audit(q, scope.userId, { action: 'ai.job_retried', resourceType: 'translation_job', resourceId: id, languageId: job.target_language_id, after: r }, req.ip);
      return r;
    });
    ai.worker?.nudge();
    return { ...result, job: await jobSummary(db, id) };
  });

  app.post('/api/ai/jobs/:id/resume', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const scope = scopeOf(req);
    const { id } = parse(idParam, req.params);
    if (!ai.client) throw new HttpError(503, 'ai_not_configured', 'Auto Translate is not configured');
    const job = await loadVisibleJob(scope, id);
    const result = await db.tx(async (q) => {
      const r = await requeueItems(q, id, 'pending', undefined);
      await audit(q, scope.userId, { action: 'ai.job_resumed', resourceType: 'translation_job', resourceId: id, languageId: job.target_language_id, after: r }, req.ip);
      return r;
    });
    ai.worker?.nudge();
    return { ...result, job: await jobSummary(db, id) };
  });
}
