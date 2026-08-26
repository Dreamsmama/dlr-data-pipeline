# DLR Data Pipeline 生产部署交接

## 部署约定

- 服务器 SSH 别名：`wuyang`
- 固定部署入口：`/opt/dlr-data-pipeline/deploy.sh`
- 不可变发布目录：`/opt/dlr-data-pipeline/releases/<完整Git提交ID>`
- 持久配置：`/opt/dlr-data-pipeline/shared/.env`
- 持久数据：`/opt/dlr-data-pipeline/shared/data`
- 数据库备份：`/opt/dlr-data-pipeline/shared/backups`
- 部署日志：`/opt/dlr-data-pipeline/shared/logs`
- 默认监听：`127.0.0.1:3002`

服务器的 80 端口已有其他项目使用。本项目使用独立 Compose project 和 3002，不允许执行全局 Docker 清理。当前管理后台没有登录鉴权；绑定 `0.0.0.0` 前必须在生产配置中显式接受风险，正式运行应增加 HTTPS 和访问控制。

API 镜像包含 Node、pnpm、Python、uv 和飞书 CLI。飞书 CLI 在 Linux 容器中的认证持久化仍需真实扫码、容器重建和 Token 刷新专项验收。淘宝/天猫浏览器采集继续在拥有平台登录态的采集电脑运行，浏览器离线不会阻断普通代码发布。

完整架构、安全边界和验收标准见 `docs/production-one-click-deployment-design.md`。

## 部署前独立体检

首次部署、服务器迁移或基础设施变更后，先执行只读体检：

```bash
pnpm deploy:production -- preflight
```

命令读取 `deploy/targets/wuyang.env` 中不含密钥的服务器基线，通过 SSH 标准输入临时执行 `deploy/preflight.sh`。它不会上传文件、安装软件、构建镜像、修改配置、启动或重启容器，也不会对数据库和 OSS 写入数据。

体检覆盖操作系统和架构、CPU/负载、内存/交换空间、磁盘/inode、Docker/Compose、时间同步、3002 端口、其他 Compose 项目、生产配置文件以及镜像/包管理器/数据库/OSS 的网络可达性。`FAIL` 会返回非零状态并阻止继续部署；`WARN` 允许命令成功退出，但必须由发布人确认风险。

如果 SSH 地址不是可作为画像名称的别名（例如直接使用 IP），需要显式指定：

```bash
pnpm deploy:production -- preflight --server 121.199.52.72 --profile wuyang
```

## 首次初始化

生产服务器应使用 SSH 密钥登录。本地确认代码已经人工验收、提交并位于 `main` 后执行：

```bash
pnpm deploy:production -- bootstrap
```

该命令安装服务器部署依赖并生成 `/opt/dlr-data-pipeline/shared/.env`，不会启动 DLR 或修改其他项目。登录服务器填写所有 `FILL_` 项，密钥不能提交到 Git、终端历史或群聊。

公网绑定还需要：

```dotenv
PUBLIC_BIND_ADDRESS=0.0.0.0
PUBLIC_PORT=3002
WEB_ORIGIN=http://121.199.52.72:3002
ALLOW_UNAUTHENTICATED_PUBLIC_ACCESS=true
```

最后一项只是显式风险确认，不是鉴权功能。阿里云安全组仍需单独放行端口。

## 日常发布

```bash
pnpm deploy:production
```

一个命令会完成：

1. 拒绝非 `main`、未提交或存在未跟踪文件的工作区。
2. 在上传前执行单元测试和类型检查；服务器不可变镜像构建包含应用生产构建。
3. 生成 Git archive 并验证 SHA-256，不依赖服务器访问 GitHub。
4. 检查生产配置、端口、磁盘、内存和 Compose project。
5. 构建不可变 API/Web 镜像，旧服务在构建期间继续运行。
6. 创建并校验 PostgreSQL custom-format 全量备份。
7. 拒绝未显式批准的破坏性 migration，再执行带 advisory lock 的幂等迁移。
8. 切换容器，验证固定运行时、数据库、OSS、内部数据、电商数据和页面。
9. 从部署电脑访问 `WEB_ORIGIN`，验证真实公网链路。
10. 服务器内部验收失败时恢复切换前的代码镜像并重新健康检查。

公网验收失败不会自动回滚服务器内部健康的版本，因为安全组或公网链路失败不代表应用版本损坏；命令仍返回失败，要求人工处理入口。

## 验收、状态和回滚

```bash
pnpm deploy:production -- verify
pnpm deploy:production -- status
pnpm deploy:production -- rollback <Git提交前缀>
```

`verify` 会执行数据库和 OSS 临时写入/清理深度检查。`rollback` 只回滚代码镜像，不自动逆转数据库结构，因此 migration 必须始终向前兼容。

确实需要跳过部署电脑的公网检查时必须显式使用：

```bash
pnpm deploy:production -- verify --skip-public-verify
```

## 直接服务器操作（故障处理）

```bash
bash /opt/dlr-data-pipeline/deploy.sh status
bash /opt/dlr-data-pipeline/deploy.sh verify
bash /opt/dlr-data-pipeline/deploy.sh rollback <Git提交前缀>
```

不要直接编辑 release 目录。配置和数据只允许修改 `shared`，失败时首先查看脚本输出的独立日志路径。
