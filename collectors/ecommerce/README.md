# Ecommerce Collector（小李）

目标：采集 DLR 外部电商平台数据，包括商品基础信息、主图、详情图、SKU、商品文案、商品链接与平台信息。

约定：

1. 平台代码按 `src/platforms/<platform>` 拆分。
2. OSS 对象路径使用 `dlr/ecommerce/<platform>/...`。
3. 图片上传统一调用 `packages/storage`，数据库操作统一放 `packages/database`。
4. 主要修改本目录；不要直接修改 `collectors/internal`。
5. 建业务表时，在 `packages/database/migrations` 添加迁移并提交评审。
