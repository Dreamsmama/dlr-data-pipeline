# Ecommerce Collector（小李）

目标：采集 DLR 外部电商平台数据，包括商品基础信息、主图、详情图、SKU、商品文案、商品链接与平台信息。

约定：

1. 平台代码按 `src/platforms/<platform>` 拆分。
2. OSS 对象路径使用 `dlr/ecommerce/<platform>/...`。
3. 图片上传统一调用 `packages/storage`，数据库操作统一放 `packages/database`。
4. 主要修改本目录；不要直接修改 `collectors/internal`。
5. 建业务表时，在 `packages/database/migrations` 添加迁移并提交评审。

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
