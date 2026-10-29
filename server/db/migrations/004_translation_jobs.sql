-- AI translation jobs (Auto Translate / batch translation), processed by the in-process worker
-- in server/ai/worker.ts. Everything a job needs to resume after a restart lives here:
-- batches carry leases, items carry per-key outcomes, and progress is always computed from rows.

CREATE TABLE translation_jobs (
  id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','completed','completed_with_errors','failed','cancel_requested','cancelled')),
  mode                text NOT NULL DEFAULT 'interactive' CHECK (mode IN ('interactive','message_batches')),
  source_language_id  integer NOT NULL REFERENCES languages(id),
  target_language_id  integer NOT NULL REFERENCES languages(id) ON DELETE CASCADE,
  platform_ids        integer[] NOT NULL DEFAULT '{}',
  key_ids             integer[],                            -- explicit key selection, or null for the whole scope
  overwrite           text NOT NULL CHECK (overwrite IN ('missing','outdated','unapproved','all')),
  result_status       text NOT NULL CHECK (result_status IN ('draft','needs_review')),
  model               text NOT NULL,
  model_tier          text NOT NULL,
  batch_size          integer NOT NULL,
  dedupe_key          text NOT NULL,
  total_keys          integer NOT NULL DEFAULT 0,
  stats               jsonb NOT NULL DEFAULT '{}'::jsonb,   -- preview numbers at creation (excluded keys etc.)
  input_tokens        bigint NOT NULL DEFAULT 0,
  output_tokens       bigint NOT NULL DEFAULT 0,
  cache_read_tokens   bigint NOT NULL DEFAULT 0,
  api_requests        integer NOT NULL DEFAULT 0,
  anthropic_batch_id  text,                                 -- Message Batches API id (mode = message_batches)
  batch_polled_at     timestamptz,
  error_summary       text NOT NULL DEFAULT '',
  created_by          integer REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- At most one active job per target, source, scope and overwrite mode.
CREATE UNIQUE INDEX translation_jobs_one_active ON translation_jobs (dedupe_key)
  WHERE status IN ('queued','running','cancel_requested');
CREATE INDEX translation_jobs_target ON translation_jobs (target_language_id, created_at DESC);
CREATE INDEX translation_jobs_status ON translation_jobs (status);

-- Application-level batch: one Claude request (or one Message Batches request) for up to batch_size keys.
CREATE TABLE translation_job_batches (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id           integer NOT NULL REFERENCES translation_jobs(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','submitted','done','failed','cancelled','split')),
  attempts         integer NOT NULL DEFAULT 0,
  lease_until      timestamptz,                             -- a running batch whose lease passed is picked up again
  next_attempt_at  timestamptz,
  error            text NOT NULL DEFAULT '',
  input_tokens     bigint NOT NULL DEFAULT 0,
  output_tokens    bigint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
CREATE INDEX translation_job_batches_job ON translation_job_batches (job_id, status);

-- One row per key in a job. source_text is the exact text sent to the model; base_version is the
-- translation row version when the job was created (null = no row), so concurrent edits are detected.
CREATE TABLE translation_job_items (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id        integer NOT NULL REFERENCES translation_jobs(id) ON DELETE CASCADE,
  batch_id      integer REFERENCES translation_job_batches(id) ON DELETE SET NULL,
  key_id        integer NOT NULL REFERENCES translation_keys(id) ON DELETE CASCADE,
  source_text   text NOT NULL,
  base_version  integer,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','translated','skipped','failed')),
  reason        text NOT NULL DEFAULT '',                  -- machine code: empty_source, source_changed, invalid_placeholders, ...
  error         text NOT NULL DEFAULT '',
  attempts      integer NOT NULL DEFAULT 0,
  result_value  text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, key_id)
);
CREATE INDEX translation_job_items_job ON translation_job_items (job_id, status);
CREATE INDEX translation_job_items_batch ON translation_job_items (batch_id);
CREATE INDEX translation_job_items_key ON translation_job_items (key_id);
