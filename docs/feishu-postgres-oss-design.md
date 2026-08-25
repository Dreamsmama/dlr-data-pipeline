# 飞书历史记录 PostgreSQL 与 OSS 持久化设计

## 使用场景

- 内部管理员在单机页面手动选择一个飞书群并发起历史消息采集。
- 本轮仍是低并发人工任务，但持久化必须支持同一群反复采集，不能重复插入消息或附件。
- PostgreSQL 保存可查询的权威元数据；阿里云私有 OSS 保存附件原文件；本地任务目录仅作为 Python 下载、断点恢复和人工排障的暂存层。
- App ID / App Secret 仍只进入短期内存会话。OSS AccessKey 和数据库密码只从被 Git 忽略的 `.env` 读取。

## 数据流

1. Python 从飞书按页拉取消息并把附件下载到任务暂存目录。
2. API 收到一页事件后，对可用附件生成确定性的 OSS Object Key 并上传。
3. OSS 上传结果写回该页的附件元数据；上传失败计入附件异常，但本地暂存文件仍可用于排障。
4. Database 在单个事务中幂等写入群聊、消息、附件和任务最新进度。
5. 数据库事务成功后，API 再原子更新本地页 JSON 和任务元数据；事务失败时不推进本地页令牌，恢复任务会重放该页。
6. 当前前端继续从本地页文件读取时间线，避免本轮同时改变展示分页协议；数据库作为后续查询、统计和多实例迁移的权威来源。

## OSS 对象规则

```text
dlr/internal/feishu/<chat-id>/<message-id>/<file-key>__<safe-file-name>
```

- Object Key 不使用来源 URL，不包含凭证，并清理 `.`、`..`、反斜杠和 Windows 非法文件名。
- 同一个 `message-id + file-key` 始终生成同一个键，重复采集使用覆盖上传，保证幂等。
- Bucket 保持私有；前端不暴露长期公网 URL。本轮仍由 API 读取本地暂存附件，后续可改为 API 生成短时签名 URL。
- SDK 强制 HTTPS，Endpoint 只允许配置的阿里云 OSS 域名或明确的自定义域名。

## 数据库结构

### `schema_migrations`

- `name`：迁移文件名，主键。
- `applied_at`：应用时间。

### `feishu_chats`

- `chat_id`：飞书群 ID，主键。
- `name`、`description`。
- `first_seen_at`、`last_seen_at`、`last_collected_at`。

### `feishu_collection_jobs`

- `id`：采集任务 UUID，主键。
- `chat_id`：关联群聊。
- `status`、页数、消息数、附件数、附件异常数。
- `next_page_token`、`has_more`、`error`。
- `created_at`、`updated_at`、`completed_at`。

### `feishu_messages`

- `message_id`：飞书消息 ID，主键；重复采集时更新。
- `chat_id`、`last_job_id`。
- 发送者、消息类型、创建/更新时间、正文、回复关系、删除/编辑状态。
- `first_collected_at`、`last_collected_at`。

### `feishu_attachments`

- 复合主键：`message_id + file_key`。
- `last_job_id`、类型、名称、来源下载状态、本地相对路径、大小和来源错误。
- `storage_status`、`oss_bucket`、`oss_object_key`、`oss_etag`、`storage_error`、`uploaded_at`。
- 重复采集时更新同一行，`oss_object_key` 非空时唯一。

## 事务与失败处理

- 每个消息页使用一个数据库事务；消息和附件全部 `INSERT ... ON CONFLICT DO UPDATE`。
- OSS 在数据库事务前上传。数据库失败时可能存在尚未登记的对象，但确定性 Object Key 使重试自动覆盖，不产生无限重复对象。
- OSS 单文件失败不会丢弃整页消息，附件写为 `upload_failed`，任务最终状态为 `partial`。
- 数据库不可用时不推进本地页令牌，任务失败并保留恢复入口，防止出现“页面显示完成但数据库缺页”。

## 安全边界

- `.env`、`.env.local`、任务暂存目录和日志均被 Git 忽略。
- 日志和 API 错误统一脱敏 `app_secret`、AccessKey、数据库 URL。
- PostgreSQL 仅绑定 `127.0.0.1:5432`；Docker 数据卷不随代码删除。
- OSS RAM 用户应只拥有目标 Bucket 的 `PutObject`、`GetObject`、`HeadObject`、必要的 List 权限；人工测试完成后轮换本次在对话中出现过的 AccessKey。
- 只有显式设置 `FEISHU_PERSISTENCE_MODE=postgres-oss` 才启用外部持久化；配置示例默认 `local`，避免仅复制占位配置时导致 API 无法启动。

## 验收标准

1. 数据库 migration 可重复执行，第二次不重复建表或报错。
2. 同一消息页写入两次后，消息和附件记录数不增加，更新时间会刷新。
3. 附件上传后能通过 Head Object 校验，数据库保存 Bucket、Object Key 和 ETag，不保存 AccessKey。
4. OSS 上传失败时消息仍入库，附件 `storage_status=upload_failed`，任务附件异常数增加。
5. 数据库事务失败时任务状态为 `failed`，本地页令牌不前进，可重新输入飞书凭证恢复。
6. 现有本地时间线、附件预览、消息文本去重和 URL 任务恢复行为不回归。
7. `pnpm test`、`pnpm typecheck`、`pnpm build`、数据库迁移和 OSS 连通性检查全部通过。
8. 启动 Web/API 后模拟首页进入飞书采集页，并用假飞书服务完成一次采集；真实凭证和真实群由用户最终人工审查。
