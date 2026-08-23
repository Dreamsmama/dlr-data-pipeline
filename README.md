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

单独启动采集器：

```bash
pnpm dev:internal
pnpm dev:ecommerce
```

采集器目前只输出占位信息，业务逻辑由各负责人补充。不要提交真实密码或 AccessKey。

## 推荐分支

- 小蔡：`feature/internal-collector`
- 小李：`feature/ecommerce-collector`
- 开发完成后向 `develop` 提交 PR；`main` 仅保留稳定版本。

更多约定见 `docs/architecture.md` 和 `docs/development.md`。
