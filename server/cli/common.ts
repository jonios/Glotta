import { loadConfig } from '../config.js';
import { createDb, migrate } from '../db/client.js';
import { seedReferenceData } from '../bootstrap.js';

export async function openDb() {
  const config = loadConfig();
  const db = await createDb({ url: config.databaseUrl });
  await migrate(db);
  await seedReferenceData(db);
  return { db, config };
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
