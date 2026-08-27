ALTER TABLE training_jobs
  DROP CONSTRAINT IF EXISTS training_jobs_fingerprint_unique;

DROP INDEX IF EXISTS training_jobs_fingerprint_unique;

CREATE INDEX IF NOT EXISTS idx_training_jobs_fingerprint
  ON training_jobs (fingerprint);
