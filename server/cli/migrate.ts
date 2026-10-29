import { loadConfig } from '../config.js';
import { createDb, migrate } from '../db/client.js';
import { seedReferenceData } from '../bootstrap.js';

const config = loadConfig();
const db = await createDb({ url: config.databaseUrl });
const applied = await migrate(db);
await seedReferenceData(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
console.log('Reference data (languages, aliases, platforms, settings) ensured.');
await db.close();
