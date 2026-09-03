CREATE SCHEMA IF NOT EXISTS showcase AUTHORIZATION showcase_schema_owner;
ALTER SCHEMA showcase OWNER TO showcase_schema_owner;
REVOKE ALL ON SCHEMA showcase FROM PUBLIC;

SET LOCAL ROLE showcase_schema_owner;

CREATE TABLE IF NOT EXISTS showcase.catalog_snapshots (
  catalog_version bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_version text NOT NULL,
  generated_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  content_sha256 text NOT NULL UNIQUE,
  catalog jsonb NOT NULL,
  CONSTRAINT catalog_snapshots_contract_version_check
    CHECK (contract_version IN ('showcase-public-v2', 'showcase-public-v3')),
  CONSTRAINT catalog_snapshots_content_sha256_check
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT catalog_snapshots_catalog_object_check
    CHECK (jsonb_typeof(catalog) = 'object')
);

CREATE OR REPLACE VIEW showcase.current_catalog
WITH (security_barrier = true)
AS
SELECT
  catalog_version,
  contract_version,
  generated_at,
  published_at,
  content_sha256,
  catalog
FROM showcase.catalog_snapshots
ORDER BY catalog_version DESC
LIMIT 1;

CREATE OR REPLACE FUNCTION showcase.publish_catalog(
  requested_contract_version text,
  requested_generated_at timestamptz,
  requested_content_sha256 text,
  requested_catalog jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, showcase
AS $publish_catalog$
DECLARE
  published_version bigint;
BEGIN
  IF requested_contract_version <> 'showcase-public-v3' THEN
    RAISE EXCEPTION 'unsupported Showcase public contract version';
  END IF;

  IF requested_content_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid Showcase catalog content hash';
  END IF;

  IF requested_catalog IS NULL OR jsonb_typeof(requested_catalog) <> 'object' THEN
    RAISE EXCEPTION 'Showcase catalog must be a JSON object';
  END IF;

  IF NOT requested_catalog ?& ARRAY[
    'contractVersion',
    'generatedAt',
    'genres',
    'artists',
    'releases'
  ] THEN
    RAISE EXCEPTION 'Showcase catalog is missing required public fields';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(requested_catalog) AS catalog_key(key)
    WHERE key <> ALL (ARRAY[
      'contractVersion',
      'generatedAt',
      'genres',
      'artists',
      'releases'
    ])
  ) THEN
    RAISE EXCEPTION 'Showcase catalog contains an unsupported top-level field';
  END IF;

  IF requested_catalog ->> 'contractVersion' <> requested_contract_version THEN
    RAISE EXCEPTION 'Showcase contract version metadata does not match';
  END IF;

  IF (requested_catalog ->> 'generatedAt')::timestamptz <> requested_generated_at THEN
    RAISE EXCEPTION 'Showcase generated timestamp metadata does not match';
  END IF;

  IF jsonb_typeof(requested_catalog -> 'genres') <> 'array'
    OR jsonb_typeof(requested_catalog -> 'artists') <> 'array'
    OR jsonb_typeof(requested_catalog -> 'releases') <> 'array' THEN
    RAISE EXCEPTION 'Showcase public collections must be JSON arrays';
  END IF;

  INSERT INTO showcase.catalog_snapshots (
    contract_version,
    generated_at,
    content_sha256,
    catalog
  )
  VALUES (
    requested_contract_version,
    requested_generated_at,
    requested_content_sha256,
    requested_catalog
  )
  ON CONFLICT (content_sha256) DO NOTHING
  RETURNING catalog_version INTO published_version;

  IF published_version IS NULL THEN
    SELECT catalog_version
    INTO STRICT published_version
    FROM showcase.catalog_snapshots
    WHERE content_sha256 = requested_content_sha256;
  END IF;

  RETURN published_version;
END
$publish_catalog$;

COMMENT ON SCHEMA showcase IS
  'Sanitized Showcase public catalog boundary. Private scanner data and editorial evidence are prohibited.';
COMMENT ON TABLE showcase.catalog_snapshots IS
  'Immutable validated snapshots of the sanitized Showcase public contract.';
COMMENT ON VIEW showcase.current_catalog IS
  'The latest sanitized Showcase public catalog snapshot.';
COMMENT ON FUNCTION showcase.publish_catalog(text, timestamptz, text, jsonb) IS
  'The only write entry point granted to the local Showcase publisher.';

REVOKE ALL ON TABLE showcase.catalog_snapshots FROM PUBLIC;
REVOKE ALL ON SEQUENCE showcase.catalog_snapshots_catalog_version_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION showcase.publish_catalog(text, timestamptz, text, jsonb) FROM PUBLIC;

REVOKE ALL ON TABLE showcase.catalog_snapshots FROM showcase_publisher;
REVOKE ALL ON SEQUENCE showcase.catalog_snapshots_catalog_version_seq FROM showcase_publisher;
GRANT USAGE ON SCHEMA showcase TO showcase_publisher;
GRANT SELECT ON TABLE showcase.current_catalog TO showcase_publisher;
GRANT EXECUTE ON FUNCTION showcase.publish_catalog(text, timestamptz, text, jsonb)
  TO showcase_publisher;

REVOKE ALL ON TABLE showcase.catalog_snapshots FROM showcase_web_readonly;
REVOKE ALL ON SEQUENCE showcase.catalog_snapshots_catalog_version_seq FROM showcase_web_readonly;
REVOKE ALL ON FUNCTION showcase.publish_catalog(text, timestamptz, text, jsonb)
  FROM showcase_web_readonly;
GRANT USAGE ON SCHEMA showcase TO showcase_web_readonly;
GRANT SELECT ON TABLE showcase.current_catalog TO showcase_web_readonly;

RESET ROLE;

REVOKE CREATE ON SCHEMA public FROM showcase_publisher, showcase_web_readonly;

DO $showcase_database_grants$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO showcase_publisher, showcase_web_readonly',
    current_database()
  );
END
$showcase_database_grants$;
