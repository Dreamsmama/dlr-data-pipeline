CREATE INDEX IF NOT EXISTS feishu_messages_chat_recent_idx
  ON feishu_messages (chat_id, create_time DESC NULLS LAST, message_id DESC);
