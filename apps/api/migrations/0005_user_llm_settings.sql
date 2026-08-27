CREATE TABLE IF NOT EXISTS user_llm_settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    is_active boolean NOT NULL DEFAULT true,
    created_by uuid,
    updated_by uuid,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode varchar(20) NOT NULL,
    api_format varchar(30),
    model_name varchar(200) NOT NULL,
    base_url text NOT NULL,
    encrypted_api_key text,
    CONSTRAINT user_llm_settings_user_id_unique UNIQUE (user_id),
    CONSTRAINT user_llm_settings_mode_check CHECK (mode IN ('local', 'remote')),
    CONSTRAINT user_llm_settings_api_format_check CHECK (
        api_format IS NULL OR api_format IN ('openai-compatible', 'anthropic')
    ),
    CONSTRAINT user_llm_settings_remote_key_check CHECK (
        mode = 'local' OR encrypted_api_key IS NOT NULL
    )
);

ALTER TABLE user_llm_settings
    ADD COLUMN IF NOT EXISTS reasoning_effort varchar(20);

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'user_llm_settings'::regclass
          AND conname = 'user_llm_settings_user_id_unique'
    ) THEN
        ALTER TABLE user_llm_settings
            ADD CONSTRAINT user_llm_settings_user_id_unique UNIQUE (user_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'user_llm_settings'::regclass
          AND conname = 'user_llm_settings_mode_check'
    ) THEN
        ALTER TABLE user_llm_settings
            ADD CONSTRAINT user_llm_settings_mode_check CHECK (
                mode IN ('local', 'remote')
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'user_llm_settings'::regclass
          AND conname = 'user_llm_settings_api_format_check'
    ) THEN
        ALTER TABLE user_llm_settings
            ADD CONSTRAINT user_llm_settings_api_format_check CHECK (
                api_format IS NULL OR api_format IN (
                    'openai-compatible', 'anthropic'
                )
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'user_llm_settings'::regclass
          AND conname = 'user_llm_settings_remote_key_check'
    ) THEN
        ALTER TABLE user_llm_settings
            ADD CONSTRAINT user_llm_settings_remote_key_check CHECK (
                mode = 'local' OR encrypted_api_key IS NOT NULL
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'user_llm_settings'::regclass
          AND conname = 'user_llm_settings_reasoning_effort_check'
    ) THEN
        ALTER TABLE user_llm_settings
            ADD CONSTRAINT user_llm_settings_reasoning_effort_check CHECK (
                reasoning_effort IS NULL OR reasoning_effort IN (
                    'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
                )
            );
    END IF;
END
$migration$;
