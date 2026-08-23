import { createReadStream } from "node:fs";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import type { FeishuChatCategory } from "@dlr/database";

import { FileJobStore, type JobPersistence } from "./feishu/job-store.js";
import { CliAttachmentWorker } from "./feishu/attachment-worker.js";
import type { FeishuHistoryDataSource } from "./feishu/external-persistence.js";
import { FeishuJobRunner } from "./feishu/job-runner.js";
import { LarkCliFeishuBridge } from "./feishu/lark-cli-bridge.js";
import { PythonFeishuBridge } from "./feishu/python-bridge.js";
import { CredentialSessionStore } from "./feishu/session-store.js";
import type { FeishuBridge, UserCliFeishuBridge } from "./feishu/types.js";

export interface BuildAppOptions {
  dataRoot: string;
  pythonProject: string;
  pythonScript: string;
  bridge?: FeishuBridge;
  cliBridge?: UserCliFeishuBridge;
  sessionTtlMs?: number;
  allowedOrigins?: string[];
  logger?: boolean;
  persistence?: JobPersistence;
  history?: FeishuHistoryDataSource;
  persistenceMode?: "local" | "postgres-oss";
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/app_secret\s*[=:]\s*[^\s,}&}]+/gi, "app_secret=[REDACTED]")
    .replace(/(?:access|refresh|tenant|user)[-_ ]?token\s*[=:]\s*[^\s,}&}]+/gi, "token=[REDACTED]")
    .replace(/device[-_ ]?code\s*[=:]\s*[^\s,}&}]+/gi, "device_code=[REDACTED]")
    .replace(/access[-_ ]?key(?:[-_ ]?(?:id|secret))?\s*[=:]\s*[^\s,}&}]+/gi, "AccessKey=[REDACTED]")
    .replace(/signature\s*[=:]\s*[^\s,}&}]+/gi, "Signature=[REDACTED]");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function contentType(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".pdf": return "application/pdf";
    case ".txt": return "text/plain; charset=utf-8";
    case ".csv": return "text/csv; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".md": return "text/plain; charset=utf-8";
    case ".log": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

const INLINE_FILE_EXTENSIONS = new Set([".pdf", ".txt", ".csv", ".json", ".md", ".log"]);
const INLINE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function canPreviewAttachment(fileName: string, attachmentType?: "image" | "file"): boolean {
  const extension = path.extname(fileName).toLowerCase();
  if (attachmentType === "image") return extension === "" || INLINE_IMAGE_EXTENSIONS.has(extension);
  return INLINE_FILE_EXTENSIONS.has(extension) || (attachmentType === undefined && INLINE_IMAGE_EXTENSIONS.has(extension));
}

function contentDisposition(fileName: string, download: boolean): string {
  return `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(fileName || "download")}`;
}

function validByteRange(value: string): boolean {
  return /^bytes=(?:\d+-\d*|-\d+)$/.test(value);
}

function proxiedContentType(
  declaredType: string,
  storedType: string,
  attachmentType: "image" | "file",
): string {
  if (declaredType !== "application/octet-stream" || attachmentType !== "image") return declaredType;
  return /^image\/(?:png|jpeg|gif|webp)(?:;|$)/i.test(storedType) ? storedType : declaredType;
}

function parseInstant(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label}格式不合法`);
  return date.toISOString();
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1_000;

function parseBeijingMinute(value: unknown, label: string): number {
  const text = String(value ?? "");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!match) throw new Error(`${label}格式不合法，请精确选择到分钟`);
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour - 8, minute, 0, 0);
  const normalizedBeijing = new Date(utc.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 16);
  if (normalizedBeijing !== text) throw new Error(`${label}不是有效的北京时间`);
  return utc.getTime();
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 64 * 1024,
  });
  const origins = new Set(options.allowedOrigins ?? ["http://localhost:3000"]);
  const store = new FileJobStore(options.dataRoot, options.persistence);
  await store.initialize();
  const sessions = new CredentialSessionStore(options.sessionTtlMs);
  const bridge = options.bridge ?? new PythonFeishuBridge({
    pythonProject: options.pythonProject,
    scriptPath: options.pythonScript,
    dataRoot: options.dataRoot,
  });
  const cliBridge = options.cliBridge ?? new LarkCliFeishuBridge({
    dataRoot: options.dataRoot,
    attachmentTimeoutMs: positiveInteger(process.env.FEISHU_CLI_ATTACHMENT_TIMEOUT_MS, 30 * 60 * 1000),
  });
  const attachmentWorker = new CliAttachmentWorker(store, cliBridge, {
    maxAttempts: positiveInteger(process.env.FEISHU_CLI_ATTACHMENT_MAX_ATTEMPTS, 3),
  });
  await attachmentWorker.initialize();
  const runner = new FeishuJobRunner(store, sessions, bridge, cliBridge, attachmentWorker);

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && origins.has(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Headers", "Content-Type");
      reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    }
  });
  app.options("/*", async (_request, reply) => reply.code(204).send());

  app.get("/health", async () => ({
    status: "ok",
    service: "dlr-api",
    persistence: options.persistenceMode ?? "local",
  }));
  app.get("/api/summary", async () => ({
    internalFiles: store.list().reduce((total, job) => total + job.attachmentCount, 0),
    chatFiles: store.list().reduce((total, job) => total + job.messageCount, 0),
    ecommerceProducts: 0,
    assets: store.list().reduce((total, job) => total + job.attachmentCount, 0),
    note: options.persistenceMode === "postgres-oss"
      ? "飞书元数据写入 PostgreSQL，附件上传私有 OSS，本地目录保留为暂存层"
      : "飞书采集数据当前使用本地文件持久化",
  }));

  app.post<{ Body: { appId?: string; appSecret?: string } }>(
    "/api/feishu/sessions",
    async (request, reply) => {
      const appId = String(request.body?.appId ?? "").trim();
      const appSecret = String(request.body?.appSecret ?? "");
      if (!appId || !appSecret) {
        return reply.code(400).send({ error: "App ID 和 App Secret 不能为空" });
      }
      try {
        const chats = await bridge.discoverChats(appId, appSecret);
        return sessions.createBot(appId, appSecret, chats);
      } catch (error) {
        return reply.code(401).send({ error: publicError(error) });
      }
    },
  );

  app.post<{ Body: { appId?: string; appSecret?: string } }>(
    "/api/feishu/cli/connections",
    async (request, reply) => {
      const appId = String(request.body?.appId ?? "").trim();
      const appSecret = String(request.body?.appSecret ?? "");
      if (!appId || !appSecret) return reply.code(400).send({ error: "App ID 和 App Secret 不能为空" });
      try {
        return await cliBridge.configureApp(appId, appSecret);
      } catch (error) {
        return reply.code(400).send({ error: publicError(error) });
      }
    },
  );

  app.post<{ Body: { appId?: string } }>(
    "/api/feishu/cli/connections/restore",
    async (request, reply) => {
      const appId = String(request.body?.appId ?? "").trim();
      if (!appId) return reply.code(400).send({ error: "App ID 不能为空" });
      try {
        return await cliBridge.restoreApp(appId);
      } catch (error) {
        return reply.code(409).send({ error: publicError(error) });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/feishu/cli/connections/:id/auth",
    async (request, reply) => {
      try {
        const challenge = await cliBridge.beginAuth(request.params.id);
        return {
          ...challenge,
          qrCodeUrl: `/api/feishu/cli/auth/${encodeURIComponent(challenge.authSessionId)}/qrcode`,
        };
      } catch (error) {
        return reply.code(400).send({ error: publicError(error) });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/feishu/cli/auth/:id/qrcode",
    async (request, reply) => {
      try {
        const qrPath = await cliBridge.resolveQrCode(request.params.id);
        reply.type("image/png");
        reply.header("Cache-Control", "private, no-store");
        reply.header("X-Content-Type-Options", "nosniff");
        return reply.send(createReadStream(qrPath));
      } catch (error) {
        return reply.code(404).send({ error: publicError(error) });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/feishu/cli/auth/:id/complete",
    async (request, reply) => {
      try {
        return await cliBridge.completeAuth(request.params.id);
      } catch (error) {
        return reply.code(401).send({ error: publicError(error) });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/feishu/cli/connections/:id/chats",
    async (request, reply) => {
      try {
        const access = await cliBridge.discoverChats(request.params.id);
        return sessions.createCli(
          access.profile,
          access.appNamespace,
          access.userName,
          access.chats,
        );
      } catch (error) {
        return reply.code(401).send({ error: publicError(error) });
      }
    },
  );

  app.get("/api/feishu/jobs", async () => ({ items: store.list() }));

  app.get<{ Querystring: { category?: string } }>("/api/internal/feishu/chats", async (request, reply) => {
    if (!options.history) {
      return reply.code(503).send({ error: "内部数据查询需要启用 postgres-oss 持久化模式" });
    }
    const requestedCategory = request.query.category;
    if (requestedCategory && requestedCategory !== "group" && requestedCategory !== "p2p") {
      return reply.code(400).send({ error: "category 只能是 group 或 p2p" });
    }
    try {
      return { items: await options.history.listChats(requestedCategory as FeishuChatCategory | undefined) };
    } catch (error) {
      return reply.code(500).send({ error: publicError(error) });
    }
  });

  app.get<{
    Params: { chatId: string };
    Querystring: {
      page?: string;
      pageSize?: string;
      order?: string;
      from?: string;
      to?: string;
      snapshot?: string;
    };
  }>("/api/internal/feishu/chats/:chatId/messages", async (request, reply) => {
    if (!options.history) {
      return reply.code(503).send({ error: "内部数据查询需要启用 postgres-oss 持久化模式" });
    }
    const page = Math.max(1, Number.parseInt(request.query.page ?? "1", 10) || 1);
    const requestedPageSize = Number.parseInt(request.query.pageSize ?? "20", 10) || 20;
    if (requestedPageSize !== 20) {
      return reply.code(400).send({ error: "内部飞书数据当前固定每页展示 20 条" });
    }
    const order = request.query.order ?? "asc";
    if (order !== "asc" && order !== "desc") {
      return reply.code(400).send({ error: "order 只能是 asc 或 desc" });
    }
    let from: string | undefined;
    let to: string | undefined;
    let snapshotAt: string;
    try {
      from = parseInstant(request.query.from, "开始时间");
      to = parseInstant(request.query.to, "结束时间");
      snapshotAt = parseInstant(request.query.snapshot, "数据快照时间") ?? new Date().toISOString();
    } catch (error) {
      return reply.code(400).send({ error: publicError(error) });
    }
    if (from && to && new Date(from).getTime() >= new Date(to).getTime()) {
      return reply.code(400).send({ error: "开始时间必须早于结束时间" });
    }
    try {
      const result = await options.history.listMessages({
        chatId: request.params.chatId,
        page,
        pageSize: 20,
        order,
        snapshotAt,
        from,
        to,
      });
      if (!result) return reply.code(404).send({ error: "飞书会话不存在" });
      const items = result.items.map((message) => ({
        ...message,
        attachments: message.attachments.map((attachment) => {
          const available = ["downloaded", "reused"].includes(attachment.status);
          return {
            ...attachment,
            url: available
              ? `/api/internal/feishu/messages/${encodeURIComponent(message.messageId)}/attachments/${encodeURIComponent(attachment.fileKey)}`
              : "",
          };
        }),
      }));
      reply.header("Cache-Control", "private, no-store");
      return { ...result, items };
    } catch (error) {
      return reply.code(500).send({ error: publicError(error) });
    }
  });

  app.get<{
    Params: { messageId: string; fileKey: string };
    Querystring: { download?: string };
  }>("/api/internal/feishu/messages/:messageId/attachments/:fileKey", async (request, reply) => {
    if (!options.history) {
      return reply.code(503).send({ error: "内部数据查询需要启用 postgres-oss 持久化模式" });
    }
    try {
      const attachment = await options.history.getAttachment(request.params.messageId, request.params.fileKey);
      if (!attachment) return reply.code(404).send({ error: "附件不存在" });
      const fileName = attachment.name || attachment.fileKey;
      const type = contentType(fileName);
      const download = request.query.download === "1" || !canPreviewAttachment(fileName, attachment.type);
      const range = typeof request.headers.range === "string" ? request.headers.range : undefined;
      if (range && !validByteRange(range)) {
        return reply.code(416).send({ error: "Range 请求格式不合法" });
      }
      const storedObject = await options.history.readAttachment(attachment, range);
      if (storedObject) {
        reply.code(storedObject.statusCode === 206 ? 206 : 200);
        reply.type(proxiedContentType(type, storedObject.contentType, attachment.type));
        reply.header("Cache-Control", "private, no-store");
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header("Content-Disposition", contentDisposition(fileName, download));
        if (storedObject.contentLength) reply.header("Content-Length", storedObject.contentLength);
        if (storedObject.contentRange) reply.header("Content-Range", storedObject.contentRange);
        if (storedObject.acceptRanges) reply.header("Accept-Ranges", storedObject.acceptRanges);
        if (storedObject.etag) reply.header("ETag", storedObject.etag);
        if (storedObject.lastModified) reply.header("Last-Modified", storedObject.lastModified);
        return reply.send(storedObject.stream);
      }
      const signedUrl = options.history.createAttachmentUrl(attachment, { download });
      if (signedUrl) return reply.redirect(signedUrl);

      const parts = attachment.relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
      if (!attachment.lastJobId || parts.length !== 3 || parts[0] !== "attachments") {
        return reply.code(404).send({ error: attachment.storageError || attachment.error || "附件文件不可用" });
      }
      const file = await store.resolveAttachment(attachment.lastJobId, parts[1], parts[2]);
      reply.type(type);
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Disposition", contentDisposition(fileName, download));
      return reply.send(createReadStream(file));
    } catch (error) {
      return reply.code(404).send({ error: publicError(error) });
    }
  });

  app.post<{ Body: { sessionId?: string; chatId?: string; startTime?: string; endTime?: string } }>(
    "/api/feishu/jobs",
    async (request, reply) => {
      const sessionId = String(request.body?.sessionId ?? "");
      const chatId = String(request.body?.chatId ?? "");
      const session = sessions.get(sessionId);
      if (!session) return reply.code(401).send({ error: "凭证会话已过期，请重新验证" });
      const chat = session.chats.find((item) => item.chatId === chatId);
      if (!chat) return reply.code(400).send({ error: "请选择当前身份可访问的会话" });
      let startTimeMs: number;
      let endMinuteMs: number;
      try {
        startTimeMs = parseBeijingMinute(request.body?.startTime, "开始时间");
        endMinuteMs = parseBeijingMinute(request.body?.endTime, "结束时间");
      } catch (error) {
        return reply.code(400).send({ error: publicError(error) });
      }
      if (startTimeMs > endMinuteMs) {
        return reply.code(400).send({ error: "开始时间不能晚于结束时间" });
      }
      if (store.hasActiveChat(chat.chatId)) {
        return reply.code(409).send({ error: "该群聊已有采集任务正在运行" });
      }
      const job = await store.create(chat, {
        startTime: new Date(startTimeMs).toISOString(),
        endTimeExclusive: new Date(endMinuteMs + 60_000).toISOString(),
      }, {
        collectorType: session.collectorType,
        callerIdentity: session.callerIdentity,
        appNamespace: session.appNamespace,
      });
      runner.start(job, sessionId);
      return reply.code(202).send(job);
    },
  );

  app.post<{ Params: { id: string }; Body: { sessionId?: string } }>(
    "/api/feishu/jobs/:id/resume",
    async (request, reply) => {
      const job = store.get(request.params.id);
      if (!job) return reply.code(404).send({ error: "采集任务不存在" });
      if (job.status !== "failed") return reply.code(409).send({ error: "只有失败任务可以继续" });
      const sessionId = String(request.body?.sessionId ?? "");
      const session = sessions.get(sessionId);
      if (!session) return reply.code(401).send({ error: "凭证会话已过期，请重新验证" });
      if (!session.chats.some((chat) => chat.chatId === job.chatId)) {
        return reply.code(403).send({ error: "当前身份无法访问该任务的会话" });
      }
      if (
        session.collectorType !== job.collectorType ||
        session.callerIdentity !== job.callerIdentity ||
        (job.appNamespace && session.appNamespace !== job.appNamespace)
      ) {
        return reply.code(403).send({ error: "当前凭证身份与原采集任务不一致" });
      }
      if (!job.startTime || !job.endTimeExclusive) {
        return reply.code(409).send({ error: "旧任务未记录抓取时间范围，不能继续，请新建采集任务" });
      }
      if (store.hasActiveChat(job.chatId, job.id) || runner.isRunning(job.id)) {
        return reply.code(409).send({ error: "该群聊已有采集任务正在运行" });
      }
      runner.start(job, sessionId);
      return reply.code(202).send(job);
    },
  );

  app.get<{ Params: { id: string } }>("/api/feishu/jobs/:id", async (request, reply) => {
    const job = store.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "采集任务不存在" });
    return job;
  });

  app.get<{
    Params: { id: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/api/feishu/jobs/:id/messages", async (request, reply) => {
    if (!store.get(request.params.id)) return reply.code(404).send({ error: "采集任务不存在" });
    const cursor = Math.max(0, Number.parseInt(request.query.cursor ?? "0", 10) || 0);
    const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit ?? "50", 10) || 50));
    return store.readMessages(request.params.id, cursor, limit);
  });

  app.get<{
    Params: { id: string; messageId: string; fileName: string };
    Querystring: { download?: string };
  }>("/api/feishu/jobs/:id/attachments/:messageId/:fileName", async (request, reply) => {
    try {
      const file = await store.resolveAttachment(
        request.params.id,
        request.params.messageId,
        request.params.fileName,
      );
      const type = contentType(request.params.fileName);
      const download = request.query.download === "1" || !canPreviewAttachment(request.params.fileName);
      reply.type(type);
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Disposition", contentDisposition(request.params.fileName, download));
      return reply.send(createReadStream(file));
    } catch (error) {
      return reply.code(404).send({ error: publicError(error) });
    }
  });

  app.addHook("onClose", async () => {
    await attachmentWorker.stop();
    await store.close();
  });

  return app;
}
