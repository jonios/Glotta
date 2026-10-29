import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, migrate } from './db/client.js';
import { scheduleBackups } from './db/backup.js';
import { seedReferenceData } from './bootstrap.js';
import { loadAiConfig } from './ai/config.js';
import { createClaudeClient } from './ai/claude.js';
import { TranslationWorker } from './ai/worker.js';
import type { AiRuntime } from './ai/routes.js';

const config = loadConfig();
let db: Awaited<ReturnType<typeof createDb>>;
try {
  db = await createDb({ url: config.databaseUrl });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
const applied = await migrate(db);
await seedReferenceData(db);
const aiConfig = loadAiConfig();
const ai: AiRuntime = { config: aiConfig, client: createClaudeClient(aiConfig), worker: null };
const app = await buildApp({ db, config, ai });
if (applied.length) app.log.info({ applied }, 'migrations applied');
let stopBackups = () => {};
if (config.backupIntervalHours > 0) {
  stopBackups = scheduleBackups(config.databaseUrl!, { dir: config.backupDir, intervalHours: config.backupIntervalHours, keep: config.backupKeep, pgHome: config.pgHome }, app.log);
}
await app.listen({ port: config.port, host: config.host });

// AI translation worker: runs inside the API process and resumes unfinished jobs from the database
// on start. Its state lives in PostgreSQL (leases, retries), so a restart loses nothing.
if (!ai.client) app.log.info('AI translation is off: set ANTHROPIC_API_KEY to enable Auto Translate');
else if (aiConfig.workerEnabled) {
  ai.worker = new TranslationWorker(db, ai.client, aiConfig, app.log);
  ai.worker.start();
}

// Shut down once: stop the worker (its batches go back to the queue), finish in-flight requests,
// close the connection pool, and only force-exit if that hangs.
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    app.log.info({ sig }, 'shutting down');
    setTimeout(() => {
      app.log.error('shutdown timed out; exiting without closing the database');
      process.exit(1);
    }, 12_000).unref();
    stopBackups();
    await ai.worker?.stop();
    await app.close();
    await db.close();
    process.exit(0);
  });
}
