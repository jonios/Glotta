import 'dotenv/config';

export type ModelTier = 'standard' | 'economy';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AiConfig {
  /** True when an Anthropic credential is present. The key itself never leaves this module's caller. */
  configured: boolean;
  apiKey?: string;
  /** Models by tier. Admins choose a tier, never a model name. */
  models: Record<ModelTier, string | undefined>;
  effort: Effort | null;
  /** Server-side refusal fallbacks on interactive requests ("default" routing), off with AI_REFUSAL_FALLBACK=off. */
  refusalFallback: boolean;
  batchSize: number;
  maxBatchSize: number;
  concurrency: number;
  maxRetries: number;
  maxItemAttempts: number;
  timeoutMs: number;
  maxOutputTokens: number;
  maxKeysPerJob: number;
  /** Jobs with at least this many keys use the Message Batches API (50% price, asynchronous). 0 = never. */
  messageBatchMinKeys: number;
  batchPollMs: number;
  pollMs: number;
  workerEnabled: boolean;
  /** Max job creations per minute per client (protects against accidental expensive bursts). */
  jobsPerMinute: number;
  /** Optional prices in USD per million tokens for cost estimates; unset = no estimate shown. */
  prices: Record<ModelTier, { input: number; output: number } | null>;
}

const int = (v: string | undefined, def: number, min: number, max: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const price = (input?: string, output?: string) => {
  const i = Number(input);
  const o = Number(output);
  return input && output && Number.isFinite(i) && Number.isFinite(o) && i >= 0 && o >= 0 ? { input: i, output: o } : null;
};
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  const maxBatchSize = int(env.AI_MAX_BATCH_SIZE, 100, 1, 200);
  const effort = (env.AI_EFFORT ?? 'low').trim();
  return {
    configured: !!apiKey,
    apiKey,
    models: {
      standard: env.ANTHROPIC_MODEL?.trim() || 'claude-opus-5-5',
      economy: env.ANTHROPIC_MODEL_ECONOMY?.trim() || undefined,
    },
    effort: EFFORTS.includes(effort as Effort) ? (effort as Effort) : null,
    refusalFallback: (env.AI_REFUSAL_FALLBACK ?? 'default') !== 'off',
    batchSize: Math.min(maxBatchSize, int(env.AI_BATCH_SIZE, 50, 1, 200)),
    maxBatchSize,
    concurrency: int(env.AI_CONCURRENCY, 3, 1, 20),
    maxRetries: int(env.AI_MAX_RETRIES, 4, 0, 10),
    maxItemAttempts: int(env.AI_MAX_ITEM_ATTEMPTS, 2, 1, 5),
    timeoutMs: int(env.AI_TIMEOUT_MS, 180_000, 5_000, 900_000),
    maxOutputTokens: int(env.AI_MAX_OUTPUT_TOKENS, 16_000, 1_000, 64_000),
    maxKeysPerJob: int(env.AI_MAX_KEYS_PER_JOB, 10_000, 1, 200_000),
    messageBatchMinKeys: int(env.AI_MESSAGE_BATCH_MIN_KEYS, 2_000, 0, 1_000_000),
    batchPollMs: int(env.AI_BATCH_POLL_MS, 60_000, 1_000, 3_600_000),
    pollMs: int(env.AI_WORKER_POLL_MS, 2_000, 50, 60_000),
    workerEnabled: (env.AI_WORKER_ENABLED ?? 'true') !== 'false',
    jobsPerMinute: int(env.AI_JOBS_PER_MINUTE, 10, 1, 1000),
    prices: {
      standard: price(env.AI_PRICE_INPUT_PER_MTOK, env.AI_PRICE_OUTPUT_PER_MTOK),
      economy: price(env.AI_ECONOMY_PRICE_INPUT_PER_MTOK, env.AI_ECONOMY_PRICE_OUTPUT_PER_MTOK),
    },
  };
}

/** The model for a tier, falling back to standard when no economy model is configured. */
export function modelFor(config: AiConfig, tier: ModelTier): string {
  return config.models[tier] ?? config.models.standard!;
}
