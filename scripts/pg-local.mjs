#!/usr/bin/env node
// Local PostgreSQL for development, without a system service or admin rights.
//
//   npm run pg:init     create a database cluster, the "glotta" role and databases, and write DATABASE_URL to .env
//   npm run pg:start    start the server        npm run pg:stop     stop it (clean shutdown)
//   npm run pg:status   show whether it runs
//
// Settings (environment variables, all optional):
//   PG_HOME  folder that contains bin/ (pg_ctl, initdb, psql). Default on Windows:
//            %LOCALAPPDATA%\Programs\PostgreSQL17\pgsql; elsewhere the binaries on PATH.
//   PG_DATA  data directory. Default: %LOCALAPPDATA%\glotta\pgdata (Windows) or ~/.local/share/glotta/pgdata.
//   PG_PORT  port, default 5432.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const win = process.platform === 'win32';
const PG_HOME = process.env.PG_HOME || (win ? join(process.env.LOCALAPPDATA ?? homedir(), 'Programs', 'PostgreSQL17', 'pgsql') : '');
const bin = (name) => (PG_HOME ? join(PG_HOME, 'bin', win ? `${name}.exe` : name) : name);
const DATA = process.env.PG_DATA || (win ? join(process.env.LOCALAPPDATA ?? homedir(), 'glotta', 'pgdata') : join(homedir(), '.local', 'share', 'glotta', 'pgdata'));
const PORT = process.env.PG_PORT || '5432';
const LOG = join(dirname(DATA), 'postgres.log');
const SUPERUSER_FILE = join(dirname(DATA), 'superuser-password.txt');
const APP = 'glotta';

const run = (cmd, args, opts = {}) => execFileSync(bin(cmd), args, { stdio: 'inherit', ...opts });
const isRunning = () => spawnSync(bin('pg_ctl'), ['-D', DATA, 'status'], { stdio: 'ignore' }).status === 0;

function psql(sql, password, db = 'postgres') {
  execFileSync(bin('psql'), ['-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', PORT, '-U', 'postgres', '-d', db, '-c', sql], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PGPASSWORD: password },
  });
}

/** Adds or replaces KEY=value lines in .env, leaving every other line untouched. */
function setEnv(values) {
  const file = '.env';
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^#?\\s*${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, '\n')}${line}\n`;
  }
  writeFileSync(file, text);
}

function start() {
  if (isRunning()) return console.log(`PostgreSQL is already running (${DATA})`);
  // stdio must not be inherited: the server would keep this terminal's pipes open and the command would never return.
  run('pg_ctl', ['-D', DATA, '-l', LOG, '-o', `-p ${PORT}`, '-w', 'start'], { stdio: 'ignore' });
  console.log(`PostgreSQL is running on 127.0.0.1:${PORT} (log: ${LOG})`);
}

function init() {
  if (existsSync(join(DATA, 'PG_VERSION'))) {
    console.log(`A cluster already exists in ${DATA}. Use "npm run pg:start".`);
    return;
  }
  mkdirSync(dirname(DATA), { recursive: true });
  const superPassword = randomBytes(18).toString('base64url');
  const appPassword = randomBytes(18).toString('base64url');
  const pwfile = join(tmpdir(), `glotta-pw-${process.pid}`);
  writeFileSync(pwfile, superPassword);
  try {
    run('initdb', ['-D', DATA, '-U', 'postgres', '-A', 'scram-sha-256', `--pwfile=${pwfile}`, '-E', 'UTF8', '--locale=C']);
  } finally {
    rmSync(pwfile, { force: true });
  }
  writeFileSync(SUPERUSER_FILE, `${superPassword}\n`, { mode: 0o600 });
  start();
  psql(`CREATE ROLE ${APP} LOGIN CREATEDB PASSWORD '${appPassword}'`, superPassword);
  psql(`CREATE DATABASE ${APP} OWNER ${APP} ENCODING 'UTF8'`, superPassword);
  psql(`CREATE DATABASE ${APP}_test OWNER ${APP} ENCODING 'UTF8'`, superPassword);
  const url = (db) => `postgres://${APP}:${appPassword}@127.0.0.1:${PORT}/${db}`;
  setEnv({ DATABASE_URL: url(APP), TEST_DATABASE_URL: url(`${APP}_test`) });
  console.log(`\nCreated role "${APP}" and databases "${APP}" and "${APP}_test".`);
  console.log('DATABASE_URL and TEST_DATABASE_URL were written to .env (passwords are random and not shown).');
  console.log(`The "postgres" superuser password is in ${SUPERUSER_FILE}.`);
  console.log('Next: npm run db:migrate && npm run admin:create -- --email you@example.com --name "Your Name"');
}

const cmd = process.argv[2];
try {
  if (cmd === 'init') init();
  else if (cmd === 'start') start();
  else if (cmd === 'stop') isRunning() ? run('pg_ctl', ['-D', DATA, '-m', 'fast', '-w', 'stop']) : console.log('PostgreSQL is not running');
  else if (cmd === 'status') console.log(isRunning() ? `running — data ${DATA}, port ${PORT}` : `stopped — data ${DATA}`);
  else {
    console.error('Usage: node scripts/pg-local.mjs <init|start|stop|status>');
    process.exit(1);
  }
} catch (err) {
  if (err.code === 'ENOENT') console.error(`PostgreSQL binaries not found (looked for ${bin('pg_ctl')}). Install PostgreSQL 17 or set PG_HOME.`);
  else console.error(err.message);
  process.exit(1);
}
