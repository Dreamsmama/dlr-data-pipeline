# DLR Data Pipeline

DLR 数据采集后台的统一工程骨架。当前阶段只定义代码边界和可运行入口，不预设业务表。

## 分工

| 范围 | 负责人 | 主要目录 |
| --- | --- | --- |
| 内部历史项目、聊天、需求、反馈、素材 | 小蔡 | `collectors/internal` |
| 外部电商平台商品、SKU、图片、文案 | 小李 | `collectors/ecommerce` |
| Web、API、数据库、OSS、公共类型 | 共同修改，需评审 | `apps`、`packages` |

基本原则：Collector 负责采集，Database 负责落库，Storage 负责 OSS，API 负责读取，Web 负责展示。

## 启动

要求 Node.js 22+、pnpm 11+。

```bash
cp .env.example .env
pnpm install
pnpm dev
```

Windows 下可以直接双击项目根目录的 `start-dev.cmd` 在后台启动 Web 和 API，关闭启动窗口不会停止服务；每次启动的日志写入 `logs` 目录。使用 `status-dev.cmd` 检查状态，使用 `stop-dev.cmd` 停止服务。

- Web: http://localhost:3000
- API 健康检查: http://localhost:3001/health

## PostgreSQL 与 OSS

1. 从 `.env.example` 准备被 Git 忽略的 `.env`，填写本地 PostgreSQL 和阿里云 OSS 配置。
2. 启动本地 PostgreSQL：`docker compose up -d postgres`。
3. 应用数据库结构：`pnpm db:migrate`。
4. 验证私有 OSS 的上传、Head 与清理权限：`pnpm storage:check`。
5. 设置 `FEISHU_PERSISTENCE_MODE=postgres-oss` 后，API 要求数据库与 OSS 配置同时完整；默认 `local` 仍可只使用本地 JSON。

飞书附件仍会先进入被 Git 忽略的本地任务暂存目录，OSS 上传和数据库事务成功后才推进分页令牌。

重叠时间范围重复采集会先复用 PostgreSQL 中的附件成功状态：相同 `message_id + file_key` 已上传时不再下载或上传；失败状态按本地暂存是否有效决定直接重传或重新下载。详细规则见 `docs/feishu-incremental-attachment-design.md`。

单独启动采集器：

```bash
pnpm dev:internal
pnpm dev:ecommerce
```

电商采集器目前仍输出占位信息；Internal Collector 已开始接入飞书历史采集。不要提交真实密码或 AccessKey。

Internal Collector 已提供两种飞书历史消息采集方式：机器人链路验证 App ID/App Secret 后抓取机器人所在群；个人 CLI 链路调用本机官方 `@larksuite/cli --as user`，通过二维码 OAuth 后抓取授权用户可访问的群聊或单聊。两者都使用必填的北京时间分钟范围、同一任务时间线、PostgreSQL 和私有 OSS。详细说明见 `collectors/internal/README.md` 和 `docs/feishu-cli-integration-design.md`。

已入库的飞书消息可从首页“内部数据”进入 `/internal-data`：分为“飞书群组”和“飞书单聊”，支持北京时间小时范围、页内正倒序和固定 20 条分页。内部数据查询以 PostgreSQL 为权威源；私有 OSS 附件通过 API 短时签名访问，本地暂存作为失败回退。

历史本地任务迁移前先执行 dry-run；确认范围后再显式应用，并排除测试群：

```powershell
corepack.cmd pnpm feishu:backfill -- --exclude-chat=oc_demo
corepack.cmd pnpm feishu:backfill -- --apply --exclude-chat=oc_demo
```

## 推荐分支

- 小蔡：`feature/internal-collector`
- 小李：`feature/ecommerce-collector`
- 开发完成后向 `develop` 提交 PR；`main` 仅保留稳定版本。

更多约定见 `docs/architecture.md` 和 `docs/development.md`。

## 服务器部署

阿里云服务器的一键部署入口为 `deploy.sh`。生产配置、端口约定、首次部署与回退说明见 [`deploy/DEPLOY_HANDOFF.md`](deploy/DEPLOY_HANDOFF.md)。
