import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PREFIX = 'glotta-';
const SUFFIX = '.dump';

/** Path of a PostgreSQL client tool: PG_HOME/bin, the portable Windows install used by `npm run pg:init`, or PATH. */
export function pgTool(name: 'pg_dump' | 'pg_restore', pgHome = ''): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  if (pgHome) return join(pgHome, 'bin', exe);
  if (process.platform === 'win32') {
    const portable = join(process.env.LOCALAPPDATA ?? homedir(), 'Programs', 'PostgreSQL17', 'pgsql', 'bin', exe);
    if (existsSync(portable)) return portable;
  }
  return name;
}

/** libpq environment for a connection URL, so the password never appears on a command line. */
export function pgEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const u = new URL(databaseUrl);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
    ...(u.searchParams.get('sslmode') ? { PGSSLMODE: u.searchParams.get('sslmode')! } : {}),
  };
}

/**
 * Writes one pg_dump backup in PostgreSQL's custom format (via a temp file, so a failure never
 * leaves a truncated backup) and prunes the oldest beyond `keep`. Restore with `npm run db:restore`.
 */
export async function writeBackup(databaseUrl: string, dir: string, keep: number, pgHome = ''): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = join(dir, `${PREFIX}${stamp}${SUFFIX}`);
  try {
    await run(pgTool('pg_dump', pgHome), ['--format=custom', '--no-owner', '--file', `${file}.tmp`], { env: pgEnv(databaseUrl) });
  } catch (err) {
    rmSync(`${file}.tmp`, { force: true });
    throw err;
  }
  renameSync(`${file}.tmp`, file);
  const all = readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, old));
  return file;
}

/** Replaces the database's contents with a backup (objects are dropped and recreated in one transaction). */
export async function restoreBackup(databaseUrl: string, file: string, pgHome = ''): Promise<void> {
  await run(pgTool('pg_restore', pgHome), ['--clean', '--if-exists', '--no-owner', '--single-transaction', '--dbname', pgEnv(databaseUrl).PGDATABASE!, file], {
    env: pgEnv(databaseUrl),
  });
}

/** Backs up at startup and then every `intervalHours`. Returns a stop function. */
export function scheduleBackups(
  databaseUrl: string,
  opts: { dir: string; intervalHours: number; keep: number; pgHome: string },
  log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void },
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      log.info({ file: await writeBackup(databaseUrl, opts.dir, opts.keep, opts.pgHome) }, 'database backup written');
    } catch (err) {
      const e = err as { code?: string; message?: string };
      log.error(
        { err: e.code === 'ENOENT' ? 'pg_dump not found' : e.message },
        'database backup failed — install the PostgreSQL client tools or set PG_HOME, or set BACKUP_INTERVAL_HOURS=0',
      );
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, opts.intervalHours * 3_600_000);
  timer.unref();
  return () => clearInterval(timer);
}
