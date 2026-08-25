CREATE TABLE IF NOT EXISTS feishu_mention_replacements (
  message_id text PRIMARY KEY
    REFERENCES feishu_messages(message_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  target_chat_id text NOT NULL
    REFERENCES feishu_chats(chat_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  mention_mapping jsonb NOT NULL,
  original_text text NOT NULL,
  resolved_text text NOT NULL,
  evidence_type text NOT NULL DEFAULT 'lark_messages_mget'
    CHECK (evidence_type = 'lark_messages_mget'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(mention_mapping) = 'object'),
  CHECK (mention_mapping <> '{}'::jsonb),
  CHECK (original_text <> resolved_text)
);

CREATE INDEX IF NOT EXISTS feishu_mention_replacements_applied_idx
  ON feishu_mention_replacements (applied_at DESC);
