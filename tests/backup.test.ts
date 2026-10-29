import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgTool, restoreBackup, writeBackup } from '../server/db/backup.js';
import { createEnv, type TestEnv } from './helpers.js';

const hasPgDump = (() => {
  try {
    execFileSync(pgTool('pg_dump'), ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const dir = mkdtempSync(join(tmpdir(), 'glotta-backup-'));
let env: TestEnv;
beforeAll(async () => {
  if (hasPgDump) env = await createEnv();
});
afterAll(async () => {
  await env?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasPgDump)('pg_dump backups', () => {
  it('writes restorable backups and keeps only the newest N', async () => {
    await env.db.query(`INSERT INTO translation_keys (namespace, identifier, source_text) VALUES ('shared','backup_probe','Hello')`);
    for (let i = 0; i < 3; i++) {
      await writeBackup(env.url, dir, 2);
      await new Promise((r) => setTimeout(r, 1100)); // file names have one-second resolution
    }
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    expect(files.every((f) => /^glotta-\d{8}-\d{6}\.dump$/.test(f))).toBe(true);

    // Change the data, then restore: the backup's contents come back.
    await env.db.query(`UPDATE translation_keys SET source_text='Changed' WHERE identifier='backup_probe'`);
    await env.db.query(`INSERT INTO translation_keys (namespace, identifier, source_text) VALUES ('shared','after_backup','x')`);
    await restoreBackup(env.url, join(dir, files[1]));
    const rows = await env.db.query<{ identifier: string; source_text: string }>(`SELECT identifier, source_text FROM translation_keys WHERE identifier IN ('backup_probe','after_backup')`);
    expect(rows).toEqual([{ identifier: 'backup_probe', source_text: 'Hello' }]);
  }, 60_000);
});
