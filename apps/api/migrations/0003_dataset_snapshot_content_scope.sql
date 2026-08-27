-- Run once for each Nucleus tenant schema with that schema first on search_path.

ALTER TABLE dataset_snapshots
  DROP CONSTRAINT IF EXISTS dataset_snapshots_content_sha256_unique;

CREATE UNIQUE INDEX IF NOT EXISTS uq_dataset_snapshots_definition_content
  ON dataset_snapshots (dataset_definition_id, content_sha256);
