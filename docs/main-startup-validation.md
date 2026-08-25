# Main 分支本地启动与验收设计

## 目标

在 Windows 本地开发环境拉起 `main` 分支的 Web 与 API 骨架，确认新开发者可以按锁文件完成依赖安装、构建和基本访问。

## 适用场景与边界

- 适用于单机开发预览和第一阶段功能验收。
- 当前 Web/API 返回的是占位内容，不验证 PostgreSQL、OSS 或真实采集链路。
- 本次不把本地开发服务视为生产部署，不覆盖多用户高并发、故障恢复、数据一致性和密钥管理。

## 实施设计

1. 使用 Node.js 22 或更高版本，以及仓库声明的 pnpm 11.19.0。
2. 仅允许 `esbuild` 和 `sharp` 两个已知依赖运行安装构建脚本。
3. 根据 `.env.example` 创建被 Git 忽略的本地 `.env`，不填写真实密钥。
4. 按 `pnpm-lock.yaml` 冻结安装依赖，依次执行类型检查、生产构建和开发服务启动。
5. 从用户视角访问 Web 首页、API 健康检查和摘要接口。本机默认使用 API 端口 3001；若该端口已被无关服务占用，则选择空闲端口，并在验收结果中记录。

## 验收标准

- `git` 当前分支为 `main`，并跟踪 `origin/main`。
- `pnpm install --frozen-lockfile` 退出码为 0，且没有未审核构建脚本。
- `pnpm typecheck` 退出码为 0。
- `pnpm build` 退出码为 0。
- `GET http://localhost:3000/` 返回 200，并包含“数据采集后台”。
- `GET http://localhost:<实际 API 端口>/health` 返回 200，响应包含 `status: ok`。
- `GET http://localhost:<实际 API 端口>/api/summary` 返回 200，且返回当前占位统计结构。
- Web 与 API 保持启动，等待人工验收；人工确认前不提交、不推送。
