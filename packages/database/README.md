# Database

统一管理 PostgreSQL 连接和迁移。当前不预设业务表；两位负责人新增表或字段时，将迁移放入 `migrations` 并走代码评审。Collector 内禁止另建数据库连接封装。
