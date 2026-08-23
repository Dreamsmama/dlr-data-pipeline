CREATE TABLE IF NOT EXISTS feishu_chats (
  chat_id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_collected_at timestamptz
);

CREATE TABLE IF NOT EXISTS feishu_collection_jobs (
  id uuid PRIMARY KEY,
  chat_id text NOT NULL REFERENCES feishu_chats(chat_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  chat_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  pages integer NOT NULL DEFAULT 0 CHECK (pages >= 0),
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  attachment_count integer NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
  attachment_failed_count integer NOT NULL DEFAULT 0 CHECK (attachment_failed_count >= 0),
  next_page_token text,
  has_more boolean NOT NULL DEFAULT true,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS feishu_collection_jobs_chat_created_idx
  ON feishu_collection_jobs (chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feishu_collection_jobs_status_idx
  ON feishu_collection_jobs (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS feishu_messages (
  message_id text PRIMARY KEY,
  chat_id text NOT NULL REFERENCES feishu_chats(chat_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  last_job_id uuid REFERENCES feishu_collection_jobs(id) ON UPDATE CASCADE ON DELETE SET NULL,
  sender_id text NOT NULL DEFAULT '',
  sender_name text NOT NULL DEFAULT '',
  sender_type text NOT NULL DEFAULT '',
  msg_type text NOT NULL DEFAULT '',
  create_time timestamptz,
  update_time timestamptz,
  text text NOT NULL DEFAULT '',
  root_id text NOT NULL DEFAULT '',
  parent_id text NOT NULL DEFAULT '',
  deleted boolean NOT NULL DEFAULT false,
  updated boolean NOT NULL DEFAULT false,
  first_collected_at timestamptz NOT NULL DEFAULT now(),
  last_collected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feishu_messages_chat_time_idx
  ON feishu_messages (chat_id, create_time, message_id);
CREATE INDEX IF NOT EXISTS feishu_messages_sender_idx
  ON feishu_messages (chat_id, sender_id, create_time);

CREATE TABLE IF NOT EXISTS feishu_attachments (
  message_id text NOT NULL REFERENCES feishu_messages(message_id) ON UPDATE CASCADE ON DELETE CASCADE,
  file_key text NOT NULL,
  last_job_id uuid REFERENCES feishu_collection_jobs(id) ON UPDATE CASCADE ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('image', 'file')),
  name text NOT NULL DEFAULT '',
  source_status text NOT NULL,
  source_relative_path text NOT NULL DEFAULT '',
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  source_error text NOT NULL DEFAULT '',
  storage_status text NOT NULL DEFAULT 'not_configured'
    CHECK (storage_status IN ('not_configured', 'source_failed', 'uploaded', 'upload_failed')),
  oss_bucket text,
  oss_object_key text,
  oss_etag text,
  storage_error text NOT NULL DEFAULT '',
  uploaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, file_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS feishu_attachments_oss_object_key_idx
  ON feishu_attachments (oss_object_key)
  WHERE oss_object_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS feishu_attachments_storage_status_idx
  ON feishu_attachments (storage_status, updated_at DESC);
