-- Run once for each Nucleus tenant schema.
  -- The tenant schema must be first on search_path.

  ALTER TABLE model_versions
      ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS retired_by UUID;

  DO $migration$
  BEGIN
      IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid =
              format('%I.model_versions', current_schema())::regclass
            AND conname = 'fk_model_versions_retired_by'
      ) THEN
          ALTER TABLE model_versions
              ADD CONSTRAINT fk_model_versions_retired_by
              FOREIGN KEY (retired_by)
              REFERENCES users (id)
              ON DELETE SET NULL;
      END IF;
  END
  $migration$;