# Internal Collector（小蔡）

目标：采集 DLR 内部历史项目数据，包括聊天记录、客户需求、客户反馈、商品素材、参考图、历史设计稿及其他内部资料。

约定：

1. 原始文件优先完整保存，聊天记录现阶段不解析。
2. OSS 对象路径使用 `dlr/internal/<category>/...`。
3. 文件上传统一调用 `packages/storage`，数据库操作统一放 `packages/database`。
4. 主要修改本目录；不要直接修改 `collectors/ecommerce`。
5. 建业务表时，在 `packages/database/migrations` 添加迁移并提交评审。
