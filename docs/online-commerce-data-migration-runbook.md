# DLR 本地数据迁移到线上 `commerce_data`

## 目标

把本机 PostgreSQL `dlr_data` 中的 DLR 飞书采集业务数据复制到线上 PostgreSQL 的
`commerce_data.public`，不覆盖线上已有业务数据，不复制迁移历史表，也不改动 OSS 对象。

## 数据范围

按外键依赖顺序复制以下表：

1. `feishu_chats`
2. `feishu_collection_jobs`
3. `feishu_messages`
4. `feishu_attachments`
5. `feishu_mention_replacements`

`schema_migrations` 只用于核对两端版本，线上已经执行的迁移记录不会被覆盖。

## 安全边界

- 目标数据库名必须是 `commerce_data`，目标主机不能是本机地址。
- 源、目标迁移版本、列、约束和索引必须一致。
- 目标 5 张业务表必须全部为空，否则中止。
- 写入前停止当前 DLR 服务，目标表在事务中加锁。
- 所有表在一个目标事务中复制，任一步失败全部回滚。
- 凭据只从工作区 `.env` 读取，不写入脚本或日志。

## 验收标准

- 5 张表的源/目标行数完全一致。
- 5 张表按主键排序后的全行内容摘要完全一致。
- 服务重启后 Web、API 与数据页面可访问。
- API 进程存在到线上 PostgreSQL `5432` 的连接，不存在到本机 PostgreSQL `5433` 的连接。

