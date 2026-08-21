# 架构与边界

```text
Internal Collector ─┐
                    ├─> Storage (OSS 原文件) + Database (元数据)
Ecommerce Collector ┘                         │
                                              v
                                         API -> Web
```

- Collector：只负责读取来源数据、规范化元数据、调用公共包。
- Database：唯一的数据库连接与 migration 入口。
- Storage：唯一的 OSS 访问入口；Bucket 默认私有。
- Schemas：Collector、API、Web 共享的数据契约。
- API：向管理后台提供查询接口。
- Web：展示采集到了什么、来源、状态和文件位置。

原始文件保存在 Raw Bucket，推荐名 `wayne-commerce-agent-raw`。聊天记录第一阶段只保存原文件和文件级元数据，不解析内容。
