ALTER TABLE feishu_collection_jobs
  ADD COLUMN IF NOT EXISTS start_time timestamptz,
  ADD COLUMN IF NOT EXISTS end_time_exclusive timestamptz;

ALTER TABLE feishu_collection_jobs
  DROP CONSTRAINT IF EXISTS feishu_collection_jobs_time_range_check;

ALTER TABLE feishu_collection_jobs
  ADD CONSTRAINT feishu_collection_jobs_time_range_check
  CHECK (
    (start_time IS NULL AND end_time_exclusive IS NULL)
    OR (start_time IS NOT NULL AND end_time_exclusive IS NOT NULL AND start_time < end_time_exclusive)
  );
