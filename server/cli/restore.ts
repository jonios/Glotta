// Restores a pg_dump backup: npm run db:restore -- .data/backups/glotta-20261029-101500.dump
// Stop the app first. Everything in the database is replaced by the backup's contents.
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { restoreBackup } from '../db/backup.js';
import { MISSING_DATABASE_URL } from '../db/client.js';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('Usage: npm run db:restore -- <backup .dump file>');
  process.exit(1);
}
const config = loadConfig();
if (!config.databaseUrl) {
  console.error(MISSING_DATABASE_URL);
  process.exit(1);
}
try {
  await restoreBackup(config.databaseUrl, file, config.pgHome);
  console.log(`Restored ${file}`);
} catch (err) {
  const e = err as { code?: string; message?: string; stderr?: string };
  console.error(e.code === 'ENOENT' ? 'pg_restore was not found. Install the PostgreSQL client tools or set PG_HOME.' : (e.stderr || e.message));
  process.exit(1);
}
