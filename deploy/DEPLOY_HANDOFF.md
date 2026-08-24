# DLR Data Pipeline 部署交接

## 部署约定

- 服务器：`121.199.52.72`
- 固定部署入口：`/opt/dlr-data-pipeline/deploy.sh`
- 代码目录：`/opt/dlr-data-pipeline/repository`
- 持久配置：`/opt/dlr-data-pipeline/shared/.env`
- 导入数据目录：`/opt/dlr-data-pipeline/shared/data`
- 部署日志：`/opt/dlr-data-pipeline/shared/logs`
- 默认服务器本机地址：`http://127.0.0.1:3002`

服务器的 80 端口已有其他项目使用，本项目默认使用 3002。当前管理后台没有登录鉴权，所以默认只绑定 `127.0.0.1`，不能直接从公网访问。正式开放时应优先通过带访问控制的 Nginx 或 VPN 代理；确认接受无鉴权公网暴露风险后，才可把 `.env` 中的 `PUBLIC_BIND_ADDRESS` 改成 `0.0.0.0`，并同步调整 `WEB_ORIGIN` 和阿里云安全组。

部署只启动 Web 和 API。淘宝/天猫采集依赖本机 Chrome 登录态，应在采集电脑执行；采集完成的数据可放入服务器共享数据目录，再从管理后台触发导入。

## 首次部署

### 推荐：本地推送制品

服务器不应把跨境 GitHub 链路作为发布前置条件。在本地确认并提交代码后执行：

```bash
pnpm deploy:wuyang
```

该命令使用 `git archive` 打包当前提交，通过已有 SSH 配置上传到服务器，再触发构建和切换。服务器不会访问 GitHub，且未提交和未跟踪文件不会进入制品；工作区不干净时命令会直接拒绝发布。

### 备用：服务器拉取 GitHub

阿里云国内链路访问 GitHub 时应强制使用 HTTP/1.1，并使用浅克隆减少传输量。当前部署代码合并到 `main` 后执行：

```bash
git -c http.version=HTTP/1.1 clone --depth=1 --branch main https://github.com/Dreamsmama/dlr-data-pipeline.git /opt/dlr-data-pipeline/repository
bash /opt/dlr-data-pipeline/repository/deploy.sh
```

如果尚未合并，需要明确指定分支：

```bash
git -c http.version=HTTP/1.1 clone --depth=1 --branch feature/ecommerce-collector https://github.com/Dreamsmama/dlr-data-pipeline.git /opt/dlr-data-pipeline/repository
DEPLOY_BRANCH=feature/ecommerce-collector bash /opt/dlr-data-pipeline/repository/deploy.sh
```

首次运行会生成 `/opt/dlr-data-pipeline/shared/.env` 并停止，同时安装固定入口 `/opt/dlr-data-pipeline/deploy.sh`，并在共享目录记住本次目标分支。填写 PostgreSQL 和 OSS 配置后，直接运行固定入口即可，不要把密钥提交到 Git 或发送到群聊。

## 后续更新

```bash
bash /opt/dlr-data-pipeline/deploy.sh
```

目标分支会持久化到 `/opt/dlr-data-pipeline/shared/deploy-branch`。以后只有切换分支时才需要显式传入，例如 `DEPLOY_BRANCH=main bash /opt/dlr-data-pipeline/deploy.sh`。脚本会依次完成：

1. 检查服务器仓库没有未提交改动，以 HTTP/1.1 浅拉取目标分支；网络失败会自动重试三次。
2. 按 Git 短提交 ID 构建 API 和 Web 镜像，构建期间不停止旧服务。
3. 通过 PostgreSQL advisory lock 幂等执行 migration，已执行且内容未改变的 migration 不会重复运行。
4. 切换容器并检查首页和 `/api/summary`，确认 API 能访问数据库。
5. 失败时停止后续步骤；若旧容器存在，则自动恢复上一版镜像。

数据库 migration 必须保持向后兼容，禁止在同一次发布中直接删除旧版本仍依赖的表或列，否则应用镜像回退无法恢复数据库结构。

## 验收

```bash
curl -fsS http://127.0.0.1:3002/
curl -fsS http://127.0.0.1:3002/api/summary
cd /opt/dlr-data-pipeline/repository
APP_ENV_FILE=/opt/dlr-data-pipeline/shared/.env APP_DATA_DIR=/opt/dlr-data-pipeline/shared/data PUBLIC_BIND_ADDRESS=127.0.0.1 PUBLIC_PORT=3002 docker compose ps
cat /opt/dlr-data-pipeline/shared/current-version
```

`/api/summary` 应返回 `"configured":true`。验收时记录访问地址、Git 提交 ID和容器状态，不要回显 `.env`。

## 日志与手动回退

查看应用日志：

```bash
cd /opt/dlr-data-pipeline/repository
APP_ENV_FILE=/opt/dlr-data-pipeline/shared/.env APP_DATA_DIR=/opt/dlr-data-pipeline/shared/data PUBLIC_BIND_ADDRESS=127.0.0.1 PUBLIC_PORT=3002 docker compose logs --tail 200 api web
```

部署失败会自动使用 `rollback-时间戳` 标签恢复旧镜像。需要手动切回已保留的标签时：

```bash
cd /opt/dlr-data-pipeline/repository
export APP_ENV_FILE=/opt/dlr-data-pipeline/shared/.env
export APP_DATA_DIR=/opt/dlr-data-pipeline/shared/data
export PUBLIC_BIND_ADDRESS=127.0.0.1
export PUBLIC_PORT=3002
export DEPLOY_IMAGE_TAG=rollback-YYYYMMDDHHMMSS
docker compose up -d --no-build --force-recreate api web
```
