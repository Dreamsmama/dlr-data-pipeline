ALTER TABLE feishu_chats
  ADD COLUMN IF NOT EXISTS chat_mode text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS chat_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS external boolean,
  ADD COLUMN IF NOT EXISTS owner_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS p2p_target_type text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS p2p_target_id text NOT NULL DEFAULT '';

-- CLI 个人采集在本迁移之后才接入；迁移前的会话全部来自机器人群聊链路。
UPDATE feishu_chats
SET chat_mode = 'group'
WHERE chat_mode = 'unknown';

ALTER TABLE feishu_chats
  DROP CONSTRAINT IF EXISTS feishu_chats_chat_mode_check,
  DROP CONSTRAINT IF EXISTS feishu_chats_chat_status_check;

ALTER TABLE feishu_chats
  ADD CONSTRAINT feishu_chats_chat_mode_check
    CHECK (chat_mode IN ('group', 'topic', 'p2p', 'unknown')),
  ADD CONSTRAINT feishu_chats_chat_status_check
    CHECK (chat_status IN ('normal', 'dissolved', 'dissolved_save', 'unknown'));

CREATE INDEX IF NOT EXISTS feishu_chats_mode_activity_idx
  ON feishu_chats (chat_mode, last_collected_at DESC, chat_id);
