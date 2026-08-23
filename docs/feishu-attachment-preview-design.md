# 飞书 OSS 附件预览设计

## 问题与使用场景

飞书历史消息附件已经成功上传至私有 OSS，但当前服务为所有非图片附件生成
`Content-Disposition: attachment` 的签名地址。用户点击 CSV、TXT、JSON 或 PDF 时，浏览器只能下载，
因此看起来像“OSS 数据查看不了”，实际对象并未丢失。

内部数据页需要同时覆盖两类行为：

- 浏览器可安全展示的只读格式，允许在站内弹窗预览，并保留显式下载入口。
- Office、压缩包、可执行文件等不适合浏览器直接展示的格式，只提供下载，避免伪预览和内容嗅探风险。

## 方案

1. 以附件文件名后缀建立服务端和前端一致的预览白名单：PDF、TXT、CSV、JSON、Markdown 和日志文件；图片沿用现有图片预览。文本预览上限为 2 MB。
2. 私有 OSS 对象通过 API 以流式方式转发，API 根据安全白名单设置 `Content-Type` 与
   `Content-Disposition`：默认 `inline`，请求带 `download=1` 时使用 `attachment`。
3. 内部数据接口返回稳定的本地附件路由，不在消息列表或浏览器地址中暴露短期 OSS 签名；点击时由 API 使用服务端 OSS SDK 打开对象流。
4. 本地暂存附件路由使用同一规则，保证采集页与内部数据页行为一致。
5. HTML、SVG（作为普通文件时）、XML、Office、压缩包和未知格式不进入文件预览白名单，只允许下载。

## 接口约定

- `GET /api/internal/feishu/messages/:messageId/attachments/:fileKey`
  - 可预览格式：内联查看。
  - 不可预览格式：强制下载。
- 上述地址追加 `?download=1`：无论格式均强制下载。
- `GET /api/feishu/jobs/:id/attachments/:messageId/:fileName` 使用相同规则。

## 验收标准

- CSV、TXT、JSON、Markdown 和日志点击“预览”后在站内弹窗读取，PDF 在站内嵌入显示，不再跳转 OSS 域名。
- 可预览文件显示独立“下载”入口，下载响应仍是 `attachment`。
- Office、压缩包和未知格式不显示“预览”，点击附件即下载。
- API 为 CSV 设置 `text/csv; charset=utf-8`，并正确区分 `inline` 与 `attachment`。
- API 支持单段 HTTP Range 转发，PDF 等浏览器预览可以按需读取；文件内容全程流式传输，不整包载入内存。
- 图片预览不回归，失效附件仍显示原有错误信息。
- API 自动化测试、TypeScript 类型检查和 Web 生产构建通过。
- 使用现有私有 OSS 中的真实 CSV 链路验证预览、下载和 Range 三种流式响应。

## 非目标

- 本次不实现 Excel/Word 在线转码预览。
- 本次不实现 CDN 或 OSS 自定义域名直出。在当前内嵌浏览器无法直连 OSS 域名的部署环境中，预览和下载占用 API 与 OSS 之间的流式连接；若未来出现高并发大文件分发，需要单独建设受控下载网关或 CDN。
