-- Run once for each Nucleus tenant schema.
-- The tenant schema must be first on search_path.

ALTER TABLE training_jobs
    ADD COLUMN IF NOT EXISTS worker_log TEXT;
