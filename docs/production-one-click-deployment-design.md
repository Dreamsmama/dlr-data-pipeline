# DLR Data Pipeline 生产级一键部署设计

## 1. 目标与适用场景

本方案面向当前实际运行方式：单台 Ubuntu 服务器同时承载多个 Docker 项目，DLR 使用独立 Compose project、外部 PostgreSQL、私有阿里云 OSS，并通过固定端口提供 Web/API。服务器资源有限，发布期间不得停止或清理其他项目。

用户只需要一个本地入口完成首次初始化、日常发布、验收、状态查询和回滚；服务器端仍由多个职责单一的脚本组成，避免把安装、发布、验收和回滚揉成不可测试的单文件。

电商浏览器采集仍在拥有淘宝/天猫登录态的采集电脑运行。生产服务器只负责 Web/API、数据导入和持久化，不把 Chrome/CDP 是否在线作为普通代码发布的阻断条件。

## 2. 非目标和边界

- 本方案不是高可用或多机滚动发布。单机容器切换会有短暂连接抖动；需要零停机时应增加反向代理和蓝绿端口组。
- 脚本不自动修改阿里云安全组、域名 DNS、TLS 证书或第三方账号授权。
- 脚本不把数据库、OSS、飞书或 SSH 密钥写入代码、制品、日志或命令输出。
- 镜像内安装飞书 CLI 不等于飞书用户授权可在无桌面容器中持久化。官方 CLI 在 Linux 默认依赖 Secret Service；认证持久化必须单独完成真实扫码、容器重建和 Token 刷新验收。
- 代码回滚不会自动逆转数据库结构。数据库 migration 必须遵守 expand/migrate/contract：先增加兼容结构，切换代码，后续版本再删除旧结构。

## 3. 用户入口

统一入口为 `pnpm deploy:production -- <command>`：

| 命令 | 用途 | 是否改变生产状态 |
| --- | --- | --- |
| `preflight` | 通过 SSH 标准输入流式执行目标服务器只读体检 | 否 |
| `bootstrap` | 安装服务器基础依赖、生成生产配置模板并执行预检 | 是 |
| `deploy`（默认） | 打包当前已提交版本、上传、备份、迁移、切换、验收 | 是 |
| `verify` | 执行容器、运行时、数据库、OSS、业务接口和公网验收 | OSS/数据库深度检查会写入并删除临时记录 |
| `status` | 查看当前/上一版本、容器和资源状态 | 否 |
| `rollback <version>` | 切换到服务器已保留的指定版本 | 是 |

生产发布默认只允许干净的 `main` 分支。紧急发布其他分支必须显式设置 `DEPLOY_ALLOW_NON_MAIN=1`，并在部署记录中保留分支名和提交 ID。

### 3.1 独立 preflight

`pnpm deploy:production -- preflight` 必须在 Git 工作区未提交、服务器尚未 bootstrap 或应用尚未部署时也能运行。客户端把版本库中的 `deploy/preflight.sh` 通过 SSH 标准输入传给远端 `bash -s`，不上传临时文件，也不依赖服务器已经存在 `/opt/dlr-data-pipeline/deploy.sh`。

目标期望值来自 `deploy/targets/<profile>.env`，只允许保存非敏感信息，例如支持的 OS、CPU 架构、CPU/内存/磁盘最低值、Docker/Compose 最低版本、端口、安装根目录和 Compose project。数据库、OSS、飞书和 SSH 密钥不得进入目标画像。

preflight 的只读边界：

- 不调用包管理器，不安装或升级软件；
- 不上传文件、不拉取镜像、不构建代码；
- 不创建、启动、停止或重建容器；
- 不执行 migration、数据库备份或 PostgreSQL/OSS 写入；
- 不修改防火墙、安全组、系统时间、权限或生产 `.env`；
- 只允许读取 `/etc/os-release`、`/proc`、磁盘、时钟、Docker 状态、端口、生产配置的变量名/非敏感选项，并对外部端点执行 HEAD/TCP 连通性探测。

检查分为 `PASS`、`WARN`、`FAIL`：必需条件失败时汇总所有问题后返回非零；暂时性高负载、首次部署尚无配置、无法从主机内部判断的云安全组和无写入权限下无法验证的 OSS 凭据只产生警告。输出不得包含连接串、AccessKey、密码或 Token。

## 4. 发布流程

```text
本地检查 Git 分支和工作区
  -> 单元测试和类型检查质量门禁
  -> git archive 生成不可变制品并计算 SHA-256
  -> SSH 上传制品、校验和与部署入口
  -> 服务器部署锁
  -> 配置、命令、端口、磁盘、内存预检
  -> 解包到 releases/<完整提交 ID>
  -> 构建带提交标签的 API/Web 镜像（旧服务继续运行）
  -> PostgreSQL custom-format 全量备份并校验目录
  -> 拒绝未显式批准的破坏性 migration
  -> 执行幂等 migration
  -> 切换 API/Web
  -> 容器健康、运行时、数据库、OSS、业务接口验收
  -> 原子记录 current-release/current-version/previous-version
  -> 本地电脑执行公网验收
```

任一步骤失败都返回非零状态。若已经开始切换，则用切换前记录的 release 与镜像重新创建 API/Web，并再次执行基础健康检查。首次部署没有旧版本时只停止本项目失败容器。

## 5. 安全保护

### 5.1 项目隔离

- Compose project 固定为 `dlr-data-pipeline`。
- 容器、镜像、发布目录和日志清理只匹配本项目的明确前缀或完整提交 ID。
- 禁止使用全局 `docker system prune`、清理未使用 volume 或停止其他 Compose project。
- 公网端口已被非本项目进程占用时停止发布。

### 5.2 配置和密钥

- 生产配置固定在 `/opt/dlr-data-pipeline/shared/.env`，权限必须为 `0600`。
- 配置模板只包含占位符，不包含真实密码。
- 公网绑定 `0.0.0.0` 且应用没有鉴权时，必须设置 `ALLOW_UNAUTHENTICATED_PUBLIC_ACCESS=true`；脚本同时打印高风险警告。
- 日志只打印变量名、版本和非敏感 URL，不打印连接串或 AccessKey。

### 5.3 制品完整性

- 只发布已提交的 Git tree，工作区有任何已跟踪或未跟踪改动都拒绝发布。
- 服务器解包前验证 SHA-256、Git 提交格式和 tar 路径穿越。
- 发布目录使用完整 40 位提交 ID；镜像标签使用前 12 位。

## 6. 运行时设计

API 镜像固定并验收以下版本：

- Node.js 22（基础镜像）
- pnpm 11.19.0
- Python 3.12.13（由固定版本 uv 安装到镜像）
- uv 0.11.7
- `@larksuite/cli` 1.0.88

Python/uv 和飞书 CLI 必须在镜像构建期下载，生产容器启动时不临时安装。`/data` 是持久化共享目录，飞书页面、临时附件、Python 虚拟环境缓存和 CLI 配置目录均位于该挂载下。

运行时验收只证明命令存在且版本正确。飞书认证验收分为：

1. `lark-cli doctor --offline` 能读取配置；
2. 完成一次真实二维码登录；
3. 强制重建 API 容器后仍能恢复 profile；
4. 等待一次 Token 刷新周期后仍能读取会话。

任一认证步骤失败时，部署可以成功，但状态必须显示“飞书 CLI 已安装、认证持久化未通过”，不能显示“飞书采集可用”。

## 7. 数据保护

- 每次 migration 前使用固定 PostgreSQL tools 镜像执行 custom-format 全量备份。
- `pg_restore --list` 成功才视为备份有效。
- 默认保留最近 7 个数据库备份和 5 个发布版本；只删除超过保留数量且不是 current/previous 的本项目文件。
- migration 文件一旦执行不得修改，现有数据库层继续使用名称和 SHA-256 校验。
- 新增 migration 包含 `DROP TABLE`、`DROP COLUMN`、`TRUNCATE` 或破坏性类型修改时默认拒绝；紧急情况下要求显式风险开关并先完成人工恢复演练。

## 8. 验收分层

### A. 基础设施

- Docker Engine 与 Compose 可用；服务器时间、磁盘、可用内存满足阈值。
- 公网端口没有被其他项目占用。
- `.env` 权限和必填变量正确。

### B. 容器与运行时

- `api`、`web` 状态为 running/healthy，等待期间没有反复重启。
- API 容器内 Node、pnpm、Python、uv、lark-cli 版本符合固定值。

### C. 数据依赖

- 数据库 migration 成功；深度检查能写入、重复写入并清理临时记录。
- OSS 深度检查能上传、HEAD 并删除临时对象。
- `FEISHU_PERSISTENCE_MODE=postgres-oss`。

### D. 业务冒烟

- `/health` 返回 200。
- `/api/summary` 返回电商 `configured=true`。
- 电商商品和文件列表接口返回 200 且 JSON 结构正确。
- 内部群聊和单聊列表接口返回 200，而不是“未启用 postgres-oss”。
- Web 首页、文件页和内部数据页返回 200。

### E. 公网

- 由部署发起电脑访问 `WEB_ORIGIN`，验证首页、`/health` 和 `/api/summary`。
- 私网部署可以跳过公网验证；声明公网发布时，公网验证失败将整次命令标记为失败，但不会自动回滚一个在服务器内部健康的版本，避免因安全组短暂异常造成数据层反复切换。

## 9. 可观测性与保留

- 每次部署生成独立日志和非敏感 metadata，记录完整提交、分支、制品 SHA-256、开始/结束时间、结果、前后版本和备份文件。
- Docker 日志启用按大小轮转，避免占满磁盘。
- `status` 不读取或输出 `.env` 内容，只显示非敏感状态。
- 失败时显示本次日志路径并保留最后 200 行 API/Web 日志。

## 10. 验收标准

实现完成后必须满足：

1. Shell 静态语法检查和 Node 脚本参数测试通过。
2. 不连接生产服务器也能用 dry-run 模拟 `bootstrap/deploy/verify/status/rollback` 的参数和安全分支。
3. Docker production build（包含应用生产构建）成功，API 镜像内五项运行时版本通过。
4. 项目单元测试、类型检查和生产构建全部通过。
5. 在测试配置下启动 Web/API，按用户页面访问顺序完成业务冒烟，并记录所有失败步骤。
6. 人工确认页面后才允许提交和推送；生产服务器执行 `bootstrap/deploy` 需要用户再次明确授权。
