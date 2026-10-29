-- Translation Management System: initial schema.
-- All identifiers are integer identities; human-readable identifiers live in
-- dedicated columns with explicit uniqueness rules.

CREATE TABLE languages (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          text NOT NULL UNIQUE,                 -- BCP-47, e.g. en, pt-BR, zh-Hans
  name          text NOT NULL,                        -- English display name
  native_name   text NOT NULL DEFAULT '',
  direction     text NOT NULL DEFAULT 'ltr' CHECK (direction IN ('ltr','rtl')),
  is_source     boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Exactly one source language at a time.
CREATE UNIQUE INDEX languages_one_source ON languages (is_source) WHERE is_source;

-- Alternative codes and legacy workbook labels ("Francais", "Germany", "et-EE (Estonian)").
-- Aliases are stored normalised (lower-case, collapsed whitespace) and are globally unique,
-- so one label can never silently resolve to two languages.
CREATE TABLE language_aliases (
  alias         text PRIMARY KEY,
  language_id   integer NOT NULL REFERENCES languages(id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'label' CHECK (kind IN ('label','code')),
  note          text NOT NULL DEFAULT ''
);

CREATE TABLE platforms (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name          text NOT NULL UNIQUE,
  description   text NOT NULL DEFAULT '',
  kind          text NOT NULL DEFAULT 'other',        -- ios | android | web | document | other (export defaults)
  is_archived   boolean NOT NULL DEFAULT false,
  sort_order    integer NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE segments (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL,
  name_norm     text NOT NULL UNIQUE,                 -- lower(trim(name)) for de-duplication
  description   text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email              text NOT NULL UNIQUE,
  name               text NOT NULL,
  password_hash      text,                            -- null until an invite is accepted
  role               text NOT NULL CHECK (role IN ('super_admin','manager','translator','viewer')),
  is_active          boolean NOT NULL DEFAULT true,
  all_languages      boolean NOT NULL DEFAULT false,
  all_platforms      boolean NOT NULL DEFAULT false,
  invite_token_hash  text,
  invite_expires_at  timestamptz,
  invited_by         integer REFERENCES users(id) ON DELETE SET NULL,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_capabilities (
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability  text NOT NULL,
  PRIMARY KEY (user_id, capability)
);
CREATE TABLE user_languages (
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language_id  integer NOT NULL REFERENCES languages(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, language_id)
);
CREATE TABLE user_platforms (
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform_id  integer NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, platform_id)
);

CREATE TABLE sessions (
  id_hash      text PRIMARY KEY,                     -- sha256 of the opaque cookie token
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   text NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  ip           text NOT NULL DEFAULT '',
  user_agent   text NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user ON sessions (user_id);

-- A translation key. (namespace, identifier) is unique; the same identifier may exist in
-- several namespaces when the workbook used one keyword for different source strings.
CREATE TABLE translation_keys (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  namespace      text NOT NULL DEFAULT 'shared',
  identifier     text NOT NULL CHECK (length(identifier) BETWEEN 1 AND 300),
  source_text    text NOT NULL DEFAULT '',
  description    text NOT NULL DEFAULT '',
  max_length     integer CHECK (max_length IS NULL OR max_length > 0),
  is_archived    boolean NOT NULL DEFAULT false,
  version        integer NOT NULL DEFAULT 1,          -- optimistic concurrency for key/source edits
  legacy         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- origin sheet/row, legacy identifiers
  created_by     integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by     integer REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (namespace, identifier)
);
CREATE INDEX translation_keys_identifier ON translation_keys (identifier);
CREATE INDEX translation_keys_updated ON translation_keys (updated_at DESC);

-- Platform membership. The identifier is denormalised so the database guarantees that a
-- platform never exports two different keys under the same resource name.
CREATE TABLE key_platforms (
  key_id       integer NOT NULL REFERENCES translation_keys(id) ON DELETE CASCADE,
  platform_id  integer NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  identifier   text NOT NULL,
  position     integer NOT NULL DEFAULT 0,           -- original row order for legacy exports
  legacy_meta  text NOT NULL DEFAULT '',             -- original Screen/Page/Path cell for this platform
  PRIMARY KEY (key_id, platform_id),
  UNIQUE (platform_id, identifier)
);
CREATE INDEX key_platforms_platform ON key_platforms (platform_id, position);

CREATE TABLE key_segments (
  key_id      integer NOT NULL REFERENCES translation_keys(id) ON DELETE CASCADE,
  segment_id  integer NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  PRIMARY KEY (key_id, segment_id)
);
CREATE INDEX key_segments_segment ON key_segments (segment_id);

CREATE TABLE source_revisions (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_id      integer NOT NULL REFERENCES translation_keys(id) ON DELETE CASCADE,
  source_text text NOT NULL,
  changed_by  integer REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_revisions_key ON source_revisions (key_id, created_at DESC);

CREATE TABLE translations (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_id       integer NOT NULL REFERENCES translation_keys(id) ON DELETE CASCADE,
  language_id  integer NOT NULL REFERENCES languages(id) ON DELETE CASCADE,
  value        text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'missing'
               CHECK (status IN ('missing','draft','in_progress','needs_review','approved')),
  version      integer NOT NULL DEFAULT 1,
  created_by   integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by   integer REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by  integer REFERENCES users(id) ON DELETE SET NULL,
  approved_by  integer REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  timestamptz,
  approved_at  timestamptz,
  source_changed boolean NOT NULL DEFAULT false,      -- source text changed after this was written
  import_job_id integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key_id, language_id),
  -- An empty value can never be counted as a finished translation.
  CHECK (status = 'missing' OR length(value) > 0),
  CHECK (status <> 'missing' OR value = '')
);
CREATE INDEX translations_lang_status ON translations (language_id, status);
CREATE INDEX translations_updated ON translations (updated_at DESC);

CREATE TABLE translation_history (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  translation_id  integer NOT NULL REFERENCES translations(id) ON DELETE CASCADE,
  value           text NOT NULL,
  status          text NOT NULL,
  changed_by      integer REFERENCES users(id) ON DELETE SET NULL,
  reason          text NOT NULL DEFAULT 'edit',       -- edit | import | review | source_change | conflict_resolution
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX translation_history_tr ON translation_history (translation_id, created_at DESC);

CREATE TABLE translation_reviews (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  translation_id  integer NOT NULL REFERENCES translations(id) ON DELETE CASCADE,
  action          text NOT NULL CHECK (action IN ('approve','request_changes','comment')),
  comment         text NOT NULL DEFAULT '',
  reviewer_id     integer REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX translation_reviews_tr ON translation_reviews (translation_id, created_at DESC);

CREATE TABLE import_jobs (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_name    text NOT NULL,
  file_sha256  text NOT NULL,
  status       text NOT NULL DEFAULT 'analyzed'
               CHECK (status IN ('analyzed','dry_run','running','completed','failed')),
  options      jsonb NOT NULL DEFAULT '{}'::jsonb,
  analysis     jsonb NOT NULL DEFAULT '{}'::jsonb,
  report       jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress     integer NOT NULL DEFAULT 0,
  total        integer NOT NULL DEFAULT 0,
  error        text,
  created_by   integer REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

-- Raw workbook cells that did not become the primary translation value (alternate
-- duplicate columns, unmapped columns, duplicate rows, guide text, code rows).
-- Nothing from a workbook is discarded: it either becomes data or lands here.
CREATE TABLE legacy_cells (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_job_id integer NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  sheet         text NOT NULL,
  row_number    integer NOT NULL,
  col_number    integer NOT NULL,
  header        text NOT NULL DEFAULT '',
  key_id        integer REFERENCES translation_keys(id) ON DELETE SET NULL,
  language_id   integer REFERENCES languages(id) ON DELETE SET NULL,
  role          text NOT NULL,                       -- alternate | unmapped | duplicate_row | excel_error | guide | code_row
  value         text NOT NULL
);
CREATE INDEX legacy_cells_key ON legacy_cells (key_id);
CREATE INDEX legacy_cells_sheet ON legacy_cells (sheet, col_number);

-- Column layout of each imported worksheet, used to regenerate legacy-compatible workbooks.
CREATE TABLE legacy_sheet_layouts (
  sheet_name    text PRIMARY KEY,
  platform_id   integer REFERENCES platforms(id) ON DELETE CASCADE,
  layout        jsonb NOT NULL,
  import_job_id integer REFERENCES import_jobs(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_conflicts (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_job_id  integer NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  key_id         integer REFERENCES translation_keys(id) ON DELETE CASCADE,
  language_id    integer REFERENCES languages(id) ON DELETE CASCADE,
  kind           text NOT NULL,   -- value_mismatch | duplicate_column | duplicate_row | source_mismatch
  sheet          text NOT NULL DEFAULT '',
  row_number     integer,
  header         text NOT NULL DEFAULT '',
  current_value  text NOT NULL DEFAULT '',
  incoming_value text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','kept_current','used_incoming','dismissed')),
  resolved_by    integer REFERENCES users(id) ON DELETE SET NULL,
  resolved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_conflicts_open ON import_conflicts (status, language_id);
CREATE INDEX import_conflicts_key ON import_conflicts (key_id);

CREATE TABLE export_jobs (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL,                        -- excel_normalized | excel_legacy | resources
  format       text NOT NULL DEFAULT '',
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  file_name    text NOT NULL DEFAULT '',
  entry_count  integer NOT NULL DEFAULT 0,
  warnings     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by   integer REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id       integer REFERENCES users(id) ON DELETE SET NULL,
  action         text NOT NULL,
  resource_type  text NOT NULL,
  resource_id    text NOT NULL DEFAULT '',
  platform_ids   integer[] NOT NULL DEFAULT '{}',    -- for scoping audit visibility
  language_id    integer,
  before         jsonb,
  after          jsonb,
  job_ref        text,
  ip             text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_resource ON audit_logs (resource_type, resource_id);

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
