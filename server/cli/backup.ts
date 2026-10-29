// Writes a pg_dump backup now: npm run db:backup
import { loadConfig } from '../config.js';
import { writeBackup } from '../db/backup.js';
import { MISSING_DATABASE_URL } from '../db/client.js';

const config = loadConfig();
if (!config.databaseUrl) {
  console.error(MISSING_DATABASE_URL);
  process.exit(1);
}
try {
  console.log(`Backup written: ${await writeBackup(config.databaseUrl, config.backupDir, config.backupKeep, config.pgHome)}`);
} catch (err) {
  const e = err as { code?: string; message?: string; stderr?: string };
  console.error(e.code === 'ENOENT' ? 'pg_dump was not found. Install the PostgreSQL client tools or set PG_HOME.' : (e.stderr || e.message));
  process.exit(1);
}
