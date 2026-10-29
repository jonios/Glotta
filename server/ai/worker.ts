import type { Db, Queryable } from '../db/client.js';
import { audit } from '../http.js';
import { DEFAULT_PLACEHOLDER_RULES, type PlaceholderRule } from '../../shared/placeholders.js';
import { classifyError, withRetry, type ModelReply, type TranslatorClient } from './claude.js';
import type { AiConfig } from './config.js';
import { buildParams, type TranslationRequest } from './prompt.js';
import { validateReply, type ItemOutcome } from './validate.js';
import { batchPendingItems } from './jobs.js';

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

interface JobRow {
  id: number;
  status: string;
  mode: 'interactive' | 'message_batches';
  source_language_id: number;
  target_language_id: number;
  result_status: string;
  model: string;
  batch_size: number;
  created_by: number | null;
  anthropic_batch_id: string | null;
  batch_polled_at: Date | null;
}

interface ItemRow {
  id: number;
  key_id: number;
  source_text: string;
  base_version: number | null;
  attempts: number;
}

/**
 * Processes AI translation jobs in the API process.
 * All state is in the database, so a restart loses nothing: running batches are leased, and a
 * lease that runs out (crash) puts the batch back in the queue. The loop runs on a timer, never
 * inside an HTTP request.
 */
export class TranslationWorker {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopping = false;
  private readonly inFlight = new Map<number, { jobId: number; controller: AbortController; done: Promise<void> }>();

  constructor(
    private readonly db: Db,
    private readonly client: TranslatorClient | null,
    private readonly config: AiConfig,
    private readonly log: Log,
    /** Test hook: shorter backoff between retries. */
    private readonly retryBaseMs = 1000,
  ) {}

  start() {
    if (!this.client || this.timer) return;
    this.stopping = false;
    const loop = async () => {
      await this.tick().catch((err) => this.log.error({ err }, 'translation worker tick failed'));
      if (!this.stopping) this.timer = setTimeout(loop, this.config.pollMs);
    };
    this.timer = setTimeout(loop, 0);
    this.log.info({ concurrency: this.config.concurrency, batchSize: this.config.batchSize }, 'translation worker started');
  }

  /** Wakes a started worker right away (after a job is created, cancelled or retried) instead of waiting for the next poll. */
  nudge() {
    if (this.timer && !this.stopping) void this.tick().catch((err) => this.log.error({ err }, 'translation worker tick failed'));
  }

  /** Stops claiming work, aborts requests in flight and returns their batches to the queue. */
  async stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const f of this.inFlight.values()) f.controller.abort();
    await Promise.allSettled([...this.inFlight.values()].map((f) => f.done));
  }

  /** One pass of the scheduler. Safe to call repeatedly; overlapping calls are skipped. */
  async tick() {
    if (this.ticking || !this.client) return;
    this.ticking = true;
    try {
      await this.recoverExpiredLeases();
      await this.handleCancellations();
      await this.db.query(`UPDATE translation_jobs SET status='running', started_at=COALESCE(started_at, now()), updated_at=now() WHERE status='queued'`);
      await this.claimInteractiveBatches();
      await this.advanceMessageBatches();
      await this.finalizeJobs();
    } finally {
      this.ticking = false;
    }
  }

  /** Test/maintenance helper: runs until no job has work left (or the guard trips). */
  async drain(maxTicks = 500) {
    for (let i = 0; i < maxTicks; i++) {
      await this.tick();
      await Promise.allSettled([...this.inFlight.values()].map((f) => f.done));
      const busy = await this.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM translation_jobs WHERE status IN ('queued','running','cancel_requested')`,
      );
      if (!busy?.n && !this.inFlight.size) return;
    }
    throw new Error('translation worker did not drain');
  }

  // ------------------------------------------------------------------ scheduling

  private leaseMs() {
    return this.config.timeoutMs * (this.config.maxRetries + 1) + 60_000 * this.config.maxRetries + 60_000;
  }

  private async recoverExpiredLeases() {
    const running = [...this.inFlight.keys()];
    const rows = await this.db.query<{ id: number }>(
      `UPDATE translation_job_batches SET status='pending', lease_until=NULL
       WHERE status='running' AND lease_until < now() AND NOT (id = ANY($1::int[])) RETURNING id`,
      [running],
    );
    if (rows.length) this.log.warn({ batches: rows.map((r) => r.id) }, 'recovered translation batches whose lease expired');
  }

  private async claimInteractiveBatches() {
    const free = this.config.concurrency - this.inFlight.size;
    if (free <= 0 || this.stopping) return;
    const claimed = await this.db.query<{ id: number; job_id: number }>(
      `UPDATE translation_job_batches b SET status='running', attempts=b.attempts+1, started_at=COALESCE(b.started_at, now()),
              lease_until = now() + ($1::int * interval '1 millisecond')
       WHERE b.id IN (
         SELECT b2.id FROM translation_job_batches b2 JOIN translation_jobs j ON j.id=b2.job_id
         WHERE b2.status='pending' AND j.status='running' AND j.mode='interactive'
           AND (b2.next_attempt_at IS NULL OR b2.next_attempt_at <= now())
         ORDER BY b2.job_id, b2.id LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING b.id, b.job_id`,
      [this.leaseMs(), free],
    );
    for (const b of claimed) {
      const controller = new AbortController();
      const done = this.runInteractiveBatch(b.id, b.job_id, controller.signal)
        .catch((err) => this.log.error({ err, batchId: b.id }, 'translation batch crashed'))
        .finally(() => this.inFlight.delete(b.id));
      this.inFlight.set(b.id, { jobId: b.job_id, controller, done });
    }
  }

  private async handleCancellations() {
    const jobs = await this.db.query<JobRow>(`SELECT * FROM translation_jobs WHERE status='cancel_requested'`);
    for (const job of jobs) {
      const mine = [...this.inFlight.values()].filter((f) => f.jobId === job.id);
      for (const f of mine) f.controller.abort();
      if (mine.length) continue; // wait for in-flight requests to unwind; next tick finishes the cancel
      if (job.anthropic_batch_id && job.mode === 'message_batches') {
        await this.client!.cancelBatch(job.anthropic_batch_id).catch((err) => this.log.warn({ err, jobId: job.id }, 'could not cancel message batch'));
      }
      await this.db.tx(async (q) => {
        await q.query(`UPDATE translation_job_batches SET status='cancelled', lease_until=NULL WHERE job_id=$1 AND status IN ('pending','running','submitted')`, [job.id]);
        await q.query(`UPDATE translation_jobs SET status='cancelled', finished_at=now(), updated_at=now() WHERE id=$1`, [job.id]);
        await audit(q, job.created_by, { action: 'ai.job_cancelled', resourceType: 'translation_job', resourceId: job.id, languageId: job.target_language_id });
      });
      this.log.info({ jobId: job.id }, 'translation job cancelled');
    }
  }

  private async finalizeJobs() {
    const done = await this.db.query<JobRow>(
      `SELECT j.* FROM translation_jobs j WHERE j.status='running'
       AND NOT EXISTS (SELECT 1 FROM translation_job_batches b WHERE b.job_id=j.id AND b.status IN ('pending','running','submitted'))`,
    );
    for (const job of done) {
      if ([...this.inFlight.values()].some((f) => f.jobId === job.id)) continue;
      const counts = Object.fromEntries(
        (await this.db.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM translation_job_items WHERE job_id=$1 GROUP BY status', [job.id])).map((r) => [r.status, r.n]),
      ) as Record<string, number>;
      const failed = (counts.failed ?? 0) + (counts.pending ?? 0);
      // Skipped keys (empty source, changed meanwhile) are not failures, but they aren't progress either.
      const status = failed === 0 ? 'completed' : (counts.translated ?? 0) > 0 ? 'completed_with_errors' : 'failed';
      const reasons = await this.db.query<{ reason: string; n: number }>(
        `SELECT reason, count(*)::int AS n FROM translation_job_items WHERE job_id=$1 AND status='failed' GROUP BY reason ORDER BY n DESC LIMIT 5`,
        [job.id],
      );
      const summary = reasons.map((r) => `${r.n}× ${r.reason}`).join(', ');
      await this.db.tx(async (q) => {
        await q.query(`UPDATE translation_job_items SET status='failed', reason='not_processed', error='The key was not processed' WHERE job_id=$1 AND status='pending'`, [job.id]);
        await q.query(`UPDATE translation_jobs SET status=$2, error_summary=$3, finished_at=now(), updated_at=now() WHERE id=$1`, [job.id, status, summary]);
        await audit(q, job.created_by, { action: 'ai.job_finished', resourceType: 'translation_job', resourceId: job.id, languageId: job.target_language_id, after: { status, counts } });
      });
      this.log.info({ jobId: job.id, status, counts }, 'translation job finished');
    }
  }

  // ------------------------------------------------------------------ one batch, interactive

  private async runInteractiveBatch(batchId: number, jobId: number, signal: AbortSignal) {
    const job = (await this.db.one<JobRow>('SELECT * FROM translation_jobs WHERE id=$1', [jobId]))!;
    const items = await this.db.query<ItemRow>(`SELECT id, key_id, source_text, base_version, attempts FROM translation_job_items WHERE batch_id=$1 AND status='pending' ORDER BY id`, [batchId]);
    if (!items.length) {
      await this.db.query(`UPDATE translation_job_batches SET status='done', finished_at=now(), lease_until=NULL WHERE id=$1`, [batchId]);
      return;
    }
    const { request, rules } = await this.buildRequest(job, items);
    await this.db.query('UPDATE translation_job_items SET attempts=attempts+1, updated_at=now() WHERE id = ANY($1::int[])', [items.map((i) => i.id)]);
    let reply: ModelReply;
    try {
      reply = await withRetry(() => this.client!.translate(buildParams(this.config, job.model, request), signal), {
        maxRetries: this.config.maxRetries,
        signal,
        baseMs: this.retryBaseMs,
        onRetry: (attempt, e, waitMs) => {
          this.log.warn({ jobId, batchId, attempt, code: e.code, waitMs }, 'retrying translation request');
          void this.db.query('UPDATE translation_jobs SET api_requests=api_requests+1 WHERE id=$1', [jobId]);
        },
      });
    } catch (err) {
      const e = classifyError(err);
      if (e.code === 'aborted') {
        // Stopping or cancelling: the batch goes back to the queue untouched.
        await this.db.query(`UPDATE translation_job_batches SET status='pending', lease_until=NULL, attempts=GREATEST(attempts-1,0) WHERE id=$1 AND status='running'`, [batchId]);
        await this.db.query('UPDATE translation_job_items SET attempts=GREATEST(attempts-1,0) WHERE id = ANY($1::int[])', [items.map((i) => i.id)]);
        return;
      }
      this.log.error({ jobId, batchId, code: e.code }, `translation request failed: ${e.message}`);
      await this.failBatch(batchId, items, e.code, e.message);
      return;
    }
    await this.applyReply(job, batchId, items, reply, rules);
  }

  /** Records usage, then validates and writes a reply (shared by interactive and Message Batches results). */
  private async applyReply(job: JobRow, batchId: number, items: ItemRow[], reply: ModelReply, rules: PlaceholderRule[]) {
    await this.db.query(
      `UPDATE translation_jobs SET input_tokens=input_tokens+$2, output_tokens=output_tokens+$3, cache_read_tokens=cache_read_tokens+$4, api_requests=api_requests+1, updated_at=now() WHERE id=$1`,
      [job.id, reply.usage.input, reply.usage.output, reply.usage.cacheRead],
    );
    await this.db.query('UPDATE translation_job_batches SET input_tokens=input_tokens+$2, output_tokens=output_tokens+$3 WHERE id=$1', [batchId, reply.usage.input, reply.usage.output]);

    if (reply.stopReason === 'refusal') {
      await this.failItems(batchId, items, 'refused', 'The model declined to translate this batch');
      return;
    }
    if (reply.stopReason === 'max_tokens') {
      if (items.length > 1) {
        // Output ran out of room: split the batch in two and try again.
        const half = Math.ceil(items.length / 2);
        await this.db.tx(async (q) => {
          await q.query(`UPDATE translation_job_batches SET status='split', finished_at=now(), lease_until=NULL WHERE id=$1`, [batchId]);
          await batchPendingItems(q, job.id, items.slice(0, half).map((i) => i.id), half);
          await batchPendingItems(q, job.id, items.slice(half).map((i) => i.id), half);
        });
        return;
      }
      await this.failItems(batchId, items, 'output_too_long', 'The translation did not fit in the output limit (AI_MAX_OUTPUT_TOKENS)');
      return;
    }

    const requested = items.map((i) => ({ id: String(i.key_id), source: i.source_text }));
    const result = validateReply(reply.text, requested, rules);
    if (result.unexpected.length) this.log.warn({ jobId: job.id, batchId, ids: result.unexpected.slice(0, 20) }, 'model returned unexpected or duplicate ids (ignored)');
    if (result.malformed) {
      this.log.warn({ jobId: job.id, batchId }, result.malformed);
      const outcomes: ItemOutcome[] = items.map((i) => ({ id: String(i.key_id), ok: false, reason: 'malformed_reply', error: result.malformed!, retryable: true }));
      await this.settle(job, batchId, items, outcomes);
      return;
    }
    await this.settle(job, batchId, items, result.outcomes);
  }

  /** Writes valid results, re-queues retryable failures (new batch) and fails the rest. */
  private async settle(job: JobRow, batchId: number, items: ItemRow[], outcomes: ItemOutcome[]) {
    const byKey = new Map(items.map((i) => [String(i.key_id), i]));
    const ok = outcomes.filter((o): o is Extract<ItemOutcome, { ok: true }> => o.ok);
    const bad = outcomes.filter((o): o is Extract<ItemOutcome, { ok: false }> => !o.ok);
    const retry = bad.filter((o) => o.retryable && byKey.get(o.id)!.attempts + 1 < this.config.maxItemAttempts);
    const final = bad.filter((o) => !retry.includes(o));

    const current = await this.db.one<{ status: string }>('SELECT status FROM translation_jobs WHERE id=$1', [job.id]);
    if (current?.status !== 'running') {
      // Cancelled while the request was running: nothing is written, the keys stay pending.
      await this.db.query(`UPDATE translation_job_batches SET status='cancelled', lease_until=NULL, finished_at=now() WHERE id=$1`, [batchId]);
      return;
    }
    await this.db.tx(async (q) => {
      if (ok.length) await writeTranslations(q, job, ok.map((o) => ({ item: byKey.get(o.id)!, value: o.value })));
      for (const o of final) {
        await q.query(`UPDATE translation_job_items SET status='failed', reason=$2, error=$3, updated_at=now() WHERE id=$1`, [byKey.get(o.id)!.id, o.reason, o.error.slice(0, 500)]);
      }
      if (retry.length) await batchPendingItems(q, job.id, retry.map((o) => byKey.get(o.id)!.id), job.batch_size);
      await q.query(`UPDATE translation_job_batches SET status='done', finished_at=now(), lease_until=NULL, error=$2 WHERE id=$1`, [
        batchId,
        bad.length ? `${bad.length} key(s) failed validation${retry.length ? `, ${retry.length} re-queued` : ''}` : '',
      ]);
    });
  }

  private async failItems(batchId: number, items: ItemRow[], reason: string, error: string) {
    await this.db.tx(async (q) => {
      await q.query(`UPDATE translation_job_items SET status='failed', reason=$2, error=$3, updated_at=now() WHERE id = ANY($1::int[]) AND status='pending'`, [items.map((i) => i.id), reason, error]);
      await q.query(`UPDATE translation_job_batches SET status='done', finished_at=now(), lease_until=NULL, error=$2 WHERE id=$1`, [batchId, error]);
    });
  }

  private async failBatch(batchId: number, items: ItemRow[], reason: string, error: string) {
    await this.db.tx(async (q) => {
      await q.query(`UPDATE translation_job_items SET status='failed', reason=$2, error=$3, updated_at=now() WHERE id = ANY($1::int[]) AND status='pending'`, [items.map((i) => i.id), reason, error]);
      await q.query(`UPDATE translation_job_batches SET status='failed', finished_at=now(), lease_until=NULL, error=$2 WHERE id=$1`, [batchId, error]);
    });
  }

  private async buildRequest(job: JobRow, items: ItemRow[]): Promise<{ request: TranslationRequest; rules: PlaceholderRule[] }> {
    const langs = await this.db.query<{ id: number; code: string; name: string; direction: string }>('SELECT id, code, name, direction FROM languages WHERE id = ANY($1::int[])', [
      [job.source_language_id, job.target_language_id],
    ]);
    const ctx = await this.db.query<{ id: number; description: string; max_length: number | null; keys: string[]; platforms: string[] }>(
      `SELECT k.id, k.description, k.max_length,
              ARRAY(SELECT DISTINCT kp.identifier FROM key_platforms kp WHERE kp.key_id=k.id) AS keys,
              ARRAY(SELECT p.name FROM key_platforms kp JOIN platforms p ON p.id=kp.platform_id WHERE kp.key_id=k.id ORDER BY p.sort_order) AS platforms
       FROM translation_keys k WHERE k.id = ANY($1::int[])`,
      [items.map((i) => i.key_id)],
    );
    const settings = Object.fromEntries(
      (await this.db.query<{ key: string; value: unknown }>(`SELECT key, value FROM settings WHERE key IN ('translator_guidelines','placeholder_rules')`)).map((r) => [r.key, r.value]),
    );
    const byId = new Map(ctx.map((c) => [c.id, c]));
    const lang = (id: number) => langs.find((l) => l.id === id)!;
    return {
      request: {
        source: lang(job.source_language_id),
        target: lang(job.target_language_id),
        guidelines: typeof settings.translator_guidelines === 'string' ? settings.translator_guidelines : undefined,
        items: items.map((i) => {
          const c = byId.get(i.key_id);
          return { id: String(i.key_id), keys: c?.keys ?? [], text: i.source_text, note: c?.description || undefined, maxLength: c?.max_length, platforms: c?.platforms };
        }),
      },
      rules: Array.isArray(settings.placeholder_rules) ? (settings.placeholder_rules as PlaceholderRule[]) : DEFAULT_PLACEHOLDER_RULES,
    };
  }

  // ------------------------------------------------------------------ Message Batches API

  /**
   * Large jobs (≥ AI_MESSAGE_BATCH_MIN_KEYS) are sent as one Message Batch: half price, asynchronous
   * (usually under an hour, at most 24 h). The batch id is stored, so polling survives restarts.
   */
  private async advanceMessageBatches() {
    const jobs = await this.db.query<JobRow>(`SELECT * FROM translation_jobs WHERE status='running' AND mode='message_batches'`);
    for (const job of jobs) {
      try {
        if (!job.anthropic_batch_id) await this.submitMessageBatch(job);
        else if (!job.batch_polled_at || Date.now() - new Date(job.batch_polled_at).getTime() >= this.config.batchPollMs) await this.pollMessageBatch(job);
      } catch (err) {
        const e = classifyError(err);
        this.log.error({ jobId: job.id, code: e.code }, `message batch step failed: ${e.message}`);
        await this.db.query('UPDATE translation_jobs SET batch_polled_at=now(), error_summary=$2 WHERE id=$1', [job.id, e.message.slice(0, 300)]);
        if (!e.retryable) {
          // Permanent problem (bad key, bad model): fall back to interactive requests, which report per-batch errors.
          await this.db.query(`UPDATE translation_job_batches SET status='pending' WHERE job_id=$1 AND status='submitted'`, [job.id]);
          await this.db.query(`UPDATE translation_jobs SET mode='interactive', anthropic_batch_id=NULL WHERE id=$1`, [job.id]);
        }
      }
    }
  }

  private async submitMessageBatch(job: JobRow) {
    const batches = await this.db.query<{ id: number }>(`SELECT id FROM translation_job_batches WHERE job_id=$1 AND status='pending' ORDER BY id`, [job.id]);
    const requests: Parameters<TranslatorClient['submitBatch']>[0] = [];
    for (const b of batches) {
      const items = await this.db.query<ItemRow>(`SELECT id, key_id, source_text, base_version, attempts FROM translation_job_items WHERE batch_id=$1 AND status='pending' ORDER BY id`, [b.id]);
      if (!items.length) continue;
      const { request } = await this.buildRequest(job, items);
      requests.push({ customId: `b${b.id}`, params: buildParams(this.config, job.model, request) });
    }
    if (!requests.length) {
      await this.db.query(`UPDATE translation_jobs SET mode='interactive' WHERE id=$1`, [job.id]);
      return;
    }
    const batchApiId = await withRetry(() => this.client!.submitBatch(requests), { maxRetries: this.config.maxRetries, baseMs: this.retryBaseMs });
    await this.db.tx(async (q) => {
      await q.query(`UPDATE translation_job_batches SET status='submitted', attempts=attempts+1, started_at=now() WHERE id = ANY($1::int[])`, [requests.map((r) => Number(r.customId.slice(1)))]);
      await q.query(`UPDATE translation_job_items SET attempts=attempts+1 WHERE batch_id = ANY($1::int[]) AND status='pending'`, [requests.map((r) => Number(r.customId.slice(1)))]);
      await q.query('UPDATE translation_jobs SET anthropic_batch_id=$2, batch_polled_at=now(), updated_at=now() WHERE id=$1', [job.id, batchApiId]);
    });
    this.log.info({ jobId: job.id, requests: requests.length, batchApiId }, 'submitted message batch');
  }

  private async pollMessageBatch(job: JobRow) {
    const status = await withRetry(() => this.client!.batchStatus(job.anthropic_batch_id!), { maxRetries: this.config.maxRetries, baseMs: this.retryBaseMs });
    await this.db.query('UPDATE translation_jobs SET batch_polled_at=now() WHERE id=$1', [job.id]);
    if (status !== 'ended') return;
    const { rules } = await this.buildRequest(job, []);
    for await (const r of this.client!.batchResults(job.anthropic_batch_id!)) {
      const batchId = Number(r.customId.replace(/^b/, ''));
      const batch = await this.db.one<{ status: string }>('SELECT status FROM translation_job_batches WHERE id=$1 AND job_id=$2', [batchId, job.id]);
      if (batch?.status !== 'submitted') continue; // unknown id, or already handled before a restart
      const items = await this.db.query<ItemRow>(`SELECT id, key_id, source_text, base_version, attempts FROM translation_job_items WHERE batch_id=$1 AND status='pending' ORDER BY id`, [batchId]);
      if (r.type === 'succeeded') {
        await this.db.query(`UPDATE translation_job_batches SET status='running' WHERE id=$1`, [batchId]);
        await this.applyReply(job, batchId, items, r.reply, rules);
      } else {
        await this.failBatch(batchId, items, `batch_${r.type}`, r.error);
      }
    }
    // Requests missing from the results, then anything re-queued (validation retries, splits) runs interactively.
    await this.db.query(`UPDATE translation_job_items SET status='failed', reason='missing_result', error='No result was returned for this request' WHERE batch_id IN (SELECT id FROM translation_job_batches WHERE job_id=$1 AND status='submitted') AND status='pending'`, [job.id]);
    await this.db.query(`UPDATE translation_job_batches SET status='failed', error='No result returned' WHERE job_id=$1 AND status='submitted'`, [job.id]);
    await this.db.query(`UPDATE translation_jobs SET mode='interactive', updated_at=now() WHERE id=$1`, [job.id]);
  }
}

/**
 * Writes validated translations without overwriting anything that changed after the job started:
 * the source text must still match what was translated, and the target row must still be at the
 * version recorded when the job was created. Two bulk statements per batch keep content-version
 * bumps to one per batch (and none for identical values).
 */
export async function writeTranslations(q: Queryable, job: Pick<JobRow, 'id' | 'source_language_id' | 'target_language_id' | 'result_status' | 'created_by'>, results: { item: ItemRow; value: string }[]) {
  const srcLang = await q.one<{ is_source: boolean }>('SELECT is_source FROM languages WHERE id=$1', [job.source_language_id]);
  const keyIds = results.map((r) => r.item.key_id);
  const current = await q.query<{ id: number; archived: boolean; source: string; version: number | null }>(
    `SELECT k.id, k.is_archived AS archived,
            ${srcLang?.is_source ? 'k.source_text' : `CASE WHEN s.status IS DISTINCT FROM 'missing' THEN COALESCE(s.value,'') ELSE '' END`} AS source,
            t.version
     FROM translation_keys k
     LEFT JOIN translations t ON t.key_id=k.id AND t.language_id=$2
     ${srcLang?.is_source ? '' : 'LEFT JOIN translations s ON s.key_id=k.id AND s.language_id=$3'}
     WHERE k.id = ANY($1::int[])`,
    srcLang?.is_source ? [keyIds, job.target_language_id] : [keyIds, job.target_language_id, job.source_language_id],
  );
  const now = new Map(current.map((c) => [c.id, c]));
  const skip: { id: number; reason: string; error: string }[] = [];
  const updates: typeof results = [];
  const inserts: typeof results = [];
  for (const r of results) {
    const c = now.get(r.item.key_id);
    if (!c || c.archived) skip.push({ id: r.item.id, reason: 'key_archived', error: 'The key was archived or deleted while the job ran' });
    else if (c.source !== r.item.source_text) skip.push({ id: r.item.id, reason: 'source_changed', error: 'The source text changed while the job ran; run the job again for the new text' });
    else if ((c.version ?? null) !== (r.item.base_version ?? null)) skip.push({ id: r.item.id, reason: 'changed_meanwhile', error: 'Someone edited this translation while the job ran; it was not overwritten' });
    else if (c.version === null) inserts.push(r);
    else updates.push(r);
  }
  const written = new Map<number, number>(); // key_id -> translation id
  if (updates.length) {
    const rows = await q.query<{ id: number; key_id: number }>(
      `UPDATE translations t SET value=u.v, status=$4, version=t.version+1, updated_by=$5, updated_at=now(), source_changed=false,
              approved_by=NULL, approved_at=NULL, reviewed_by=NULL, reviewed_at=NULL
       FROM unnest($1::int[], $2::int[], $3::text[]) AS u(k, bv, v)
       WHERE t.key_id=u.k AND t.language_id=$6 AND t.version=u.bv
       RETURNING t.id, t.key_id`,
      [updates.map((r) => r.item.key_id), updates.map((r) => r.item.base_version), updates.map((r) => r.value), job.result_status, job.created_by, job.target_language_id],
    );
    for (const r of rows) written.set(r.key_id, r.id);
  }
  if (inserts.length) {
    const rows = await q.query<{ id: number; key_id: number }>(
      `INSERT INTO translations (key_id, language_id, value, status, created_by, updated_by)
       SELECT k, $3, v, $4, $5, $5 FROM unnest($1::int[], $2::text[]) AS u(k, v)
       ON CONFLICT (key_id, language_id) DO NOTHING
       RETURNING id, key_id`,
      [inserts.map((r) => r.item.key_id), inserts.map((r) => r.value), job.target_language_id, job.result_status, job.created_by],
    );
    for (const r of rows) written.set(r.key_id, r.id);
  }
  for (const r of [...updates, ...inserts]) {
    if (!written.has(r.item.key_id)) skip.push({ id: r.item.id, reason: 'changed_meanwhile', error: 'Someone edited this translation while the job ran; it was not overwritten' });
  }
  const done = [...updates, ...inserts].filter((r) => written.has(r.item.key_id));
  if (done.length) {
    await q.query(
      `INSERT INTO translation_history (translation_id, value, status, changed_by, reason)
       SELECT i, v, $3, $4, 'ai' FROM unnest($1::int[], $2::text[]) AS u(i, v)`,
      [done.map((r) => written.get(r.item.key_id)), done.map((r) => r.value), job.result_status, job.created_by],
    );
    await q.query(
      `UPDATE translation_job_items i SET status='translated', reason='', error='', result_value=u.v, updated_at=now()
       FROM unnest($1::int[], $2::text[]) AS u(id, v) WHERE i.id=u.id`,
      [done.map((r) => r.item.id), done.map((r) => r.value)],
    );
  }
  for (const s of skip) {
    await q.query(`UPDATE translation_job_items SET status='skipped', reason=$2, error=$3, updated_at=now() WHERE id=$1`, [s.id, s.reason, s.error]);
  }
  return { written: done.length, skipped: skip.length };
}
