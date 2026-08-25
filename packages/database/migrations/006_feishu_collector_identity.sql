ALTER TABLE feishu_collection_jobs
  ADD COLUMN IF NOT EXISTS collector_type text NOT NULL DEFAULT 'robot',
  ADD COLUMN IF NOT EXISTS caller_identity text NOT NULL DEFAULT 'bot',
  ADD COLUMN IF NOT EXISTS app_namespace text NOT NULL DEFAULT '';

ALTER TABLE feishu_collection_jobs
  DROP CONSTRAINT IF EXISTS feishu_collection_jobs_collector_type_check,
  DROP CONSTRAINT IF EXISTS feishu_collection_jobs_caller_identity_check,
  DROP CONSTRAINT IF EXISTS feishu_collection_jobs_collector_identity_pair_check;

ALTER TABLE feishu_collection_jobs
  ADD CONSTRAINT feishu_collection_jobs_collector_type_check
    CHECK (collector_type IN ('robot', 'cli')),
  ADD CONSTRAINT feishu_collection_jobs_caller_identity_check
    CHECK (caller_identity IN ('bot', 'user')),
  ADD CONSTRAINT feishu_collection_jobs_collector_identity_pair_check
    CHECK (
      (collector_type = 'robot' AND caller_identity = 'bot')
      OR (collector_type = 'cli' AND caller_identity = 'user')
    );

CREATE INDEX IF NOT EXISTS feishu_collection_jobs_collector_created_idx
  ON feishu_collection_jobs (collector_type, created_at DESC);
