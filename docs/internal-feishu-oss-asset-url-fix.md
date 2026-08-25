# 内部飞书附件直连 OSS 修复设计

## 背景与问题

内部数据页当前把图片和文件渲染为本地 API 地址：

`http://localhost:3001/api/internal/feishu/messages/:messageId/attachments/:fileKey`

API 再通过 302 跳转到私有 OSS 的临时签名地址。数据库实际保存的是
`oss_bucket`、`oss_object_key` 和 `oss_etag`，并未保存本地 URL；但页面附件展示仍依赖本地 API，离开本机或 API 地址变化后会失效。

## 目标

- OSS 上传后只持久化 bucket、object key、etag 等稳定对象信息。
- 不把 `localhost`、局域网地址或会过期的签名 URL 写入数据库。
- 历史消息接口按请求即时生成私有 OSS 签名 URL。
- 内部数据页的 OSS 图片 `src` 和文件 `href` 直接使用该 OSS URL。
- 非 OSS/来源失败附件保持不可用提示，不错误回退到本地路径。
- 保留现有单附件跳转接口，兼容旧调用方，但内部数据页不再依赖它。

## 数据与接口设计

数据库结构不变。`GET /api/internal/feishu/chats/:chatId/messages` 返回附件时增加：

```json
{
  "ossBucket": "private-bucket",
  "ossObjectKey": "dlr/internal/feishu/...",
  "url": "https://private-bucket.oss-.../...?Expires=...&Signature=..."
}
```

`url` 只存在于本次 HTTP 响应中，不落库。仅当以下条件全部满足时生成：

1. `storageStatus === "uploaded"`
2. bucket 与当前配置一致
3. object key 非空
4. 存储实现支持签名 URL

图片使用 inline 签名；普通文件使用带下载响应头的签名。默认有效期 15 分钟，刷新页面会获取新地址。

## 安全与运行场景

- OSS 桶继续保持私有，避免采集的聊天附件被公开访问。
- 前端拿到的签名 URL 有有效期，属于短期授权，不是永久链接。
- API 响应不得被共享缓存，设置 `Cache-Control: private, no-store`。
- URL 中的签名和 AccessKey ID 不写日志、不写数据库、不写本地采集文件。
- 页面在局域网其他设备打开时，不再因为附件地址指向访问者自己的 `localhost` 而失败。

## 验收标准

1. 消息接口对已上传附件返回 `https://...oss...` 的直接 `url`。
2. 接口响应中的已上传附件 URL 不包含 `localhost`、`127.0.0.1` 或局域网 API 地址。
3. 数据库附件记录仍只包含 bucket/object key/etag，不新增 URL 字段。
4. 内部数据页图片的 `src` 和文件的 `href` 使用接口返回的 OSS URL。
5. 来源失败附件没有 URL，继续显示明确错误。
6. 原有单附件接口仍能 302 到 OSS，兼容旧调用方。
7. API 单测、Python 单测、类型检查和生产构建通过。
8. 使用真实数据打开内部数据页，至少一张 OSS 图片成功加载，文件链接可发起 OSS 下载。
