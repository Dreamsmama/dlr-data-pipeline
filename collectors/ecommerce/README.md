# Ecommerce Collector（小李）

目标：采集 DLR 外部电商平台数据，包括商品基础信息、主图、详情图、SKU、商品文案、商品链接与平台信息。

约定：

1. 平台代码按 `src/platforms/<platform>` 拆分。
2. OSS 对象路径使用 `dlr/ecommerce/<platform>/...`。
3. 图片上传统一调用 `packages/storage`，数据库操作统一放 `packages/database`。
4. 主要修改本目录；不要直接修改 `collectors/internal`。
5. 建业务表时，在 `packages/database/migrations` 添加迁移并提交评审。

## 采集方式

两种采集器输出同一种标准目录结构，后续统一交给 importer 处理。采集器只读取公开页面，遇到登录或安全验证时暂停，不自动处理验证码。

### 方式一：Python + Playwright 直接采集

适合可以稳定访问的公开商品页，也可以通过商品 URL 清单执行小批量采集。

```bash
python -m pip install -r collectors/ecommerce/requirements.txt
python -m playwright install chromium
pnpm collect:ecommerce:python -- \
  --shop-url "https://example.tmall.com/category.htm" \
  --item-id 844862758814 \
  --headed \
  --max-pages 3 \
  --max-products 1 \
  --max-images 80
```

小批量完整性测试应从店铺列表页开始，并通过可重复的 `--item-id` 只选择目标商品。这样会保留列表页生成的
导航参数和公开销量；不要把列表链接改写成只含 `id` 的直链。`--max-images` 是主图、SKU 图和详情图的总上限，
验证完整详情时不应设置成仅够主图与 SKU 图的较小值。

### 方式二：Chrome 扩展采集

推荐在用户自己的 Chrome 会话中运行。先启动带扩展的专用 Chrome；脚本按 `--executable-path`、`CHROME_PATH`、系统常见安装目录的顺序寻找浏览器。

```bash
pnpm extension:ecommerce:start
pnpm extension:ecommerce:run -- \
  --shop-url "https://example.tmall.com/category.htm" \
  --max-pages 1 \
  --max-products 20 \
  --manual-wait
```

也可以在 `chrome://extensions` 中启用开发者模式，手动加载 `collectors/ecommerce/extension`。导出后转换为标准目录：

```bash
pnpm --filter @dlr/ecommerce-collector extension:import -- \
  data/extension/latest.json \
  --out data/extension/catalog
```

### 一键采集（Playwright + Chrome 扩展）

Windows 用户可以从项目根目录执行一个入口命令，自动启动带扩展的专用 Chrome、连接 CDP、驱动扩展完成采集，并把导出结果转换为标准目录：

```powershell
pnpm collect:ecommerce:one-click -- -ShopUrl "https://example.tmall.com/category.htm" -MaxPages 1 -MaxProducts 20 -ManualWait
```

脚本默认将 JSON 写入 `collectors/ecommerce/data/extension/latest.json`，标准目录写入
`collectors/ecommerce/data/extension/catalog`。遇到登录或安全验证时，按提示在打开的 Chrome 中处理后按 Enter 继续；也可以先不加
`-ManualWait`，脚本会以退出码 3 停止，再用 `-Resume -ManualWait` 继续：

```powershell
pnpm collect:ecommerce:one-click -- -Resume -ManualWait
```

只采集并保留扩展 JSON、不执行导入时，增加 `-SkipImport`；导入时不下载图片可增加 `-SkipImages`。首次使用前请确认 Node.js 22+、pnpm 11+、Python 3.10+ 和 Chrome 已安装，并已执行 `pnpm install` 与 `python -m pip install -r collectors/ecommerce/requirements.txt`。

### Linux 服务器远程控制本机 Chrome

如果服务器没有可用的图形桌面，推荐让本机 Chrome 保留登录态，Linux 服务器只负责运行 Playwright、保存结果和执行导入。两端使用 SSH 反向隧道连接 CDP，CDP 端口只绑定在 SSH 本地回环地址，不要开放到公网。

本机先启动带扩展的 Chrome：

```powershell
pnpm extension:ecommerce:start -- --port 9333
```

再在本机保持 SSH 隧道：

```powershell
ssh -N -T -R 19333:127.0.0.1:9333 user@your-server
```

Linux 服务器上执行一键采集。服务器脚本发现 `127.0.0.1:9333` 已经是转发过来的 CDP 后，会连接本机 Chrome，不会再启动第二个浏览器：

```bash
pnpm collect:ecommerce:one-click -- \
  --shop-url "https://example.tmall.com/category.htm" \
  --port 19333 \
  --manual-wait
```

遇到登录或安全验证时，在本机 Chrome 中处理，服务器终端按 Enter 继续。服务器需要 Node.js 22+、pnpm 11+、Python 3.10+ 和项目依赖；本机 Chrome 与服务器的 SSH 会话必须在整个采集过程中保持连接。

生成的数据、浏览器 profile、SQLite 和测试截图均被 `.gitignore` 排除，不得提交 Cookie、账号信息或真实密钥。

运行采集器测试：

```bash
pnpm test:ecommerce-collectors
```

## 蒂洛薇 Tmall 数据导入

Importer 读取标准化数据目录中的 `products/<item_id>/product.json`，图片按 SHA256 上传到私有 OSS，
商品当前态、采集 observation、原始图片 observation 和聚合后的商品资产关系分别入库。原始目录始终只读。

先执行 3 个代表性商品的 dry-run：

```bash
pnpm import:ecommerce -- \
  --full-dir <data-diluowei-full> \
  --extension-dir <data-extension/catalog> \
  --item-id 1000395107293 \
  --item-id 1041927628929 \
  --item-id 1002524899686 \
  --dry-run
```

dry-run 会校验路径边界、JSON 契约、图片状态、文件存在性与 SHA256，不连接 OSS 或 PostgreSQL。
移除 `--dry-run` 后，命令从项目根目录 `.env` 读取数据库和 OSS 配置，先复用或上传内容寻址对象，
再执行 migration 和单批次数据库事务。重复运行不会重复创建商品、observation 或资产。

全量导入使用同一命令但不传 `--item-id`。实际上传前必须先完成小批量导入并核对计数。
