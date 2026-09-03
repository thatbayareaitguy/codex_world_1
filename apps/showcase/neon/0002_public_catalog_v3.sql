ALTER TABLE showcase.catalog_snapshots
  DROP CONSTRAINT IF EXISTS catalog_snapshots_contract_version_check;

ALTER TABLE showcase.catalog_snapshots
  ADD CONSTRAINT catalog_snapshots_contract_version_check
  CHECK (contract_version IN ('showcase-public-v2', 'showcase-public-v3'));

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

REVOKE ALL ON FUNCTION showcase.publish_catalog(text, timestamptz, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION showcase.publish_catalog(text, timestamptz, text, jsonb)
  FROM showcase_web_readonly;
GRANT EXECUTE ON FUNCTION showcase.publish_catalog(text, timestamptz, text, jsonb)
  TO showcase_publisher;
