import Anthropic from '@anthropic-ai/sdk';
import type { AiConfig } from './config.js';

/** What the worker needs from a model response; usage feeds the job's token totals. */
export interface ModelReply {
  text: string;
  stopReason: string | null;
  model: string;
  usage: { input: number; output: number; cacheRead: number };
}

export type BatchResult =
  | { customId: string; type: 'succeeded'; reply: ModelReply }
  | { customId: string; type: 'errored' | 'canceled' | 'expired'; error: string };

/**
 * The only surface the worker uses. The Anthropic implementation lives below; tests pass a fake.
 * `translate` makes one attempt — retries are the caller's job (see withRetry).
 */
export interface TranslatorClient {
  translate(params: Anthropic.MessageCreateParamsNonStreaming, signal?: AbortSignal): Promise<ModelReply>;
  submitBatch(requests: { customId: string; params: Anthropic.MessageCreateParamsNonStreaming }[]): Promise<string>;
  batchStatus(id: string): Promise<'in_progress' | 'canceling' | 'ended'>;
  batchResults(id: string): AsyncIterable<BatchResult>;
  cancelBatch(id: string): Promise<void>;
}

function replyOf(msg: { content: { type: string; text?: string }[]; stop_reason: string | null; model: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null } }): ModelReply {
  return {
    text: msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join(''),
    stopReason: msg.stop_reason,
    model: msg.model,
    usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens, cacheRead: msg.usage.cache_read_input_tokens ?? 0 },
  };
}

/** Models that accept the server-side `fallbacks: "default"` refusal routing. */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export function createClaudeClient(config: AiConfig): TranslatorClient | null {
  if (!config.apiKey) return null;
  // SDK retries are off: withRetry owns backoff so attempts are counted and logged in one place.
  const client = new Anthropic({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 0 });
  return {
    async translate(params, signal) {
      if (config.refusalFallback && FALLBACK_MODELS.has(params.model)) {
        const msg = await client.beta.messages.create(
          { ...(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming), betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
          { signal },
        );
        return replyOf(msg as never);
      }
      return replyOf((await client.messages.create(params, { signal })) as never);
    },
    async submitBatch(requests) {
      const batch = await client.messages.batches.create({ requests: requests.map((r) => ({ custom_id: r.customId, params: r.params })) });
      return batch.id;
    },
    async batchStatus(id) {
      return (await client.messages.batches.retrieve(id)).processing_status;
    },
    async *batchResults(id) {
      for await (const r of await client.messages.batches.results(id)) {
        if (r.result.type === 'succeeded') yield { customId: r.custom_id, type: 'succeeded', reply: replyOf(r.result.message as never) };
        else if (r.result.type === 'errored') yield { customId: r.custom_id, type: 'errored', error: `${r.result.error.error.type}: ${r.result.error.error.message}` };
        else yield { customId: r.custom_id, type: r.result.type, error: `Request ${r.result.type}` };
      }
    },
    async cancelBatch(id) {
      await client.messages.batches.cancel(id);
    },
  };
}

// ------------------------------------------------------------------ errors and retries

export interface ClassifiedError {
  retryable: boolean;
  /** Short machine code stored on failed items/batches. */
  code: string;
  message: string;
  retryAfterMs?: number;
}

/** Sorts SDK errors into retryable (rate limits, overload, 5xx, network, timeouts) and permanent ones. */
export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof Anthropic.APIUserAbortError) return { retryable: false, code: 'aborted', message: 'Request was cancelled' };
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { retryable: true, code: 'timeout', message: 'The request timed out' };
  if (err instanceof Anthropic.APIConnectionError) return { retryable: true, code: 'network', message: 'Could not reach the Anthropic API' };
  if (err instanceof Anthropic.RateLimitError) {
    const ra = Number(err.headers?.get?.('retry-after'));
    return { retryable: true, code: 'rate_limited', message: 'Rate limited by the Anthropic API', retryAfterMs: Number.isFinite(ra) ? ra * 1000 : undefined };
  }
  if (err instanceof Anthropic.AuthenticationError) return { retryable: false, code: 'auth', message: 'The Anthropic API key was rejected (check ANTHROPIC_API_KEY)' };
  if (err instanceof Anthropic.PermissionDeniedError) return { retryable: false, code: 'permission', message: 'The API key may not use this model or feature' };
  if (err instanceof Anthropic.NotFoundError) return { retryable: false, code: 'not_found', message: 'Unknown model or resource (check ANTHROPIC_MODEL)' };
  if (err instanceof Anthropic.BadRequestError) return { retryable: false, code: 'bad_request', message: `The API rejected the request: ${err.message}` };
  if (err instanceof Anthropic.InternalServerError) return { retryable: true, code: err.status === 529 ? 'overloaded' : 'server_error', message: `Anthropic API error ${err.status}` };
  if (err instanceof Anthropic.APIError) {
    const s = err.status ?? 0;
    return { retryable: s === 408 || s === 409 || s >= 500, code: `http_${s}`, message: err.message };
  }
  return { retryable: false, code: 'internal', message: err instanceof Error ? err.message : String(err) };
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Anthropic.APIUserAbortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new Anthropic.APIUserAbortError())), { once: true });
  });

/** Full-jitter exponential backoff: random(0, min(cap, base·2^attempt)), never below retry-after. */
export function backoffMs(attempt: number, retryAfterMs?: number, baseMs = 1000, capMs = 60_000) {
  const jitter = Math.random() * Math.min(capMs, baseMs * 2 ** attempt);
  return Math.max(retryAfterMs ?? 0, jitter);
}

/**
 * Runs fn, retrying retryable failures up to maxRetries times. Permanent errors are thrown at once.
 * onRetry lets the caller log and count each retry.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; signal?: AbortSignal; baseMs?: number; onRetry?: (attempt: number, e: ClassifiedError, waitMs: number) => void },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = classifyError(err);
      if (!e.retryable || attempt >= opts.maxRetries || opts.signal?.aborted) throw err;
      const wait = backoffMs(attempt, e.retryAfterMs, opts.baseMs);
      opts.onRetry?.(attempt + 1, e, wait);
      await sleep(wait, opts.signal);
    }
  }
}
