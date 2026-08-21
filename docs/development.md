# 开发约定

1. 从 `.env.example` 复制本地 `.env`，不得提交真实密钥。
2. 小蔡主要修改 `collectors/internal`，小李主要修改 `collectors/ecommerce`。
3. 公共包的修改必须说明两个采集器的兼容性影响。
4. 新业务表由实现者在 `packages/database/migrations` 添加 migration，不在 Collector 中散落 SQL 建表脚本。
5. 合并前运行 `pnpm typecheck` 和 `pnpm build`。
6. OSS 对象路径保持可追溯，不使用原始 URL 作为数据库主键。
