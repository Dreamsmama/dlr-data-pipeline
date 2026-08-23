ALTER TABLE feishu_attachments
  DROP CONSTRAINT IF EXISTS feishu_attachments_storage_status_check;

ALTER TABLE feishu_attachments
  ADD CONSTRAINT feishu_attachments_storage_status_check
  CHECK (storage_status IN ('pending', 'not_configured', 'source_failed', 'uploaded', 'upload_failed'));
