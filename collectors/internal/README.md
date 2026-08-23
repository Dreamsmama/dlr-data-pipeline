# Internal Collector（小蔡）

目标：采集 DLR 内部历史项目数据，包括聊天记录、客户需求、客户反馈、商品素材、参考图、历史设计稿及其他内部资料。

约定：

1. 原始文件优先完整保存，聊天记录现阶段不解析。
2. OSS 对象路径使用 `dlr/internal/<category>/...`。
3. 文件上传统一调用 `packages/storage`，数据库操作统一放 `packages/database`。
4. 主要修改本目录；不要直接修改 `collectors/ecommerce`。
5. 建业务表时，在 `packages/database/migrations` 添加迁移并提交评审。

## 飞书历史消息 MVP

当前已接入人工采集与前端时间线：

1. 启动 Web 与 API：`pnpm dev`。
2. 打开 `http://localhost:3000/collectors/feishu`；也可以从首页“聊天记录”卡片进入。
3. 使用页面滑轨选择采集方式：
   - “机器人采集”：输入 App ID/App Secret，验证后从机器人已加入的群中单选目标群。
   - “个人 CLI 采集”：接入应用、刷新 OAuth 二维码、扫码确认用户身份，再刷新并单选用户可访问的群聊或单聊。
4. 选择必填的开始和结束时间。输入按北京时间解释、精确到分钟，并依据飞书消息发送时间 `create_time` 抓取；首尾分钟均包含。
5. 点击“开始采集历史记录”，页面会随分页完成逐步追加所选时间段内的消息。

时间范围会写入任务元数据并在失败恢复时保持不变。新任务不允许省略范围；功能上线前创建且没有范围的旧失败任务不能恢复，以免误触发全量采集。详细设计和验收标准见 `docs/feishu-collection-time-range-design.md`。

## PostgreSQL 与 OSS 模式

- 设置 `FEISHU_PERSISTENCE_MODE=postgres-oss` 后，每页消息会幂等写入 PostgreSQL，已下载附件会上传私有阿里云 OSS。
- 重叠范围再次采集时，系统先按 `message_id + file_key` 批量查询历史状态：已成功上传的附件跳过飞书下载和 OSS 上传；上次 OSS 失败但本地暂存仍有效时直接重传；无记录、来源失败或本地失效时才重新下载。完全一致的消息和附件不会刷新业务行更新时间。
- 本地 `run-data` 继续作为 Python 暂存、断点恢复和排障目录，不再是唯一权威数据源。
- 初始化顺序：`docker compose up -d postgres`、`pnpm db:migrate`、`pnpm storage:check`，然后启动 API/Web。
- 表结构和事务策略见 `docs/feishu-postgres-oss-design.md`。
- 增量附件决策和验收标准见 `docs/feishu-incremental-attachment-design.md`。
- 内部数据浏览页位于 `http://localhost:3000/internal-data`，按“飞书群组”和“飞书单聊”分类读取 PostgreSQL 中的去重消息，默认第一页展示最新 20 条，并支持北京时间小时范围与页内正倒序。
- 已有本地任务使用 `pnpm feishu:backfill` 先预览，确认后增加 `--apply`；可用 `--exclude-chat=<chatId>` 排除演示或测试群。命令是幂等的，不会删除本地任务文件。

机器人 App Secret 仅保存在 API 进程内存的短期会话中，通过标准输入交给 Python，不会写入任务文件。CLI App Secret 通过标准输入交给官方 Lark CLI，并由 CLI 专用 profile/Windows 凭据存储管理；项目任务、数据库和浏览器不保存 Secret 或 Token。服务重启或会话过期后需要重新接入；失败任务保留分页令牌，必须使用相同采集器、调用身份和 App 命名空间继续。

CLI 第一版使用本机 `@larksuite/cli` 的实际安装版本，固定 `--as user`，支持群聊和单聊、消息附件下载以及现有 PostgreSQL/OSS 入库。身份映射和完整验收标准见 `docs/feishu-cli-integration-design.md`。

本地任务数据默认保存在被 Git 忽略的 `collectors/internal/run-data/feishu`。当前是便于开发和人工验收的文件存储实现，生产环境仍需按架构计划迁移到 PostgreSQL 和私有 OSS。

运行验证：

```powershell
pnpm typecheck
pnpm test
pnpm build
```

飞书应用至少需要历史消息、群消息、群列表、群成员和消息资源相关权限；机器人必须加入目标群，新增权限后需要重新发布应用版本。
