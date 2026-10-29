<p align="center">
  <img src="docs/assets/banner.png" alt="Glotta — open-source translation management" width="100%">
</p>

<p align="center">
  <img src="docs/assets/logo.png" alt="Glotta logo" width="72"><br>
  <b>Glotta</b> — a self-hosted translation management system for teams that ship apps in many languages.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#usage-guide">Usage guide</a> ·
  <a href="#importing-excel-and-csv">Import formats</a> ·
  <a href="#public-api">Public API</a> ·
  <a href="#ai-translation">AI translation</a> ·
  <a href="#production-with-pm2">Production</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

<p align="center">
  <img alt="Node 22+" src="https://img.shields.io/badge/node-22%2B-3B82F6">
  <img alt="PostgreSQL 14+" src="https://img.shields.io/badge/PostgreSQL-14%2B-6366F1">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-8B5CF6">
  <img alt="Status: experimental" src="https://img.shields.io/badge/status-experimental-F59E0B">
</p>

---

> **About this project.** Glotta is an experimental open-source project developed by
> [Onro](https://onro.io/)'s Research and Development (R&D) team. It is shared as-is for learning, evaluation and
> community use. It is not an official, supported Onro product, and it comes with no service-level commitments.

## What is Glotta?

Glotta replaces the shared spreadsheet that many product teams use for app texts. It keeps one catalogue of
translation keys, gives each app (platform) its own workspace, and lets translators, reviewers and managers work at the
same time with exactly the permissions they need. Developers download finished translations as resource files or
straight from a read-only HTTP API.

**Highlights**

- **One catalogue, many platforms.** A key can belong to several apps (iOS, Android, web, …) and share one set of
  translations, or be split into a platform-specific copy when the text must differ.
- **Scoped permissions.** Access = languages × platforms × capabilities, enforced on the server for every request.
- **Review workflow.** Draft → needs review → approved, with "request changes" comments and a full history.
- **Excel and CSV import** with a dry run, column mapping, duplicate detection and conflict handling.
- **Exports** to Excel and to JSON, Android XML, iOS `.strings` / `.xcstrings`, Flutter ARB, Gettext PO, YAML and CSV.
- **Public API with API keys** and per-language content versions, so apps download only when something changed.
- **AI translation (optional).** Fill missing translations with Claude; results always go through review.
- **Audit log** of every change, with before and after values.
- **PostgreSQL** storage with automatic `pg_dump` backups.

| Overview | Workspace and editor |
|---|---|
| ![Overview](docs/images/02-overview.png) | ![Editor](docs/images/06-editor.png) |
| **Import (Excel and CSV)** | **AI translation** |
| ![Import](docs/images/11-import.png) | ![Auto translate](docs/images/28-ai-auto-translate.png) |

## Contents

- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Installing PostgreSQL](#installing-postgresql)
- [Configuration](#configuration)
- [Local development and tests](#local-development-and-tests)
- [Production with PM2](#production-with-pm2)
- [Backups and restore](#backups-and-restore)
- [Concepts](#concepts)
- [Usage guide](#usage-guide)
- [Importing Excel and CSV](#importing-excel-and-csv)
- [Exports](#exports)
- [Public API](#public-api)
- [AI translation](#ai-translation)
- [Architecture](#architecture)
- [Commands](#commands)
- [Troubleshooting](#troubleshooting)
- [Security notes and limitations](#security-notes-and-limitations)
- [Contributing](#contributing)
- [License and credits](#license-and-credits)

## Quick start

```bash
git clone https://github.com/jonios/Glotta.git
cd Glotta
npm install
cp .env.example .env
```

Then set up a database. On Windows without admin rights, `npm run pg:init` sets up a local PostgreSQL for you (see
[Installing PostgreSQL](#installing-postgresql)). Otherwise, create a database and set `DATABASE_URL` in `.env`.

```bash
npm run db:migrate                                         # tables + reference data (languages, platforms)
npm run admin:create -- --email you@example.com --name "Your Name"   # prints a one-time password
npm run dev                                                # API on :3001, web app on http://localhost:5173
```

Open <http://localhost:5173>, sign in, and change the password under **Settings → Your account**.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 22 or newer | npm comes with it |
| PostgreSQL | 14 or newer (17 recommended) | Server plus the client tools `pg_dump` / `pg_restore` for backups |
| A modern browser | Chrome, Edge, Firefox, Safari | |
| Anthropic API key | optional | Only for [AI translation](#ai-translation) |
| Chrome or Edge | optional | Only for `npm run docs:screenshots` |

## Installing PostgreSQL

Glotta needs a PostgreSQL database and a role (user) that owns it. Pick the option that fits your machine.

### Option A — Windows, portable, no admin rights (what the project uses for local development)

1. Download the **zip archive** of PostgreSQL 17 for Windows x86-64 (the "binaries" download linked from
   <https://www.postgresql.org/download/windows/>).
2. Extract it so that this file exists:
   `%LOCALAPPDATA%\Programs\PostgreSQL17\pgsql\bin\pg_ctl.exe`
   (another folder works too: set `PG_HOME` to the folder that contains `bin\`).
3. From the project folder:

   ```bash
   npm run pg:init      # creates the cluster, the "glotta" role and the databases "glotta" and "glotta_test"
   npm run pg:status
   ```

`pg:init` creates a data directory in `%LOCALAPPDATA%\glotta\pgdata`, enables `scram-sha-256` password
authentication, listens on `127.0.0.1:5432`, and writes `DATABASE_URL` and `TEST_DATABASE_URL` with a random password
into `.env`. The `postgres` superuser password is stored in `%LOCALAPPDATA%\glotta\superuser-password.txt`, and the
server log is `%LOCALAPPDATA%\glotta\postgres.log`.

PostgreSQL does not start with Windows in this setup. After a reboot, run `npm run pg:start`; stop it with
`npm run pg:stop`. Optional settings: `PG_HOME`, `PG_DATA` (data folder) and `PG_PORT`.

### Option B — Windows installer

Install PostgreSQL with the installer from <https://www.postgresql.org/download/windows/> (it runs as a Windows
service), then create the role and databases as in [Create the role and databases](#create-the-role-and-databases).

### Option C — Ubuntu / Debian

```bash
sudo apt install postgresql postgresql-client
sudo systemctl enable --now postgresql
```

For PostgreSQL 17 on older releases, add the official repository first (<https://www.postgresql.org/download/linux/>).

### Option D — macOS

```bash
brew install postgresql@17
brew services start postgresql@17
```

### Option E — Docker

```bash
docker run -d --name glotta-db -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=glotta -e POSTGRES_PASSWORD=change-me -e POSTGRES_DB=glotta \
  -v glotta-pgdata:/var/lib/postgresql/data postgres:17
```

Then grant `CREATEDB` (only needed for tests): `docker exec -it glotta-db psql -U glotta -c "ALTER ROLE glotta CREATEDB"`.

### Create the role and databases

For options B–D, open `psql` as the superuser (`sudo -u postgres psql` on Linux, `psql postgres` on macOS) and run:

```sql
CREATE ROLE glotta LOGIN PASSWORD 'choose-a-strong-password' CREATEDB;
CREATE DATABASE glotta OWNER glotta;
CREATE DATABASE glotta_test OWNER glotta;   -- only for npm test
```

Then put the matching URLs in `.env`:

```ini
DATABASE_URL=postgres://glotta:choose-a-strong-password@127.0.0.1:5432/glotta
TEST_DATABASE_URL=postgres://glotta:choose-a-strong-password@127.0.0.1:5432/glotta_test
```

`CREATEDB` is only required for the test suite, which creates and drops a temporary database per test file. In
production you can leave it out. Percent-encode special characters in the password (`@` → `%40`, `:` → `%3A`).

Check the connection with `npm run db:migrate`: it prints a clear message if the database cannot be reached.

## Configuration

All settings are environment variables, read from `.env` in the project folder. See
[`.env.example`](.env.example) for a template.

| Setting | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — (required) | PostgreSQL connection URL |
| `TEST_DATABASE_URL` | — | Database for `npm test`; the role needs `CREATEDB` |
| `PG_HOME` | PATH | Folder containing `bin/pg_dump` and `bin/pg_restore` |
| `API_PORT` | `3001` | Port of the API (and, in production, of the whole app) |
| `HOST` | `127.0.0.1` | `127.0.0.1` = local only (behind a reverse proxy); `0.0.0.0` = reachable from the network |
| `NODE_ENV` | `development` | `production` on servers (also blocks `seed:dev`) |
| `APP_URL` | `http://localhost:5173` | Public URL of the app; used in invitation links |
| `COOKIE_SECURE` | `true` in production | Must be `false` on plain http, `true` behind HTTPS |
| `SESSION_TTL_HOURS` | `12` | How long a sign-in lasts |
| `UPLOAD_DIR` | `./.data/uploads` | Where uploaded import files are kept |
| `MAX_UPLOAD_MB` | `25` | Largest import file accepted |
| `IMPORT_UPLOADS_PER_MINUTE` | `20` | Upload rate limit per client |
| `BACKUP_DIR` | `./.data/backups` | Where automatic `pg_dump` backups go |
| `BACKUP_INTERVAL_HOURS` | `24` | Hours between automatic backups (`0` = off) |
| `BACKUP_KEEP` | `14` | How many backups to keep |
| `ADMIN_PASSWORD` | — | Optional password for `admin:create` instead of a generated one |
| `TMS_DEBUG` | — | `1` prints full details of server errors to the log |
| `ANTHROPIC_API_KEY` | — | Enables AI translation |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Model of the "standard" tier |
| `ANTHROPIC_MODEL_ECONOMY` | — | Optional cheaper model offered as the "economy" tier |

Advanced AI settings (all optional): `AI_BATCH_SIZE` (keys per request, default 50), `AI_CONCURRENCY` (3),
`AI_MAX_RETRIES` (4), `AI_MAX_ITEM_ATTEMPTS` (2), `AI_TIMEOUT_MS` (180000), `AI_MAX_OUTPUT_TOKENS` (16000),
`AI_MAX_KEYS_PER_JOB` (10000), `AI_MESSAGE_BATCH_MIN_KEYS` (2000, `0` = never use the Message Batches API),
`AI_BATCH_POLL_MS` (60000), `AI_EFFORT` (`low`), `AI_REFUSAL_FALLBACK` (`off` disables server-side fallbacks),
`AI_JOBS_PER_MINUTE` (10), `AI_WORKER_ENABLED` (`false` stops background processing), and the price settings
`AI_PRICE_INPUT_PER_MTOK`, `AI_PRICE_OUTPUT_PER_MTOK`, `AI_ECONOMY_PRICE_INPUT_PER_MTOK`,
`AI_ECONOMY_PRICE_OUTPUT_PER_MTOK` (USD per million tokens, used only for cost estimates).

Restart the app after changing `.env`.

## Local development and tests

```bash
npm run pg:start          # only with the portable setup (Option A)
npm run dev               # API on http://127.0.0.1:3001 and the web app on http://localhost:5173
```

The Vite dev server forwards `/api/…` to the API. The API does not reload on file changes: press Ctrl+C and run
`npm run dev` again after changing server code. Web changes reload instantly.

**Demo data.** `npm run seed:dev` creates demo accounts (listed at the top of `server/cli/seed-dev.ts`, for local use
only) and imports the sample workbook from `data/`. It refuses to run with `NODE_ENV=production`.

**Tests.**

```bash
npm test                  # Vitest, against real PostgreSQL databases
npm run typecheck
npm run build             # production web build + type check
```

Each test file creates its own temporary database `glotta_t_…` through `TEST_DATABASE_URL` and drops it afterwards, so
tests run in parallel and never touch your development data. The suite covers authentication and permission scopes
(including URL and API tampering), the review workflow, optimistic concurrency, Excel and CSV import (valid files,
invalid files, missing columns, encodings, duplicates, conflicts, idempotent re-import), every export format (checked
with independent parsers), the public API and API keys, content versions, backups, and AI translation (with a fake
model client — no API calls and no cost).

**Screenshots.** The images in `docs/images/` are taken from a running local app with headless Chrome or Edge:

```bash
TMS_EMAIL=<local super admin> TMS_PASSWORD=<password> npm run docs:screenshots -- --demo-review
```

Use a development database only. `--only=02-overview,11-import` retakes selected images; rows that mention accounts
outside `@tms.test` are hidden automatically. Set `CHROME_PATH` if the browser is installed in an unusual place.

## Production with PM2

The steps below use Ubuntu/Debian, the folder `/srv/glotta` and port `8090`. Replace them with your own values.

**1. Install Node.js 22+, PM2 and PostgreSQL**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc && nvm install 22
npm install -g pm2
sudo apt install postgresql postgresql-client
```

Create the role and database as in [Create the role and databases](#create-the-role-and-databases) (`CREATEDB` is not
needed in production).

**2. Get the code, configure, build**

```bash
git clone https://github.com/jonios/Glotta.git /srv/glotta
cd /srv/glotta
npm ci                      # not --omit=dev: the server runs through tsx, and the build needs vite
cp .env.example .env && nano .env
```

```ini
DATABASE_URL=postgres://glotta:<password>@127.0.0.1:5432/glotta
NODE_ENV=production
API_PORT=8090
HOST=127.0.0.1              # behind nginx; use 0.0.0.0 only to test without a proxy
APP_URL=https://glotta.example.com
COOKIE_SECURE=true          # false while testing on plain http
```

```bash
npm run db:migrate
npm run admin:create -- --email you@example.com --name "Your Name"
npm run build               # writes the web app to dist/, served by the API in production
```

**3. PM2 configuration** — create `ecosystem.config.cjs` (ignored by git):

```js
module.exports = {
  apps: [
    {
      name: 'glotta',
      cwd: '/srv/glotta',
      script: 'server/index.ts',
      interpreter: 'node',
      node_args: '--import tsx',
      instances: 1,
      exec_mode: 'fork',
      kill_timeout: 15000,
      autorestart: true,
      max_memory_restart: '1G',
      env: { NODE_ENV: 'production' },
    },
  ],
};
```

| Setting | Why |
|---|---|
| `cwd` | Must be the project folder, so `.env`, `dist/` and `.data/` are found |
| `node_args: '--import tsx'` | Runs the TypeScript server directly |
| `instances: 1`, `exec_mode: 'fork'` | Import progress and the AI worker run in-process; run a single instance |
| `kill_timeout: 15000` | Gives running requests and AI jobs time to stop cleanly (the server force-exits after 12 s) |

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup                 # prints a "sudo env PATH=…" command: run it once
curl http://127.0.0.1:8090/api/health      # {"ok":true,"db":"pg"}
```

**4. HTTPS with nginx**

```nginx
server {
    listen 80;
    server_name glotta.example.com;
    client_max_body_size 30m;   # a little more than MAX_UPLOAD_MB

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/glotta /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d glotta.example.com
```

**5. Updating to a new version**

```bash
cd /srv/glotta
npm run db:backup
git pull
npm ci
pm2 stop glotta
npm run db:migrate
npm run build
pm2 start glotta
```

**Everyday commands:** `pm2 status`, `pm2 logs glotta --lines 100`, `pm2 restart glotta --update-env` (after editing
`.env`), `pm2 stop glotta`.

## Backups and restore

While the app runs, it writes a `pg_dump` backup (custom format) to `BACKUP_DIR` at startup and every
`BACKUP_INTERVAL_HOURS`, named `glotta-YYYYMMDD-HHMMSS.dump` (UTC), and keeps the newest `BACKUP_KEEP`. It needs
`pg_dump` on PATH or in `PG_HOME/bin`.

```bash
npm run db:backup                                            # one backup now (the app may keep running)
pm2 stop glotta
npm run db:restore -- .data/backups/glotta-20261029-101500.dump   # replaces the database contents
pm2 start glotta
```

The restore runs in one transaction, so a failed restore leaves the database unchanged. Copy `BACKUP_DIR` and
`UPLOAD_DIR` to another machine regularly; backups on the same disk do not survive a lost server. You can also use
your own `pg_dump` / managed-database backups instead (`BACKUP_INTERVAL_HOURS=0`).

## Concepts

| Concept | Meaning |
|---|---|
| **Key** | One text in your apps, identified by a keyword such as `login_button`, with an English source text, an optional translator note and character limit |
| **Platform** | An app or surface (iOS Driver, Android Customer, Web, …). A key can be on several platforms |
| **Shared key** | A key used by several platforms with one set of translations. It can be *split* into a platform-specific copy |
| **Namespace** | Internal grouping that keeps two different keys with the same keyword apart. You rarely see it |
| **Language** | A target locale (`fr`, `pt-BR`, `ckb`, …) with writing direction and *aliases* (column labels recognised by imports). One language is the source (English) |
| **Segment** | An optional tag for a screen, page or feature |
| **Translation** | One value per key × language, with a status and a version |
| **Content version** | A counter per language and platform that increases whenever that language's content on that platform changes; apps use it to download only when needed |
| **Conflict** | A difference found during import that a person must decide on |

### Roles and capabilities

Access = **languages** × **platforms** × **capabilities**. A role only pre-fills capabilities; they can be changed
per user. The server checks scope on every request; data outside it is inaccessible, not just hidden.

| Capability | Allows | Super Admin | Manager | Translator | Read-only |
|---|---|:-:|:-:|:-:|:-:|
| View, View source | See permitted platforms, languages and the English text | ✓ | ✓ | ✓ | ✓ |
| Edit translations | Write translations | ✓ | ✓ | ✓ | |
| Edit source | Change English text | ✓ | | | |
| Manage keys | Create and archive keys, platforms of a key, notes | ✓ | | | |
| Manage segments | Create segments, tag keys | ✓ | ✓ | | |
| Review / Approve | Send back with a comment / approve | ✓ | ✓ | | |
| Import | Import Excel and CSV (also needs all languages and platforms) | ✓ | | | |
| Export | Download Excel and resource files | ✓ | ✓ | ✓ | |
| Manage platforms, languages, users, settings | Admin pages | ✓ | | | |
| View audit | See the activity of others | ✓ | ✓ | | |

*Users & Permissions* is for Super Admins only. *API Access* and *AI Translation* are for Super Admins and Managers
(AI translation also needs *Edit translations*).

### Translation statuses

| Status | Meaning |
|---|---|
| **Missing** | No translation yet |
| **Draft** | Saved but not finished |
| **Needs review** | Submitted, waiting for a reviewer (AI results land here by default) |
| **In progress** | Sent back by a reviewer, or the English text changed afterwards |
| **Approved** | Accepted — only approved, non-empty values count as complete and are served by the public API by default |

## Usage guide

### Signing in and accounts

There is no self-registration. A Super Admin invites people, and the invitation link (valid 7 days) lets them set a
password. Email delivery is not built in: copy the link and send it yourself. Under **Settings → Your account**
everyone sees their access and can change their password (at least 10 characters).

### Overview

Totals (keys, languages, platforms, completed, missing, pending review), progress per language and platform, and a
*Needs attention* list. Most numbers link to the matching filtered workspace. The top bar has the global search
(`Ctrl+K`), the platform and language pickers, a light/dark switch and the account menu.

### Translation Workspace

![Workspace](docs/images/03-workspace.png)

- **Platform tabs**, **search** (keyword, English, translations, segments) and two view modes: *Single* (English + one
  language, for daily work) and *All languages*.
- **Filters**: status, modified, changed in the last 7 days, empty source, duplicate-key candidates, open conflicts,
  source changed, no segment, segments. The URL keeps your view, so you can bookmark or share it.
- **New key** (needs *Manage keys*), **bulk actions** on selected rows (approve, request changes, segments, share with
  a platform, archive, export), sorting, column picker and page size.
- Keyboard: `↑`/`↓` or `j`/`k` move, `Enter` opens, `x` selects.

### Editor

Click a row to open the side panel: the English source with a copy button, a tab per language (right-to-left languages
are written right-to-left), and live checks for placeholders (`%s`, `%1$d`, `{name}`, `{{x}}`, ICU messages),
unbalanced braces and the character limit. Reviewer comments appear above the text. Translators *submit for review*;
users who can approve can save directly as approved. The *Details* tab holds platforms, segments, note, limit and import
conflicts; *History* lists every change. If someone else saved in the meantime, you see both values and choose.
Shortcuts: `Ctrl+Enter` save and next, `Ctrl+S` save, `Alt+↓`/`Alt+↑` next/previous, `Esc` close.

### Review

A queue per language and platform. *Waiting for review*: approve, or write a comment and send back (*Approve all on
this page* is available). *Returned*: translations sent back, with the comment.

### Platforms, Languages, Segments

Create, edit, archive and restore platforms (archived platforms leave the workspace and exports but keep their data).
Languages have a code, name, direction and **aliases** — the column labels imports recognise, for example `Farsi` or
`FA` for Persian. Segments are optional tags you can create here, in the editor or with bulk actions.

### Users & Permissions

Invite users with a role, languages (selected or all), platforms (selected or all) and capabilities; a summary shows
the effective access. Edit, reset access (new one-time link), deactivate or reactivate users. The last Super Admin
cannot be removed, and nobody can grant more rights than they have.

### Translation Activity and Settings

The activity log shows who changed what and when, with before and after values (passwords and tokens are never
logged). **Settings** holds placeholder rules (with a test box), the default status for imported values, and
translator guidelines.

## Importing Excel and CSV

**Import / Export → Import** accepts Excel workbooks (`.xlsx`) and CSV/TSV text files (`.csv`, `.tsv`). It is a
four-step wizard; nothing is written before the last step.

1. **Upload** the file (up to `MAX_UPLOAD_MB`).
2. **Map sheets and columns.** For each sheet (a CSV file is one sheet, named after the file): the target platform or
   a new one, and the language of each column. Duplicate keys, duplicate language columns, blank cells and unknown
   columns are listed here.
3. **Choose a strategy** for values that already exist:

   | Strategy | Effect |
   |---|---|
   | Skip existing (default) | Add new keys and fill empty translations; never change existing values |
   | Only missing | Never create keys; only fill empty translations |
   | Update existing | Overwrite different values (old values stay in the history) |
   | Ask me | Different values become **conflicts** to resolve under *Conflicts* or in the editor |

4. **Dry run**, then **Import**. The import runs in a single transaction: all or nothing. Re-importing the same file
   changes nothing.

Imports need the *Import* capability and access to all languages and platforms. The command line equivalent is
`npm run import:workbook -- --file <path> --admin <email> [--strategy skip_existing|only_missing|update_existing|manual] [--dry-run]`
(stop the app first).

### File format

The header row (within the first 6 rows; guide text above it is skipped) names the columns. Column names are not
case-sensitive.

| Column | Header names | Required |
|---|---|---|
| Key | `key`, `keyword`, `keywords`, `identifier` | yes |
| Languages | A language code (`en`, `fr`, `pt-BR`) or a name/alias (`English`, `Persian`, `Français`) — see the Languages page | at least one |
| Segment | `segment`, `segments`, `screen`, `page`, `path` | no |
| Note | `description`, `note`, `notes`, `translator note` | no |

The English column (`en` / `English`) is the source text. Example CSV:

```csv
key,en,fr,fa,segment,description
login.title,Sign in,Se connecter,ورود,Login,Title of the sign-in screen
cart.items,"You have {count} items","Vous avez {count} articles",{count} مورد دارید,Cart,"Plural handled by the app"
greeting,"Hello, ""%s""!","Bonjour, « %s » !",سلام %s!,,
```

**CSV rules**

- Encoding: UTF-8 (with or without BOM — Excel's *CSV UTF-8*) or UTF-16 with BOM. Other encodings are rejected rather
  than guessed.
- Separator: comma, semicolon or tab, detected from the header line (`.tsv` files use tab).
- Quoting per RFC 4180: fields with separators, quotes or line breaks are wrapped in `"…"`, and a quote inside is
  written `""`. Line endings `\r\n`, `\n` and `\r` are all accepted.
- Every value is kept exactly as typed — leading zeros, `=` formulas, numbers, spaces, placeholders, emoji and
  right-to-left text. Blank lines are skipped; empty cells mean "no translation".
- Up to 300 columns.

**Excel rules:** every worksheet is inspected; formulas use their cached value, and Excel error cells (`#N/A`, …) and
numbers are never imported as translations — they are kept as raw cells you can see in the editor's Details tab. A
`.xlsx` file renamed to `.csv` is detected and read as a workbook.

### Import errors

Errors are shown in the wizard and returned by the API as `{ "error": "<code>", "message": "…", "details": { "line": n } }`.

| Code | Cause | What to do |
|---|---|---|
| `bad_type` | Not a `.xlsx`, `.csv` or `.tsv` file, or a broken workbook | Save as *Excel Workbook (.xlsx)* or *CSV UTF-8* |
| `file_too_large` | Larger than `MAX_UPLOAD_MB` (or nginx `client_max_body_size`) | Split the file or raise the limit |
| `empty_file` | The file has no content or no rows | — |
| `binary_file` | A `.csv` that is not text (e.g. an `.xls` renamed) | Export as CSV UTF-8 |
| `bad_encoding` | Not valid UTF-8 / UTF-16 | Save as *CSV UTF-8* |
| `unclosed_quote` | A quoted field never ends; `details.line` names the line | Fix the quotes on that line |
| `too_many_columns` | More than 300 columns on a line | Remove unused columns |
| `unreadable` | Corrupted or password-protected workbook | Remove the password or re-save |
| `no_key_column` | No `key` / `keyword` / `identifier` column in the header | Add or rename the column |
| `no_language_columns` | No column matches a language code, name or alias | Rename columns or add an alias on the Languages page |
| `no_rows` | A header but no rows with a key | — |
| `rate_limited` | More than `IMPORT_UPLOADS_PER_MINUTE` uploads | Wait a minute |

Problems inside an otherwise valid file — duplicate keys, two columns for the same language, unknown columns, rows
without a key — do not stop the import; they are listed in step 2 and in the dry run.

## Exports

- **Excel → Legacy layout**: one sheet per platform with the original column names and order of the imported
  workbook.
- **Excel → Normalized**: one row per key; can be imported again.
- **Localization files**: JSON (flat or nested), Android `values-xx/strings.xml`, iOS `xx.lproj/Localizable.strings`,
  Apple String Catalog `Localizable.xcstrings`, Flutter ARB, Gettext PO, YAML and CSV. Choose platforms, languages,
  segments, which statuses to include, and what to do with missing translations (skip, empty, or English fallback).
  Several files are delivered as a ZIP with one folder per platform; renamed or invalid resource names are listed in
  `EXPORT-WARNINGS.txt`.

You only ever export languages and platforms within your scope. **History** lists past imports and exports.

## Public API

Apps and build pipelines can read translations with an **API key**. Super Admins and Managers create keys under
**API Access → API keys** (name, expiry). The key starts with `glt_` and is shown once — only a hash is stored. A key
reads exactly the languages and platforms of its creator and stops working when it is revoked, expires, or its creator
loses access. The **Documentation** tab in the app has copy-ready examples for your server.

Base URL `https://<your-server>/api/v1`, header `Authorization: Bearer <key>` (or `X-API-Key`), `GET` only, JSON.

| Endpoint | Returns |
|---|---|
| `GET /api/v1/languages` | Readable languages with `code`, `name`, `nativeName`, `direction`, `isSource`, `versions` per platform, `updatedAt`; `?platform=<slug>` adds `version` |
| `GET /api/v1/languages/{code}/keywords` | `{ "keyword": "translation", … }` for one language |
| `GET /api/v1/platforms` | `{ "platforms": [{ "slug", "name", "kind" }] }` |

Keywords parameters: `platform=<slug>`; `status=approved` (default) or `any`; `fallback=none` (default) or `source`.
Response headers: `X-Keyword-Count`, `X-Language`, `X-Platform`, and `X-Content-Version` when a platform is given.

```bash
export GLOTTA_API_KEY="glt_…"
curl -H "Authorization: Bearer $GLOTTA_API_KEY" \
  "https://glotta.example.com/api/v1/languages/fr/keywords?platform=ios-driver"
```

**Content versions.** Each language has a version per platform that increases when a translation in that language on
that platform changes (added, edited, approved, sent back, imported, AI-translated) or when the platform's set of keys
or their English text changes. Store the version with the downloaded strings and download again only when it differs.

Errors: `{ "error", "message" }` — 400 `validation_error`; 401 `missing_api_key`, `invalid_api_key`,
`api_key_revoked`, `api_key_expired`, `api_key_disabled`; 403 `language_forbidden`, `platform_forbidden`; 404
`language_not_found`, `platform_not_found`; 429 `rate_limited` (120 requests per minute per key). CORS is allowed.

## AI translation

Optional. Glotta can fill missing translations with Claude through the official
[Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript).

**Setup:** add `ANTHROPIC_API_KEY` (from <https://console.anthropic.com/>) to `.env` and restart. `ANTHROPIC_MODEL`
defaults to `claude-opus-5-5`; set `ANTHROPIC_MODEL_ECONOMY` to offer a cheaper tier. The key stays on the server and
is never sent to browsers or written to logs. Without a key, everything else works and the AI pages show these setup
steps.

**Where it appears** (Super Admins and Managers with *Edit translations*):

- **AI Translation → Missing keys** — per language: missing, empty, invalid (broken placeholders or ICU), outdated
  (source changed), empty source, and orphaned (archived or unused) entries. Search, CSV export, and *Auto translate*
  for selected keys or all eligible ones.

  ![Missing keys](docs/images/27-ai-missing-keys.png)
- **Languages → Auto translate**, and *Auto translate after creating* when adding a language.
- **AI Translation → Jobs** — progress, per-key results, cancel, retry failed keys, resume.

**How it works**

- A **preview** shows the number of keys, what is skipped (already approved, empty source), batches, estimated tokens
  and — if prices are configured — the estimated cost before anything is sent.
- **Existing translations** are left alone by default (*Only missing*). *Missing + outdated* also re-translates values
  whose source changed; *Everything not approved* and *Everything, including approved* (Super Admins only) replace
  existing work and need an explicit confirmation.
- Keys are sent in batches with the source text, translator note, character limit and placeholders; the model returns
  structured JSON. Every result is validated (placeholders, ICU syntax, length); a failed key is retried once and then
  reported with its reason.
- Results are saved as **Needs review** (default) or **Draft** — never directly approved — so the public API keeps
  serving approved values only. Every write is recorded in the history (reason "AI") and checked against concurrent
  edits; a value someone changed during the job is not overwritten.
- Jobs run in a background worker with database leases, so a restart resumes them. Large jobs (from
  `AI_MESSAGE_BATCH_MIN_KEYS`, default 2,000 keys) may use the Message Batches API at half the price, with results
  within about an hour. Rate limits and overload errors are retried with exponential backoff.

## Architecture

| Layer | Choice |
|---|---|
| API | Node 22, TypeScript, Fastify 5, Zod validation |
| Database | PostgreSQL via `pg`, parameterised SQL, versioned migrations in `server/db/migrations` |
| Web | React 19, Vite, TanStack Query, React Router, Tailwind (CSS-variable tokens), Radix, Lucide icons |
| Files | ExcelJS, JSZip, an RFC 4180 CSV parser |
| AI | `@anthropic-ai/sdk`, `@formatjs/icu-messageformat-parser` |
| Tests | Vitest with Fastify `inject` against real PostgreSQL |

```
server/
  app.ts              Fastify wiring, security headers, error mapping
  auth/  authz/       sessions, CSRF, password hashing; permission scopes used by every query
  modules/            languages, platforms, segments, users, keys, translations, dashboard, audit,
                      missing keys, API keys and the public /api/v1
  importexport/       Excel and CSV parsing, import planner and applier, export routes
  exporters/          resource file formats
  ai/                 prompt, Claude client, validation, jobs, background worker
  db/                 client, migrations, pg_dump backups
  cli/                migrate, create-admin, import-workbook, seed-dev, backup, restore
shared/               domain constants and the placeholder validator (API and UI)
web/src/              the single-page app
scripts/              local PostgreSQL helper, screenshot and branding renderers
tests/                Vitest suites
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API (:3001) + web app (:5173) |
| `npm run build` | Build the web app into `dist/` and type-check |
| `npm start` | Run the production server (what PM2 runs) |
| `npm test` / `npm run typecheck` | Tests / type check |
| `npm run pg:init`, `pg:start`, `pg:stop`, `pg:status` | Portable local PostgreSQL (Windows, or any OS with the binaries on PATH or in `PG_HOME`) |
| `npm run db:migrate` | Create or update tables and reference data |
| `npm run admin:create -- --email E --name "N" [--password P]` | Create a Super Admin or reset an account's password |
| `npm run import:workbook -- --file F --admin E [--strategy S] [--dry-run]` | Import an `.xlsx`, `.csv` or `.tsv` file |
| `npm run seed:dev` | Demo accounts and sample data (development only) |
| `npm run db:backup` / `npm run db:restore -- <file>` | `pg_dump` backup now / restore one (stop the app first) |
| `npm run docs:screenshots` | Re-take the documentation screenshots |

## Troubleshooting

| Problem | Cause and fix |
|---|---|
| `DATABASE_URL is not set` at start | Run `npm run pg:init`, or set `DATABASE_URL` in `.env` |
| `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL is not running: `npm run pg:start` (portable), `sudo systemctl start postgresql`, or `brew services start postgresql@17` |
| `password authentication failed for user "glotta"` | Password in `DATABASE_URL` is wrong, or special characters are not percent-encoded |
| `database "glotta" does not exist` | Create it ([Create the role and databases](#create-the-role-and-databases)) |
| `permission denied to create database` in tests | Grant it: `ALTER ROLE glotta CREATEDB;` |
| `pg_dump was not found` | Install the PostgreSQL client tools or set `PG_HOME`. With Docker, run `pg_dump` inside the container or disable scheduled backups |
| `pg_dump: server version mismatch` | The client tools are older than the server; install the matching version |
| `npm run pg:init` says the cluster exists | It was already initialised; use `npm run pg:start` |
| Signed in, then immediately signed out | `COOKIE_SECURE=true` on plain http. Use HTTPS or set `COOKIE_SECURE=false` |
| Site unreachable from other machines | `HOST=127.0.0.1`. Put nginx in front, or set `HOST=0.0.0.0` and open the port in the firewall |
| `EADDRINUSE :3001` | Another copy of the app is running; stop it |
| `http proxy error: /api/...` in development | The API half of `npm run dev` failed to start; scroll up for its error |
| Server code changes don't show | The API does not auto-reload: restart `npm run dev` |
| Import: "No key column found" / "No language columns found" | See [Import errors](#import-errors) |
| CSV: accents or Persian/Arabic text look broken | The file is not UTF-8. In Excel use *Save As → CSV UTF-8* |
| CSV: everything lands in one column | The separator is not `,` `;` or tab, or the header line has only one column |
| Upload rejected behind nginx (413) | Raise `client_max_body_size` |
| AI pages say "not set up" | Set `ANTHROPIC_API_KEY` and restart |
| AI job fails with "The Anthropic API key was rejected" | The API key is wrong or revoked |
| AI job fails with "Unknown model or resource" | `ANTHROPIC_MODEL` names a model your key cannot use |
| AI keys fail with "placeholder missing" | The model changed a placeholder; the key stays untranslated and is listed with its reason. Retry, or translate by hand |
| AI job stays *queued* | `AI_WORKER_ENABLED=false`, or the server was stopped; jobs resume after a restart |
| Invitation links point to the wrong address | Fix `APP_URL` and restart |

Set `TMS_DEBUG=1` to log full details of server errors.

## Security notes and limitations

**Security:** server-side scope checks on every route; opaque session tokens stored hashed, HttpOnly SameSite
cookies and a per-session CSRF header; scrypt password hashes; rate limits on sign-in, invitations, uploads, API keys
and AI jobs; Zod validation; parameterised SQL only; CSP and security headers; magic-number and size checks for
uploads; optimistic concurrency; transactional imports; an audit log without secrets; API keys stored as hashes; the
Anthropic key never leaves the server. Please report security issues privately to the maintainers rather than in a
public issue.

**Limitations:** plural variants are not modelled yet (`.stringsdict` is not generated); email delivery for
invitations is not built in; import progress and the AI worker run in-process, so run a single app instance; search
uses `ILIKE` (add a `pg_trgm` index for very large catalogues); changing the source language is not exposed in the UI.

## Contributing

Issues and pull requests are welcome. Please run `npm run typecheck` and `npm test` before opening a pull request,
keep changes focused, and add tests for new behaviour. Because this is an R&D project, responses may be slow and the
roadmap may change.

Repository: <https://github.com/jonios/Glotta> ·
Issues: <https://github.com/jonios/Glotta/issues>

## License and credits

License: see [LICENSE](LICENSE).

Glotta is an experimental open-source project developed by [Onro](https://onro.io/)'s Research and Development (R&D)
team. It is not an official Onro product. "Onro" is a trademark of its owner; the Glotta name and logo are independent
of Onro's branding. Learn more about Onro at [onro.io](https://onro.io/).
