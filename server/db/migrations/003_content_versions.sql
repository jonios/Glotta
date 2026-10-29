-- Content version per platform x language. Apps compare it with the version they last downloaded to
-- know whether that language's keywords for that platform changed. It starts at 1 and goes up by one
-- whenever, for that platform and language:
--   * a translation's value or status changes (added, edited, reviewed, approved, sent back, imported), or
--   * the platform's keyword set changes (key added, removed, renamed, archived/restored, English source
--     edited). These bump every language of the platform.
-- Statement-level triggers keep this automatic for every code path (editor, bulk actions, imports,
-- conflict resolution, key splits) and cheap for large imports: one bump per pair per statement.

CREATE TABLE content_versions (
  platform_id  integer NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  language_id  integer NOT NULL REFERENCES languages(id) ON DELETE CASCADE,
  version      integer NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform_id, language_id)
);

-- Every existing pair starts at version 1. Pairs without a row (new platforms or languages) also count as 1.
INSERT INTO content_versions (platform_id, language_id)
SELECT p.id, l.id FROM platforms p CROSS JOIN languages l;

-- Bumps each distinct (platform, language) pair once.
CREATE FUNCTION bump_content_versions(platform_ids integer[], language_ids integer[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF platform_ids IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO content_versions AS cv (platform_id, language_id, version, updated_at)
  SELECT DISTINCT u.p, u.l, 2, now() FROM unnest(platform_ids, language_ids) AS u(p, l)
  ON CONFLICT (platform_id, language_id) DO UPDATE SET version = cv.version + 1, updated_at = now();
END
$$;

-- ---------------------------------------------------------------- translations
CREATE FUNCTION cv_translations_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bump_content_versions(array_agg(x.platform_id), array_agg(x.language_id))
  FROM (SELECT DISTINCT kp.platform_id, n.language_id
        FROM new_rows n JOIN key_platforms kp ON kp.key_id = n.key_id
        WHERE n.value <> '' OR n.status <> 'missing') x;
  RETURN NULL;
END
$$;

CREATE FUNCTION cv_translations_updated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bump_content_versions(array_agg(x.platform_id), array_agg(x.language_id))
  FROM (SELECT DISTINCT kp.platform_id, n.language_id
        FROM new_rows n JOIN old_rows o ON o.id = n.id JOIN key_platforms kp ON kp.key_id = n.key_id
        WHERE n.value IS DISTINCT FROM o.value OR n.status IS DISTINCT FROM o.status
           OR n.language_id IS DISTINCT FROM o.language_id OR n.key_id IS DISTINCT FROM o.key_id) x;
  RETURN NULL;
END
$$;

CREATE FUNCTION cv_translations_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bump_content_versions(array_agg(x.platform_id), array_agg(x.language_id))
  FROM (SELECT DISTINCT kp.platform_id, o.language_id
        FROM old_rows o JOIN key_platforms kp ON kp.key_id = o.key_id) x;
  RETURN NULL;
END
$$;

CREATE TRIGGER cv_translations_insert AFTER INSERT ON translations
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION cv_translations_inserted();
CREATE TRIGGER cv_translations_update AFTER UPDATE ON translations
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION cv_translations_updated();
CREATE TRIGGER cv_translations_delete AFTER DELETE ON translations
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION cv_translations_deleted();

-- ---------------------------------------------------------------- keys (English source, rename, archive)
CREATE FUNCTION cv_keys_updated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bump_content_versions(array_agg(x.platform_id), array_agg(x.language_id))
  FROM (SELECT DISTINCT kp.platform_id, l.id AS language_id
        FROM new_rows n JOIN old_rows o ON o.id = n.id
        JOIN key_platforms kp ON kp.key_id = n.id
        CROSS JOIN languages l
        WHERE n.source_text IS DISTINCT FROM o.source_text
           OR n.identifier IS DISTINCT FROM o.identifier
           OR n.is_archived IS DISTINCT FROM o.is_archived) x;
  RETURN NULL;
END
$$;

CREATE TRIGGER cv_keys_update AFTER UPDATE ON translation_keys
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION cv_keys_updated();

-- ---------------------------------------------------------------- platform assignment (keywords added/removed/renamed)
CREATE FUNCTION cv_key_platforms_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bump_content_versions(array_agg(x.platform_id), array_agg(x.language_id))
  FROM (SELECT DISTINCT n.platform_id, l.id AS language_id FROM (SELECT DISTINCT platform_id FROM new_rows) n CROSS JOIN languages l) x;
  RETURN NULL;
END
$$;

CREATE FUNCTION cv_key_platforms_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bump_content_versions(array_agg(x.platform_id), array_agg(x.language_id))
  FROM (SELECT DISTINCT o.platform_id, l.id AS language_id FROM (SELECT DISTINCT platform_id FROM old_rows) o CROSS JOIN languages l) x;
  RETURN NULL;
END
$$;

CREATE FUNCTION cv_key_platforms_updated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bump_content_versions(array_agg(x.platform_id), array_agg(x.language_id))
  FROM (SELECT DISTINCT c.platform_id, l.id AS language_id
        FROM (SELECT n.platform_id FROM new_rows n JOIN old_rows o ON o.key_id = n.key_id AND o.platform_id = n.platform_id
              WHERE n.identifier IS DISTINCT FROM o.identifier
              UNION
              SELECT n.platform_id FROM new_rows n WHERE NOT EXISTS (SELECT 1 FROM old_rows o WHERE o.key_id = n.key_id AND o.platform_id = n.platform_id)
              UNION
              SELECT o.platform_id FROM old_rows o WHERE NOT EXISTS (SELECT 1 FROM new_rows n WHERE n.key_id = o.key_id AND n.platform_id = o.platform_id)) c
        CROSS JOIN languages l) x;
  RETURN NULL;
END
$$;

CREATE TRIGGER cv_key_platforms_insert AFTER INSERT ON key_platforms
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION cv_key_platforms_inserted();
CREATE TRIGGER cv_key_platforms_delete AFTER DELETE ON key_platforms
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION cv_key_platforms_deleted();
CREATE TRIGGER cv_key_platforms_update AFTER UPDATE ON key_platforms
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION cv_key_platforms_updated();
