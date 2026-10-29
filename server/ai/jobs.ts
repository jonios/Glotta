import type { Queryable } from '../db/client.js';
import { HttpError } from '../http.js';
import { sha256 } from '../auth/crypto.js';
import { modelFor, type AiConfig, type ModelTier } from './config.js';

export const OVERWRITE_MODES = ['missing', 'outdated', 'unapproved', 'all'] as const;
export type OverwriteMode = (typeof OVERWRITE_MODES)[number];
export type ResultStatus = 'draft' | 'needs_review';

export interface JobScope {
  sourceLanguageId: number;
  targetLanguageId: number;
  platformIds: number[];
  /** Explicit selection (e.g. from the missing-keys report); null = every key on the platforms. */
  keyIds: number[] | null;
  overwrite: OverwriteMode;
}

export interface Candidate {
  key_id: number;
  source_text: string;
  base_version: number | null;
  status: string | null;
  value: string;
  source_changed: boolean;
}

/** Why a candidate is in or out of a job. */
export type Classification = 'eligible' | 'empty_source' | 'approved' | 'has_translation';

export function classify(c: Candidate, overwrite: OverwriteMode): Classification {
  if (!c.source_text.trim()) return 'empty_source';
  const hasValue = c.value.trim() !== '' && c.status !== 'missing';
  const eligible =
    overwrite === 'all' ||
    !hasValue ||
    (overwrite === 'outdated' && c.source_changed) ||
    (overwrite === 'unapproved' && c.status !== 'approved');
  if (eligible) return 'eligible';
  return c.status === 'approved' ? 'approved' : 'has_translation';
}

/**
 * Keys in scope with their source text (from the chosen source language) and the current target
 * translation. Translations are per key, so one result serves every platform the key is on.
 */
export async function findCandidates(q: Queryable, scope: JobScope, sourceIsDefault: boolean, onlyKeyIds?: number[]): Promise<Candidate[]> {
  const params: unknown[] = [scope.targetLanguageId, scope.platformIds];
  let sourceJoin = '';
  let sourceExpr = 'k.source_text';
  if (!sourceIsDefault) {
    params.push(scope.sourceLanguageId);
    sourceJoin = `LEFT JOIN translations s ON s.key_id=k.id AND s.language_id=$${params.length}`;
    sourceExpr = `CASE WHEN s.status IS DISTINCT FROM 'missing' THEN COALESCE(s.value, '') ELSE '' END`;
  }
  let keyFilter = '';
  const ids = onlyKeyIds ?? scope.keyIds;
  if (ids) {
    params.push(ids);
    keyFilter = `AND k.id = ANY($${params.length}::int[])`;
  }
  return q.query<Candidate>(
    `SELECT k.id AS key_id, ${sourceExpr} AS source_text, t.version AS base_version, t.status,
            COALESCE(t.value, '') AS value, COALESCE(t.source_changed, false) AS source_changed
     FROM translation_keys k
     LEFT JOIN translations t ON t.key_id=k.id AND t.language_id=$1
     ${sourceJoin}
     WHERE NOT k.is_archived
       AND EXISTS (SELECT 1 FROM key_platforms kp WHERE kp.key_id=k.id AND kp.platform_id = ANY($2::int[]))
       ${keyFilter}
     ORDER BY k.id`,
    params,
  );
}

export interface Preview {
  candidates: number;
  eligible: number;
  emptySource: number;
  excluded: { approved: number; hasTranslation: number };
  batches: number;
  batchSize: number;
  mode: 'interactive' | 'message_batches';
  model: string;
  tier: ModelTier;
  /** Rough token estimate from text length (≈4 characters per token); real usage is recorded per job. */
  estimate: { inputTokens: number; outputTokens: number; costUsd: number | null; note: string };
}

export function buildPreview(config: AiConfig, candidates: Candidate[], scope: JobScope, tier: ModelTier, requestedMode: 'auto' | 'interactive', batchSize: number): Preview {
  const counts = { eligible: 0, empty_source: 0, approved: 0, has_translation: 0 } as Record<Classification, number>;
  let chars = 0;
  for (const c of candidates) {
    const k = classify(c, scope.overwrite);
    counts[k]++;
    if (k === 'eligible') chars += c.source_text.length;
  }
  const batches = Math.ceil(counts.eligible / batchSize);
  const mode = requestedMode === 'auto' && config.messageBatchMinKeys > 0 && counts.eligible >= config.messageBatchMinKeys ? 'message_batches' : 'interactive';
  // Per item: the text plus JSON keys and context; per request: instructions and wrapper.
  const inputTokens = Math.round(chars / 4 + counts.eligible * 30 + batches * 900);
  const outputTokens = Math.round(chars / 3 + counts.eligible * 15);
  const price = config.prices[tier] ?? (tier === 'economy' && !config.models.economy ? config.prices.standard : null);
  const discount = mode === 'message_batches' ? 0.5 : 1;
  const costUsd = price ? Math.round(((inputTokens * price.input + outputTokens * price.output) / 1_000_000) * discount * 100) / 100 : null;
  return {
    candidates: candidates.length,
    eligible: counts.eligible,
    emptySource: counts.empty_source,
    excluded: { approved: counts.approved, hasTranslation: counts.has_translation },
    batches,
    batchSize,
    mode,
    model: modelFor(config, tier),
    tier,
    estimate: {
      inputTokens,
      outputTokens,
      costUsd,
      note: price
        ? 'Rough estimate from text length; reasoning tokens and retries come on top. Actual usage is recorded on the job.'
        : 'Set AI_PRICE_INPUT_PER_MTOK / AI_PRICE_OUTPUT_PER_MTOK to show a cost estimate. Actual usage is recorded on the job.',
    },
  };
}

export function dedupeKey(scope: JobScope): string {
  const keys = scope.keyIds ? sha256([...scope.keyIds].sort((a, b) => a - b).join(',')).slice(0, 16) : 'scope';
  return [scope.targetLanguageId, scope.sourceLanguageId, [...scope.platformIds].sort((a, b) => a - b).join('.'), scope.overwrite, keys].join('|');
}

/** Splits pending items into new application batches of `size`. */
export async function batchPendingItems(q: Queryable, jobId: number, itemIds: number[], size: number): Promise<number> {
  let made = 0;
  for (let i = 0; i < itemIds.length; i += size) {
    const b = await q.one<{ id: number }>('INSERT INTO translation_job_batches (job_id) VALUES ($1) RETURNING id', [jobId]);
    await q.query('UPDATE translation_job_items SET batch_id=$1 WHERE id = ANY($2::int[])', [b!.id, itemIds.slice(i, i + size)]);
    made++;
  }
  return made;
}

export function isUniqueViolation(err: unknown) {
  return (err as { code?: string })?.code === '23505';
}

export async function createJob(
  q: Queryable,
  config: AiConfig,
  input: { scope: JobScope; sourceIsDefault: boolean; tier: ModelTier; resultStatus: ResultStatus; mode: 'auto' | 'interactive'; batchSize: number; userId: number },
) {
  const { scope } = input;
  const candidates = await findCandidates(q, scope, input.sourceIsDefault);
  const preview = buildPreview(config, candidates, scope, input.tier, input.mode, input.batchSize);
  if (preview.eligible === 0) throw new HttpError(400, 'nothing_to_translate', 'No keys in this scope need translating with the chosen overwrite mode');
  if (preview.eligible > config.maxKeysPerJob) {
    throw new HttpError(400, 'too_many_keys', `This job has ${preview.eligible} keys; the limit is ${config.maxKeysPerJob} (AI_MAX_KEYS_PER_JOB). Narrow the platforms or select keys.`);
  }
  // Checked first because a unique violation aborts the surrounding transaction; the partial unique
  // index still guards the race between two simultaneous requests.
  const active = await q.one<{ id: number }>(`SELECT id FROM translation_jobs WHERE dedupe_key=$1 AND status IN ('queued','running','cancel_requested')`, [dedupeKey(scope)]);
  if (active) throw new HttpError(409, 'job_exists', 'An Auto Translate job for the same language, platforms and options is already running', { jobId: active.id });
  let job: { id: number } | undefined;
  try {
    job = await q.one<{ id: number }>(
      `INSERT INTO translation_jobs (status, mode, source_language_id, target_language_id, platform_ids, key_ids, overwrite, result_status,
         model, model_tier, batch_size, dedupe_key, total_keys, stats, created_by)
       VALUES ('queued',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        preview.mode,
        scope.sourceLanguageId,
        scope.targetLanguageId,
        scope.platformIds,
        scope.keyIds,
        scope.overwrite,
        input.resultStatus,
        preview.model,
        input.tier,
        input.batchSize,
        dedupeKey(scope),
        preview.eligible + preview.emptySource,
        JSON.stringify({ candidates: preview.candidates, excluded: preview.excluded, estimate: preview.estimate }),
        input.userId,
      ],
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw new HttpError(409, 'job_exists', 'An Auto Translate job for the same language, platforms and options is already running');
  }
  const eligible = candidates.filter((c) => classify(c, scope.overwrite) === 'eligible');
  const empty = candidates.filter((c) => classify(c, scope.overwrite) === 'empty_source');
  const rows = [...eligible.map((c) => ({ c, status: 'pending', reason: '' })), ...empty.map((c) => ({ c, status: 'skipped', reason: 'empty_source' }))];
  const inserted = await q.query<{ id: number; status: string }>(
    `INSERT INTO translation_job_items (job_id, key_id, source_text, base_version, status, reason, error)
     SELECT $1, k, s, v, st, r, CASE WHEN r='empty_source' THEN 'The source text is empty' ELSE '' END
     FROM unnest($2::int[], $3::text[], $4::int[], $5::text[], $6::text[]) AS u(k, s, v, st, r)
     RETURNING id, status`,
    [job!.id, rows.map((r) => r.c.key_id), rows.map((r) => r.c.source_text), rows.map((r) => r.c.base_version), rows.map((r) => r.status), rows.map((r) => r.reason)],
  );
  await batchPendingItems(q, job!.id, inserted.filter((r) => r.status === 'pending').map((r) => r.id), input.batchSize);
  return { id: job!.id, preview };
}

/**
 * Puts items back in the queue (retry failed keys, or resume a cancelled job). Each item's source text
 * and base version are refreshed first; items no longer eligible under the job's overwrite mode are skipped.
 */
export async function requeueItems(q: Queryable, jobId: number, which: 'failed' | 'pending', itemIds: number[] | undefined) {
  const job = await q.one<{ id: number; status: string; source_language_id: number; target_language_id: number; platform_ids: number[]; key_ids: number[] | null; overwrite: OverwriteMode; batch_size: number }>(
    'SELECT id, status, source_language_id, target_language_id, platform_ids, key_ids, overwrite, batch_size FROM translation_jobs WHERE id=$1',
    [jobId],
  );
  if (!job) throw new HttpError(404, 'not_found', 'Job not found');
  if (['queued', 'running', 'cancel_requested'].includes(job.status)) throw new HttpError(409, 'job_active', 'Wait until the job has stopped before retrying or resuming');
  const params: unknown[] = [jobId, which];
  let filter = '';
  if (itemIds?.length) {
    params.push(itemIds);
    filter = `AND id = ANY($3::int[])`;
  }
  const items = await q.query<{ id: number; key_id: number }>(`SELECT id, key_id FROM translation_job_items WHERE job_id=$1 AND status=$2 ${filter}`, params);
  if (!items.length) throw new HttpError(400, 'nothing_to_retry', which === 'failed' ? 'This job has no failed keys to retry' : 'This job has no unfinished keys to resume');

  const src = await q.one<{ is_source: boolean }>('SELECT is_source FROM languages WHERE id=$1', [job.source_language_id]);
  const scope: JobScope = { sourceLanguageId: job.source_language_id, targetLanguageId: job.target_language_id, platformIds: job.platform_ids, keyIds: job.key_ids, overwrite: job.overwrite };
  const fresh = new Map((await findCandidates(q, scope, !!src?.is_source, items.map((i) => i.key_id))).map((c) => [c.key_id, c]));
  const again: number[] = [];
  for (const it of items) {
    const c = fresh.get(it.key_id);
    const k = c ? classify(c, job.overwrite) : null;
    if (c && k === 'eligible') {
      await q.query(`UPDATE translation_job_items SET status='pending', reason='', error='', attempts=0, source_text=$2, base_version=$3, batch_id=NULL, updated_at=now() WHERE id=$1`, [it.id, c.source_text, c.base_version]);
      again.push(it.id);
    } else {
      const reason = !c ? 'no_longer_in_scope' : k === 'empty_source' ? 'empty_source' : 'already_translated';
      await q.query(`UPDATE translation_job_items SET status='skipped', reason=$2, error='', batch_id=NULL, updated_at=now() WHERE id=$1`, [it.id, reason]);
    }
  }
  await q.query(`UPDATE translation_job_batches SET status='cancelled' WHERE job_id=$1 AND status IN ('pending','failed')`, [jobId]);
  if (again.length) await batchPendingItems(q, jobId, again, job.batch_size);
  const dk = await q.one<{ dedupe_key: string }>('SELECT dedupe_key FROM translation_jobs WHERE id=$1', [jobId]);
  const other = await q.one(`SELECT id FROM translation_jobs WHERE dedupe_key=$1 AND id<>$2 AND status IN ('queued','running','cancel_requested')`, [dk!.dedupe_key, jobId]);
  if (other && again.length) throw new HttpError(409, 'job_exists', 'Another job with the same scope is running; wait for it to finish');
  try {
    await q.query(
      `UPDATE translation_jobs SET status=$2, mode='interactive', finished_at=NULL, error_summary='', updated_at=now() WHERE id=$1`,
      [jobId, again.length ? 'queued' : 'completed_with_errors'],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'job_exists', 'Another job with the same scope is running; wait for it to finish');
    throw err;
  }
  return { requeued: again.length, skipped: items.length - again.length };
}

/** Progress and outcome counts, always computed from persisted rows. */
export async function jobSummary(q: Queryable, jobId: number) {
  const job = await q.one(
    `SELECT j.id, j.status, j.mode, j.overwrite, j.result_status AS "resultStatus", j.model, j.model_tier AS "modelTier", j.batch_size AS "batchSize",
            j.platform_ids AS "platformIds", j.key_ids IS NOT NULL AS "selectedKeys", j.total_keys AS "totalKeys", j.stats,
            j.input_tokens::int AS "inputTokens", j.output_tokens::int AS "outputTokens", j.cache_read_tokens::int AS "cacheReadTokens",
            j.api_requests AS "apiRequests", j.anthropic_batch_id IS NOT NULL AS "usedMessageBatches", j.error_summary AS "errorSummary",
            j.created_at AS "createdAt", j.started_at AS "startedAt", j.finished_at AS "finishedAt", j.updated_at AS "updatedAt",
            s.id AS "sourceLanguageId", s.code AS "sourceCode", s.name AS "sourceName",
            t.id AS "targetLanguageId", t.code AS "targetCode", t.name AS "targetName",
            u.name AS "createdBy"
     FROM translation_jobs j JOIN languages s ON s.id=j.source_language_id JOIN languages t ON t.id=j.target_language_id
     LEFT JOIN users u ON u.id=j.created_by WHERE j.id=$1`,
    [jobId],
  );
  if (!job) return null;
  const items = await q.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM translation_job_items WHERE job_id=$1 GROUP BY status', [jobId]);
  const batches = await q.query<{ status: string; n: number; attempts: number }>(
    'SELECT status, count(*)::int AS n, COALESCE(sum(GREATEST(attempts-1,0)),0)::int AS attempts FROM translation_job_batches WHERE job_id=$1 GROUP BY status',
    [jobId],
  );
  const reasons = await q.query<{ reason: string; n: number }>(
    `SELECT reason, count(*)::int AS n FROM translation_job_items WHERE job_id=$1 AND status IN ('failed','skipped') GROUP BY reason ORDER BY n DESC`,
    [jobId],
  );
  const counts = { pending: 0, translated: 0, skipped: 0, failed: 0 } as Record<string, number>;
  for (const r of items) counts[r.status] = r.n;
  const b = Object.fromEntries(batches.map((x) => [x.status, x.n])) as Record<string, number>;
  const total = counts.pending + counts.translated + counts.skipped + counts.failed;
  return {
    ...job,
    counts,
    batches: {
      total: batches.filter((x) => x.status !== 'split' && x.status !== 'cancelled').reduce((s, x) => s + x.n, 0),
      done: b.done ?? 0,
      failed: b.failed ?? 0,
      running: (b.running ?? 0) + (b.submitted ?? 0),
      pending: b.pending ?? 0,
      retries: batches.reduce((s, x) => s + x.attempts, 0),
    },
    reasons,
    progress: total ? Math.round(((total - counts.pending) / total) * 1000) / 10 : 100,
  };
}
