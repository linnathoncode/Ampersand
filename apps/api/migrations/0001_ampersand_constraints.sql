-- Run once for each Nucleus tenant schema after its generated tables exist.
-- The tenant schema must be first on search_path so unqualified names resolve there.

DO $migration$
DECLARE
    constraint_definition record;
BEGIN
    FOR constraint_definition IN
        SELECT *
        FROM (VALUES
            ('dataset_columns', 'ck_dataset_columns_role', $$role IN ('feature', 'target', 'time', 'ignored')$$),
            ('dataset_columns', 'ck_dataset_columns_data_type', $$data_type IN ('number', 'integer', 'boolean', 'category', 'text', 'datetime')$$),
            ('dataset_columns', 'ck_dataset_columns_position_nonnegative', $$position >= 0$$),
            ('dataset_snapshots', 'ck_dataset_snapshots_storage_format', $$storage_format IN ('parquet')$$),
            ('dataset_snapshots', 'ck_dataset_snapshots_row_count_positive', $$row_count > 0$$),
            ('training_jobs', 'ck_training_jobs_status', $$status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead')$$),
            ('training_jobs', 'ck_training_jobs_progress_percent_range', $$progress_percent BETWEEN 0 AND 100$$),
            ('training_jobs', 'ck_training_jobs_max_runtime_positive', $$max_runtime_seconds > 0$$),
            ('model_versions', 'ck_model_versions_version_number_positive', $$version_number > 0$$),
            ('model_versions', 'ck_model_versions_status', $$status IN ('candidate', 'published', 'retired')$$),
            ('model_artifacts', 'ck_model_artifacts_format', $$format IN ('onnx')$$),
            ('model_artifacts', 'ck_model_artifacts_size_bytes_positive', $$size_bytes > 0$$),
            ('model_features', 'ck_model_features_position_nonnegative', $$position >= 0$$),
            ('model_features', 'ck_model_features_data_type', $$data_type IN ('number', 'integer', 'boolean', 'category')$$),
            ('model_features', 'ck_model_features_missing_rate_range', $$missing_rate BETWEEN 0 AND 1$$),
            ('model_features', 'ck_model_features_valid_range', $$valid_min IS NULL OR valid_max IS NULL OR valid_min <= valid_max$$),
            ('inference_calls', 'ck_inference_calls_outcome', $$outcome IN ('prediction', 'rejected', 'error')$$),
            ('inference_calls', 'ck_inference_calls_latency_nonnegative', $$latency_ms >= 0$$),
            ('inference_calls', 'ck_inference_calls_prediction_result', $$outcome <> 'prediction' OR prediction IS NOT NULL$$),
            ('inference_calls', 'ck_inference_calls_rejected_result', $$outcome <> 'rejected' OR (prediction IS NULL AND rejection_code IS NOT NULL AND rejection_message IS NOT NULL)$$),
            ('inference_calls', 'ck_inference_calls_error_result', $$outcome <> 'error' OR prediction IS NULL$$)
        ) AS checks(table_name, constraint_name, expression)
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = format('%I.%I', current_schema(), constraint_definition.table_name)::regclass
              AND conname = constraint_definition.constraint_name
        ) THEN
            EXECUTE format(
                'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (%s)',
                current_schema(),
                constraint_definition.table_name,
                constraint_definition.constraint_name,
                constraint_definition.expression
            );
        END IF;
    END LOOP;
END
$migration$;

DO $migration$
DECLARE
    constraint_definition record;
BEGIN
    FOR constraint_definition IN
        SELECT *
        FROM (VALUES
            ('model_versions', 'uq_model_versions_dataset_version', 'dataset_definition_id, version_number'),
            ('model_features', 'uq_model_features_version_column', 'model_version_id, column_name'),
            ('model_features', 'uq_model_features_version_position', 'model_version_id, position'),
            ('model_versions', 'uq_model_versions_training_job_id', 'training_job_id'),
            ('model_artifacts', 'uq_model_artifacts_model_version_id', 'model_version_id'),
            ('tool_definitions', 'uq_tool_definitions_model_version_id', 'model_version_id')
        ) AS unique_keys(table_name, constraint_name, columns)
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = format('%I.%I', current_schema(), constraint_definition.table_name)::regclass
              AND conname = constraint_definition.constraint_name
        ) THEN
            EXECUTE format(
                'ALTER TABLE %I.%I ADD CONSTRAINT %I UNIQUE (%s)',
                current_schema(),
                constraint_definition.table_name,
                constraint_definition.constraint_name,
                constraint_definition.columns
            );
        END IF;
    END LOOP;
END
$migration$;

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = format('%I.model_versions', current_schema())::regclass
          AND conname = 'fk_model_versions_parent_version'
    ) THEN
        ALTER TABLE model_versions
            ADD CONSTRAINT fk_model_versions_parent_version
            FOREIGN KEY (parent_version_id)
            REFERENCES model_versions (id)
            ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = format('%I.model_versions', current_schema())::regclass
          AND conname = 'fk_model_versions_published_by'
    ) THEN
        ALTER TABLE model_versions
            ADD CONSTRAINT fk_model_versions_published_by
            FOREIGN KEY (published_by)
            REFERENCES users (id)
            ON DELETE SET NULL;
    END IF;
END
$migration$;
