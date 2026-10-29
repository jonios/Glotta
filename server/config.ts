import 'dotenv/config';

export interface AppConfig {
  databaseUrl?: string;
  port: number;
  host: string;
  cookieSecure: boolean;
  sessionTtlHours: number;
  appUrl: string;
  maxUploadMb: number;
  /** Import file uploads per minute per client. */
  uploadsPerMinute: number;
  nodeEnv: string;
  /** Scheduled pg_dump backups: directory, interval in hours (0 disables) and how many to keep. */
  backupDir: string;
  backupIntervalHours: number;
  backupKeep: number;
  /** Folder containing pg_dump / pg_restore (their bin/ parent); empty = use the ones on PATH. */
  pgHome: string;
}

export function loadConfig(env = process.env): AppConfig {
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    port: Number(env.API_PORT || 3001),
    host: env.HOST || '127.0.0.1',
    cookieSecure: (env.COOKIE_SECURE ?? (env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true',
    sessionTtlHours: Number(env.SESSION_TTL_HOURS || 12),
    appUrl: env.APP_URL || 'http://localhost:5173',
    maxUploadMb: Number(env.MAX_UPLOAD_MB || 25),
    uploadsPerMinute: Number(env.IMPORT_UPLOADS_PER_MINUTE || 20),
    nodeEnv: env.NODE_ENV || 'development',
    backupDir: env.BACKUP_DIR || './.data/backups',
    backupIntervalHours: Number(env.BACKUP_INTERVAL_HOURS ?? 24),
    backupKeep: Number(env.BACKUP_KEEP || 14),
    pgHome: env.PG_HOME || '',
  };
}
