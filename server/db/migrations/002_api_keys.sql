-- API keys for the read-only public API (/api/v1). Only a SHA-256 hash of each key is stored.
-- A key acts with the language and platform access of the user who created it, and only while
-- that user is active and still a Super Admin or Translation Manager.
CREATE TABLE api_keys (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  prefix        text NOT NULL,                        -- first characters of the key, shown to identify it
  key_hash      text NOT NULL UNIQUE,                 -- sha256 of the full key
  created_by    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,                          -- null = never expires
  last_used_at  timestamptz,
  last_used_ip  text NOT NULL DEFAULT '',
  use_count     integer NOT NULL DEFAULT 0,
  revoked_at    timestamptz,
  revoked_by    integer REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX api_keys_creator ON api_keys (created_by);
