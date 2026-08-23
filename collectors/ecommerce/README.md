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
  --headed \
  --max-pages 3 \
  --max-products 200 \
  --max-images 150
```

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
