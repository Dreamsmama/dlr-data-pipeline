# IPv4 访问 Web 时的 API 同源代理设计

## 目标

让局域网设备通过 `http://<开发机 IPv4>:3000` 访问 Web 时可以正常加载 API 数据，同时保留 `http://localhost:3000` 的本机开发体验。

## 适用场景与边界

- 适用于单台 Windows 开发机向同一局域网内设备提供开发预览。
- Web 继续监听 3000，API 继续在开发机本地监听 3001。
- 浏览器不再直接访问 API 3001，而是通过 Web 的 `/api/*` 同源路径转发。
- 本方案不是生产高并发网关；生产环境仍应使用独立反向代理、TLS、访问控制和容量规划。

## 问题原因

1. Web 默认把 API 地址写成 `http://localhost:3001`。远端浏览器会把 `localhost` 解析为远端设备自身。
2. 通过开发机 IPv4 打开页面时，浏览器 Origin 变为 `http://<IPv4>:3000`，不在 API 默认 CORS 白名单 `http://localhost:3000` 中，浏览器会把请求表现为 `Failed to fetch`。

## 方案

1. Web 客户端默认使用相对 API 地址，不再写死 `localhost:3001`。
2. Next.js 将 `/api/:path*` 重写到服务端可访问的 `http://127.0.0.1:3001/api/:path*`。
3. 保留 `NEXT_PUBLIC_API_BASE_URL` 作为显式外部 API 覆盖项；历史默认值 `http://localhost:3001` 视为本地同源模式，避免旧 `.env` 阻止修复生效。
4. 提供 `INTERNAL_API_BASE_URL` 作为服务端代理目标覆盖项，默认指向本机 API。

## 验收标准

- `pnpm typecheck` 退出码为 0。
- `pnpm build` 退出码为 0。
- `GET http://localhost:3000/` 返回 200。
- `GET http://<开发机 IPv4>:3000/` 返回 200。
- `GET http://<开发机 IPv4>:3000/api/summary` 返回 200 和有效 JSON。
- `GET http://<开发机 IPv4>:3000/collectors/feishu` 返回 200，页面不再因 API 基址为 localhost 而显示 `Failed to fetch`。
- `GET http://localhost:3001/health` 仍返回 200 和 `status: ok`。

## 回滚

删除 Web 的 Next.js rewrite 配置，并把客户端 API 基址恢复为显式外部 API 地址。该变更不涉及数据库结构或数据迁移。
