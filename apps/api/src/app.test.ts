import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { FeishuChatCategory, FeishuHistoryAttachmentRecord, FeishuHistoryQuery } from "@dlr/database";

import { buildApp } from "./app.js";
import { backfillFeishuHistory } from "./feishu/backfill.js";
import { FeishuExternalPersistence, type FeishuHistoryDataSource } from "./feishu/external-persistence.js";
import { FileJobStore, type JobPersistence } from "./feishu/job-store.js";
import type {
  BridgeCallbacks,
  CliAttachmentDownloadRequest,
  CliCrawlRequest,
  CrawlRequest,
  FeishuBridge,
  FeishuChat,
  UserCliFeishuBridge,
} from "./feishu/types.js";

const chat: FeishuChat = {
  chatId: "oc_test",
  name: "测试项目群",
  chatMode: "group",
  chatStatus: "normal",
  external: false,
};
const directChat: FeishuChat = {
  chatId: "oc_direct",
  name: "张三",
  chatMode: "p2p",
  chatStatus: "normal",
  external: false,
  p2pTargetType: "user",
  p2pTargetId: "ou_zhang",
};
const collectionRange = {
  startTime: "2026-08-21T02:00:00.000Z",
  endTimeExclusive: "2026-08-21T02:01:00.000Z",
};
const collectionInput = {
  startTime: "2026-08-21T10:00",
  endTime: "2026-08-21T10:00",
};

class FakeBridge implements FeishuBridge {
  readonly secrets: string[] = [];
  readonly crawlRequests: CrawlRequest[] = [];
  holdCrawl = false;
  release: (() => void) | undefined;

  async discoverChats(_appId: string, appSecret: string): Promise<FeishuChat[]> {
    this.secrets.push(appSecret);
    if (appSecret === "wrong") throw new Error("飞书 API 错误：invalid app secret");
    return [chat];
  }

  async crawl(request: CrawlRequest, callbacks: BridgeCallbacks): Promise<void> {
    this.secrets.push(request.appSecret);
    this.crawlRequests.push(request);
    if (this.holdCrawl) {
      await new Promise<void>((resolve) => { this.release = resolve; });
    }
    await callbacks.onEvent({
      event: "page",
      pageNumber: request.pageNumber + 1,
      nextPageToken: "",
      hasMore: false,
      attachmentCount: 0,
      attachmentFailedCount: 0,
      messages: [{
        messageId: "om_1",
        chatId: request.chatId,
        senderId: "ou_1",
        senderName: "张三",
        senderType: "user",
        msgType: "text",
        createTime: "2026-08-21T10:00:00+08:00",
        updateTime: "",
        text: "第一条历史消息",
        rootId: "",
        parentId: "",
        deleted: false,
        updated: false,
        attachments: [],
      }],
    });
    await callbacks.onEvent({ event: "done" });
  }
}

class FakeCliBridge implements UserCliFeishuBridge {
  readonly secrets: string[] = [];
  readonly restoredAppIds: string[] = [];
  readonly crawlRequests: CliCrawlRequest[] = [];

  constructor(private readonly qrPath: string) {}

  async configureApp(_appId: string, appSecret: string) {
    this.secrets.push(appSecret);
    return {
      connectionId: "cli-connection",
      cliVersion: "1.0.88",
      expiresAt: "2026-08-22T12:00:00.000Z",
      authStatus: {
        identity: "none" as const,
        available: false,
        userName: "",
        tokenStatus: "missing",
        verified: false,
      },
    };
  }

  async restoreApp(appId: string) {
    this.restoredAppIds.push(appId);
    return {
      connectionId: "cli-restored-connection",
      cliVersion: "1.0.88",
      expiresAt: "2026-08-23T12:00:00.000Z",
      authStatus: {
        identity: "user" as const,
        available: true,
        userName: "测试用户",
        tokenStatus: "valid",
        verified: true,
      },
    };
  }

  async beginAuth() {
    return {
      authSessionId: "cli-auth",
      verificationUrl: "https://accounts.example.test/device",
      expiresAt: "2026-08-22T11:10:00.000Z",
    };
  }

  async resolveQrCode() {
    return this.qrPath;
  }

  async completeAuth() {
    return {
      identity: "user" as const,
      available: true,
      userName: "测试用户",
      tokenStatus: "valid",
      verified: true,
    };
  }

  async discoverChats() {
    return {
      profile: "dlr-history-test",
      appNamespace: "sha256:test-app",
      userName: "测试用户",
      chats: [directChat, chat],
    };
  }

  async crawl(request: CliCrawlRequest, callbacks: BridgeCallbacks): Promise<void> {
    this.crawlRequests.push(request);
    await callbacks.onEvent({
      event: "page",
      pageNumber: request.pageNumber + 1,
      nextPageToken: "",
      hasMore: false,
      attachmentCount: 0,
      attachmentFailedCount: 0,
      messages: [{
        messageId: "om_cli_1",
        chatId: request.chatId,
        senderId: "ou_cli_sender",
        senderName: "CLI 发送者",
        senderType: "user",
        msgType: "text",
        createTime: "2026-08-21T10:00:00+08:00",
        updateTime: "",
        text: "CLI 单聊消息",
        rootId: "",
        parentId: "",
        deleted: false,
        updated: false,
        attachments: [],
      }],
    });
    await callbacks.onEvent({ event: "done" });
  }

  async downloadMessageAttachments(_request: CliAttachmentDownloadRequest) {
    return [];
  }
}

class FakeHistory implements FeishuHistoryDataSource {
  readonly queries: FeishuHistoryQuery[] = [];
  readonly attachmentUrlRequests: Array<{ download?: boolean }> = [];
  readonly attachmentReadRequests: Array<{ range?: string }> = [];

  async listChats(category?: FeishuChatCategory) {
    const group = {
      chatId: chat.chatId,
      name: chat.name,
      description: "",
      chatMode: chat.chatMode,
      chatStatus: chat.chatStatus,
      external: chat.external,
      ownerId: "ou_owner",
      p2pTargetType: "",
      p2pTargetId: "",
      messageCount: 25,
      firstMessageAt: "2026-08-20T02:00:00.000Z",
      lastMessageAt: "2026-08-21T10:00:00.000Z",
      lastCollectedAt: "2026-08-21T10:05:00.000Z",
    };
    const direct = {
      chatId: directChat.chatId,
      name: directChat.name,
      description: "",
      chatMode: directChat.chatMode,
      chatStatus: directChat.chatStatus,
      external: directChat.external,
      ownerId: "",
      p2pTargetType: directChat.p2pTargetType ?? "",
      p2pTargetId: directChat.p2pTargetId ?? "",
      messageCount: 8,
      firstMessageAt: "2026-08-21T02:00:00.000Z",
      lastMessageAt: "2026-08-21T09:00:00.000Z",
      lastCollectedAt: "2026-08-21T09:05:00.000Z",
    };
    if (category === "group") return [group];
    if (category === "p2p") return [direct];
    return [group, direct];
  }

  async listMessages(query: FeishuHistoryQuery) {
    this.queries.push(query);
    if (query.chatId !== chat.chatId) return null;
    return {
      items: [{
        messageId: "om_history",
        chatId: chat.chatId,
        senderId: "ou_1",
        senderName: "张三",
        senderType: "user",
        msgType: "text",
        createTime: "2026-08-21T10:00:00.000Z",
        updateTime: "",
        text: "内部数据消息",
        rootId: "",
        parentId: "",
        deleted: false,
        updated: false,
        attachments: [{
          messageId: "om_history",
          fileKey: "file_1",
          lastJobId: "",
          type: "file" as const,
          name: "报告.csv",
          status: "downloaded",
          relativePath: "",
          size: 10,
          error: "",
          storageStatus: "uploaded",
          ossBucket: "private-bucket",
          ossObjectKey: "dlr/internal/feishu/report.csv",
          ossEtag: "etag",
          storageError: "",
          uploadedAt: "2026-08-21T10:05:00.000Z",
        }, {
          messageId: "om_history",
          fileKey: "file_2",
          lastJobId: "",
          type: "file" as const,
          name: "missing.txt",
          status: "unavailable",
          relativePath: "",
          size: 0,
          error: "File not in msg.",
          storageStatus: "source_failed",
          ossBucket: "",
          ossObjectKey: "",
          ossEtag: "",
          storageError: "",
          uploadedAt: "",
        }],
      }],
      page: query.page,
      pageSize: query.pageSize,
      total: 25,
      totalPages: 2,
      snapshotAt: query.snapshotAt,
    };
  }

  async getAttachment(messageId: string, fileKey: string) {
    if (messageId !== "om_history" || !["file_1", "image_1"].includes(fileKey)) return null;
    const image = fileKey === "image_1";
    return {
      messageId,
      fileKey,
      lastJobId: "",
      type: image ? "image" as const : "file" as const,
      name: image ? "img_without_extension" : "报告.csv",
      status: "downloaded",
      relativePath: "",
      size: 10,
      error: "",
      storageStatus: "uploaded",
      ossBucket: "private-bucket",
      ossObjectKey: image ? "dlr/internal/feishu/img_without_extension" : "dlr/internal/feishu/report.csv",
      ossEtag: "etag",
      storageError: "",
      uploadedAt: "2026-08-21T10:05:00.000Z",
    };
  }

  createAttachmentUrl(
    attachment: FeishuHistoryAttachmentRecord,
    options: { download?: boolean } = {},
  ) {
    this.attachmentUrlRequests.push(options);
    return attachment.storageStatus === "uploaded"
      ? `https://private-bucket.example.test/signed-report-${options.download ? "download" : "inline"}`
      : "";
  }

  async readAttachment(attachment: FeishuHistoryAttachmentRecord, range?: string) {
    this.attachmentReadRequests.push({ range });
    if (attachment.storageStatus !== "uploaded") return null;
    const partial = Boolean(range);
    const image = attachment.type === "image";
    const content = partial ? "name" : image ? "fake-image" : "name,value\nexample,1\n";
    return {
      stream: Readable.from([content]),
      statusCode: partial ? 206 : 200,
      contentType: image ? "image/png" : "text/csv",
      contentLength: String(Buffer.byteLength(content)),
      contentRange: partial ? "bytes 0-3/21" : "",
      acceptRanges: "bytes",
      etag: '"test-etag"',
      lastModified: "Fri, 21 Aug 2026 10:05:00 GMT",
    };
  }
}

async function waitForCompleted(app: Awaited<ReturnType<typeof buildApp>>, jobId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/feishu/jobs/${jobId}` });
    const job = response.json();
    if (["completed", "partial", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("任务未在测试时间内结束");
}

async function allTextFiles(root: string): Promise<string> {
  const contents: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name.endsWith(".json")) contents.push(await readFile(target, "utf8"));
    }
  }
  await walk(root);
  return contents.join("\n");
}

test("手动凭证、群选择、采集与时间线分页形成完整链路，Secret 不落盘", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-api-"));
  const bridge = new FakeBridge();
  const app = await buildApp({
    dataRoot,
    bridge,
    pythonProject: "unused",
    pythonScript: "unused",
    logger: false,
  });
  const secret = "secret-must-never-be-persisted";
  try {
    const invalid = await app.inject({
      method: "POST",
      url: "/api/feishu/sessions",
      payload: { appId: "cli_test", appSecret: "wrong" },
    });
    assert.equal(invalid.statusCode, 401);

    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/feishu/sessions",
      payload: { appId: "cli_test", appSecret: secret },
    });
    assert.equal(sessionResponse.statusCode, 200);
    assert.equal(sessionResponse.body.includes(secret), false);
    const session = sessionResponse.json();
    assert.equal(session.chats[0].chatId, chat.chatId);
    assert.equal(session.chats[0].chatMode, "group");

    const missingChat = await app.inject({
      method: "POST",
      url: "/api/feishu/jobs",
      payload: { sessionId: session.sessionId, chatId: "" },
    });
    assert.equal(missingChat.statusCode, 400);

    const jobResponse = await app.inject({
      method: "POST",
      url: "/api/feishu/jobs",
      payload: { sessionId: session.sessionId, chatId: chat.chatId, ...collectionInput },
    });
    assert.equal(jobResponse.statusCode, 202);
    const created = jobResponse.json();
    const completed = await waitForCompleted(app, created.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.messageCount, 1);
    assert.equal(completed.chatMode, "group");
    assert.equal(completed.startTime, collectionRange.startTime);
    assert.equal(completed.endTimeExclusive, collectionRange.endTimeExclusive);
    assert.equal(bridge.crawlRequests[0].startTime, collectionRange.startTime);
    assert.equal(bridge.crawlRequests[0].endTimeExclusive, collectionRange.endTimeExclusive);

    const messages = await app.inject({
      method: "GET",
      url: `/api/feishu/jobs/${created.id}/messages?cursor=0&limit=50`,
    });
    assert.equal(messages.statusCode, 200);
    assert.equal(messages.json().items[0].text, "第一条历史消息");
    assert.equal((await allTextFiles(dataRoot)).includes(secret), false);
  } finally {
    await app.close();
  }
});

test("robot collection receives the attachment reuse plan before crawling", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-preflight-wiring-"));
  const bridge = new FakeBridge();
  const reusePlan = [{ messageId: "om_existing", fileKey: "img_existing" }];
  const persistence: JobPersistence = {
    async saveJob() {},
    async prepareAttachmentReuse() { return reusePlan; },
    async preparePage(_job, event) { return event; },
    async savePage() {},
  };
  const app = await buildApp({
    dataRoot,
    bridge,
    persistence,
    pythonProject: "unused",
    pythonScript: "unused",
    logger: false,
  });
  try {
    const session = (await app.inject({
      method: "POST",
      url: "/api/feishu/sessions",
      payload: { appId: "cli_test", appSecret: "secret" },
    })).json();
    const created = (await app.inject({
      method: "POST",
      url: "/api/feishu/jobs",
      payload: { sessionId: session.sessionId, chatId: chat.chatId, ...collectionInput },
    })).json();
    const completed = await waitForCompleted(app, created.id);
    assert.equal(completed.status, "completed");
    assert.deepEqual(bridge.crawlRequests[0].skipAttachments, reusePlan);
  } finally {
    await app.close();
  }
});

test("CLI 应用接入、二维码登录、会话刷新和单聊采集复用现有任务存储", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-cli-api-"));
  const qrPath = path.join(dataRoot, "qrcode.png");
  await writeFile(qrPath, "fake-png", "utf8");
  const cliBridge = new FakeCliBridge(qrPath);
  const app = await buildApp({
    dataRoot,
    bridge: new FakeBridge(),
    cliBridge,
    pythonProject: "unused",
    pythonScript: "unused",
    logger: false,
  });
  const secret = "cli-secret-must-not-leak";
  try {
    const connected = await app.inject({
      method: "POST",
      url: "/api/feishu/cli/connections",
      payload: { appId: "cli_test", appSecret: secret },
    });
    assert.equal(connected.statusCode, 200);
    assert.equal(connected.body.includes(secret), false);
    assert.equal(connected.json().cliVersion, "1.0.88");

    const restored = await app.inject({
      method: "POST",
      url: "/api/feishu/cli/connections/restore",
      payload: { appId: "cli_test" },
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().connectionId, "cli-restored-connection");
    assert.equal(restored.json().authStatus.identity, "user");
    assert.deepEqual(cliBridge.restoredAppIds, ["cli_test"]);
    assert.equal(restored.body.includes(secret), false);

    const auth = await app.inject({
      method: "POST",
      url: "/api/feishu/cli/connections/cli-connection/auth",
    });
    assert.equal(auth.statusCode, 200);
    assert.equal(auth.json().authSessionId, "cli-auth");
    assert.equal(auth.body.includes("device" + "_code"), false);

    const qr = await app.inject({ method: "GET", url: auth.json().qrCodeUrl });
    assert.equal(qr.statusCode, 200);
    assert.equal(qr.headers["content-type"], "image/png");
    assert.equal(qr.headers["cache-control"], "private, no-store");

    const completedAuth = await app.inject({
      method: "POST",
      url: "/api/feishu/cli/auth/cli-auth/complete",
    });
    assert.equal(completedAuth.statusCode, 200);
    assert.equal(completedAuth.json().identity, "user");

    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/feishu/cli/connections/cli-connection/chats",
    });
    assert.equal(sessionResponse.statusCode, 200);
    const session = sessionResponse.json();
    assert.equal(session.collectorType, "cli");
    assert.equal(session.callerIdentity, "user");
    assert.equal(session.userName, "测试用户");
    assert.deepEqual(session.chats.map((item: FeishuChat) => item.chatMode), ["p2p", "group"]);

    const jobResponse = await app.inject({
      method: "POST",
      url: "/api/feishu/jobs",
      payload: { sessionId: session.sessionId, chatId: directChat.chatId, ...collectionInput },
    });
    assert.equal(jobResponse.statusCode, 202);
    const completed = await waitForCompleted(app, jobResponse.json().id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.collectorType, "cli");
    assert.equal(completed.callerIdentity, "user");
    assert.equal(completed.appNamespace, "sha256:test-app");
    assert.equal(completed.chatMode, "p2p");
    assert.equal(cliBridge.crawlRequests[0].profile, "dlr-history-test");
    assert.equal((await allTextFiles(dataRoot)).includes(secret), false);
  } finally {
    await app.close();
  }
});

test("采集任务严格校验北京时间分钟范围并正确处理跨天边界", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-range-"));
  const bridge = new FakeBridge();
  const app = await buildApp({
    dataRoot,
    bridge,
    pythonProject: "unused",
    pythonScript: "unused",
    logger: false,
  });
  try {
    const session = (await app.inject({
      method: "POST",
      url: "/api/feishu/sessions",
      payload: { appId: "cli_test", appSecret: "secret" },
    })).json();

    const missingRange = await app.inject({
      method: "POST",
      url: "/api/feishu/jobs",
      payload: { sessionId: session.sessionId, chatId: chat.chatId },
    });
    assert.equal(missingRange.statusCode, 400);
    assert.match(missingRange.json().error, /开始时间/);

    const invalidDate = await app.inject({
      method: "POST",
      url: "/api/feishu/jobs",
      payload: {
        sessionId: session.sessionId,
        chatId: chat.chatId,
        startTime: "2026-02-30T10:00",
        endTime: "2026-02-30T10:01",
      },
    });
    assert.equal(invalidDate.statusCode, 400);
    assert.match(invalidDate.json().error, /有效的北京时间/);

    const reversed = await app.inject({
      method: "POST",
      url: "/api/feishu/jobs",
      payload: {
        sessionId: session.sessionId,
        chatId: chat.chatId,
        startTime: "2026-08-22T00:01",
        endTime: "2026-08-22T00:00",
      },
    });
    assert.equal(reversed.statusCode, 400);
    assert.match(reversed.json().error, /不能晚于/);

    const crossDay = await app.inject({
      method: "POST",
      url: "/api/feishu/jobs",
      payload: {
        sessionId: session.sessionId,
        chatId: chat.chatId,
        startTime: "2026-08-21T23:59",
        endTime: "2026-08-22T00:00",
      },
    });
    assert.equal(crossDay.statusCode, 202);
    const completed = await waitForCompleted(app, crossDay.json().id);
    assert.equal(completed.startTime, "2026-08-21T15:59:00.000Z");
    assert.equal(completed.endTimeExclusive, "2026-08-21T16:01:00.000Z");
  } finally {
    await app.close();
  }
});

test("没有时间范围的旧失败任务不能恢复为全量抓取", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-legacy-range-"));
  const legacyJob = {
    id: "7bed9531-c32b-4ac8-a8a4-1bc05fd5a8c2",
    chatId: chat.chatId,
    chatName: chat.name,
    status: "failed",
    pages: 0,
    messageCount: 0,
    attachmentCount: 0,
    attachmentFailedCount: 0,
    nextPageToken: "",
    hasMore: true,
    error: "旧任务中断",
    createdAt: "2026-08-21T01:00:00.000Z",
    updatedAt: "2026-08-21T01:01:00.000Z",
    completedAt: "",
  };
  const taskRoot = path.join(dataRoot, "jobs", legacyJob.id);
  await mkdir(path.join(taskRoot, "pages"), { recursive: true });
  await mkdir(path.join(taskRoot, "attachments"), { recursive: true });
  await writeFile(path.join(taskRoot, "job.json"), JSON.stringify(legacyJob), "utf8");
  const app = await buildApp({
    dataRoot,
    bridge: new FakeBridge(),
    pythonProject: "unused",
    pythonScript: "unused",
    logger: false,
  });
  try {
    const loaded = await app.inject({ method: "GET", url: `/api/feishu/jobs/${legacyJob.id}` });
    assert.equal(loaded.statusCode, 200);
    assert.equal(loaded.json().chatMode, "group");
    const session = (await app.inject({
      method: "POST",
      url: "/api/feishu/sessions",
      payload: { appId: "cli_test", appSecret: "secret" },
    })).json();
    const response = await app.inject({
      method: "POST",
      url: `/api/feishu/jobs/${legacyJob.id}/resume`,
      payload: { sessionId: session.sessionId },
    });
    assert.equal(response.statusCode, 409);
    assert.match(response.json().error, /未记录抓取时间范围/);
  } finally {
    await app.close();
  }
});

test("同一群聊不允许同时运行两个采集任务", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-lock-"));
  const bridge = new FakeBridge();
  bridge.holdCrawl = true;
  const app = await buildApp({
    dataRoot,
    bridge,
    pythonProject: "unused",
    pythonScript: "unused",
    logger: false,
  });
  try {
    const session = (await app.inject({
      method: "POST",
      url: "/api/feishu/sessions",
      payload: { appId: "cli_test", appSecret: "secret" },
    })).json();
    const first = await app.inject({
      method: "POST",
      url: "/api/feishu/jobs",
      payload: { sessionId: session.sessionId, chatId: chat.chatId, ...collectionInput },
    });
    assert.equal(first.statusCode, 202);
    const second = await app.inject({
      method: "POST",
      url: "/api/feishu/jobs",
      payload: { sessionId: session.sessionId, chatId: chat.chatId, ...collectionInput },
    });
    assert.equal(second.statusCode, 409);
    for (let attempt = 0; attempt < 50 && !bridge.release; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(bridge.release, "采集任务应已进入运行状态");
    bridge.release?.();
    await waitForCompleted(app, first.json().id);
  } finally {
    bridge.release?.();
    await app.close();
  }
});

test("附件路径拒绝目录穿越", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-path-"));
  const store = new FileJobStore(dataRoot);
  await store.initialize();
  const job = await store.create(chat, collectionRange);
  await assert.rejects(() => store.resolveAttachment(job.id, "..", "secret.txt"));
  await assert.rejects(() => store.resolveAttachment(job.id, "om_1", "../secret.txt"));
});

test("附件上传 OSS 后与消息页一起写入外部持久化", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-external-"));
  const persistedJobs: unknown[] = [];
  const persistedPages: Array<{ job: unknown; messages: unknown[] }> = [];
  const repository = {
    async health() {},
    async saveJob(job: unknown) { persistedJobs.push(job); },
    async savePage(job: unknown, messages: unknown[]) { persistedPages.push({ job, messages }); },
    async close() {},
  };
  const uploads: Array<{ key: string; file: string }> = [];
  const storage = {
    bucket: "test-private-bucket",
    async uploadFile(key: string, file: string) {
      uploads.push({ key, file });
      return { bucket: this.bucket, objectKey: key, etag: "etag-1" };
    },
    async verifyConnection() {},
  };
  const store = new FileJobStore(dataRoot, new FeishuExternalPersistence(repository, storage));
  await store.initialize();
  const job = await store.create(chat, collectionRange);
  assert.equal((persistedJobs[0] as { chatMode: string }).chatMode, "group");
  const relativePath = "attachments/om_file/file_1__报告.txt";
  const localFile = path.join(store.taskRoot(job.id), ...relativePath.split("/"));
  await mkdir(path.dirname(localFile), { recursive: true });
  await writeFile(localFile, "report", "utf8");
  const saved = await store.savePage(job.id, {
    event: "page",
    pageNumber: 1,
    nextPageToken: "",
    hasMore: false,
    attachmentCount: 1,
    attachmentFailedCount: 0,
    messages: [{
      messageId: "om_file",
      chatId: chat.chatId,
      senderId: "ou_1",
      senderName: "张三",
      senderType: "user",
      msgType: "file",
      createTime: "2026-08-21T10:00:00+08:00",
      updateTime: "",
      text: "",
      rootId: "",
      parentId: "",
      deleted: false,
      updated: false,
      attachments: [{
        type: "file",
        fileKey: "file_1",
        name: "报告.txt",
        status: "downloaded",
        relativePath,
        size: 6,
        error: "",
      }],
    }],
  });
  assert.equal(saved.attachmentFailedCount, 0);
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].key, /^dlr\/internal\/feishu\/oc_test\/om_file\/file_1__报告\.txt$/);
  assert.equal(persistedJobs.length, 1);
  assert.equal(persistedPages.length, 1);
  const page = JSON.parse(await readFile(path.join(store.taskRoot(job.id), "pages/000001.json"), "utf8"));
  assert.equal(page[0].attachments[0].storageStatus, "uploaded");
  assert.equal(page[0].attachments[0].ossBucket, "test-private-bucket");
  assert.equal(page[0].attachments[0].ossEtag, "etag-1");
});

test("incremental collection reuses an uploaded attachment without another OSS call", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-uploaded-reuse-"));
  const persistedPages: unknown[] = [];
  const repository = {
    async health() {},
    async saveJob() {},
    async savePage(_job: unknown, messages: unknown[]) { persistedPages.push(messages); },
    async listAttachmentsForRange() {
      return [{
        messageId: "om_existing",
        fileKey: "img_existing",
        lastJobId: "old-job",
        type: "image" as const,
        name: "existing.png",
        status: "downloaded",
        relativePath: "attachments/om_existing/img_existing.png",
        size: 8,
        error: "",
        storageStatus: "uploaded",
        ossBucket: "test-private-bucket",
        ossObjectKey: "dlr/internal/feishu/oc_test/om_existing/img_existing__existing.png",
        ossEtag: "existing-etag",
        storageError: "",
        uploadedAt: "2026-08-21T03:00:00.000Z",
      }];
    },
    async close() {},
  };
  let uploads = 0;
  const storage = {
    bucket: "test-private-bucket",
    async uploadFile(): Promise<never> {
      uploads += 1;
      throw new Error("uploaded attachment must not be sent again");
    },
    async verifyConnection() {},
  };
  const store = new FileJobStore(dataRoot, new FeishuExternalPersistence(repository, storage));
  await store.initialize();
  const job = await store.create(chat, collectionRange);
  const skips = await store.prepareAttachmentReuse(job.id);
  assert.deepEqual(skips, [{ messageId: "om_existing", fileKey: "img_existing" }]);

  await store.savePage(job.id, {
    event: "page",
    pageNumber: 1,
    nextPageToken: "",
    hasMore: false,
    attachmentCount: 1,
    attachmentFailedCount: 0,
    messages: [{
      messageId: "om_existing",
      chatId: chat.chatId,
      senderId: "ou_1",
      senderName: "test user",
      senderType: "user",
      msgType: "image",
      createTime: "2026-08-21T10:00:00+08:00",
      updateTime: "",
      text: "",
      rootId: "",
      parentId: "",
      deleted: false,
      updated: false,
      attachments: [{
        type: "image",
        fileKey: "img_existing",
        name: "img_existing",
        status: "pending",
        relativePath: "",
        size: 0,
        error: "pending",
        storageStatus: "pending",
      }],
    }],
  });

  assert.equal(uploads, 0);
  assert.equal(persistedPages.length, 1);
  const page = await store.readPageMessages(job.id, 1);
  assert.equal(page[0].attachments[0].storageStatus, "uploaded");
  assert.equal(page[0].attachments[0].ossEtag, "existing-etag");
});

test("incremental collection retries OSS from a valid previous local file", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-local-reuse-"));
  const previousJobId = "previous-job";
  const previousRelativePath = "attachments/om_retry/img_retry.png";
  const previousFile = path.join(dataRoot, "jobs", previousJobId, ...previousRelativePath.split("/"));
  await mkdir(path.dirname(previousFile), { recursive: true });
  await writeFile(previousFile, "image", "utf8");
  const repository = {
    async health() {},
    async saveJob() {},
    async savePage() {},
    async listAttachmentsForRange() {
      return [{
        messageId: "om_retry",
        fileKey: "img_retry",
        lastJobId: previousJobId,
        type: "image" as const,
        name: "img_retry.png",
        status: "downloaded",
        relativePath: previousRelativePath,
        size: 5,
        error: "",
        storageStatus: "upload_failed",
        ossBucket: "",
        ossObjectKey: "",
        ossEtag: "",
        storageError: "temporary OSS failure",
        uploadedAt: "",
      }];
    },
    async close() {},
  };
  const uploadedFiles: string[] = [];
  const storage = {
    bucket: "test-private-bucket",
    async uploadFile(key: string, file: string) {
      uploadedFiles.push(file);
      return { bucket: this.bucket, objectKey: key, etag: "retry-etag" };
    },
    async verifyConnection() {},
  };
  const store = new FileJobStore(dataRoot, new FeishuExternalPersistence(repository, storage));
  await store.initialize();
  const job = await store.create(chat, collectionRange);
  const skips = await store.prepareAttachmentReuse(job.id);
  assert.deepEqual(skips, [{ messageId: "om_retry", fileKey: "img_retry" }]);

  await store.savePage(job.id, {
    event: "page",
    pageNumber: 1,
    nextPageToken: "",
    hasMore: false,
    attachmentCount: 1,
    attachmentFailedCount: 0,
    messages: [{
      messageId: "om_retry",
      chatId: chat.chatId,
      senderId: "ou_1",
      senderName: "test user",
      senderType: "user",
      msgType: "image",
      createTime: "2026-08-21T10:00:00+08:00",
      updateTime: "",
      text: "",
      rootId: "",
      parentId: "",
      deleted: false,
      updated: false,
      attachments: [{
        type: "image",
        fileKey: "img_retry",
        name: "img_retry",
        status: "pending",
        relativePath: "",
        size: 0,
        error: "pending",
        storageStatus: "pending",
      }],
    }],
  });

  assert.equal(uploadedFiles.length, 1);
  assert.notEqual(path.resolve(uploadedFiles[0]), path.resolve(previousFile));
  assert.ok(path.resolve(uploadedFiles[0]).startsWith(path.resolve(store.taskRoot(job.id))));
  const page = await store.readPageMessages(job.id, 1);
  assert.equal(page[0].attachments[0].status, "reused");
  assert.equal(page[0].attachments[0].storageStatus, "uploaded");
  assert.equal(page[0].attachments[0].ossEtag, "retry-etag");
});

test("an invalid previous local file is not included in the download skip plan", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-invalid-local-"));
  const previousJobId = "previous-invalid-job";
  const previousRelativePath = "attachments/om_invalid/img_invalid.png";
  const previousFile = path.join(dataRoot, "jobs", previousJobId, ...previousRelativePath.split("/"));
  await mkdir(path.dirname(previousFile), { recursive: true });
  await writeFile(previousFile, "short", "utf8");
  const repository = {
    async health() {},
    async saveJob() {},
    async savePage() {},
    async listAttachmentsForRange() {
      return [{
        messageId: "om_invalid",
        fileKey: "img_invalid",
        lastJobId: previousJobId,
        type: "image" as const,
        name: "img_invalid.png",
        status: "downloaded",
        relativePath: previousRelativePath,
        size: 999,
        error: "",
        storageStatus: "upload_failed",
        ossBucket: "",
        ossObjectKey: "",
        ossEtag: "",
        storageError: "temporary OSS failure",
        uploadedAt: "",
      }];
    },
    async close() {},
  };
  const storage = {
    bucket: "test-private-bucket",
    async uploadFile(): Promise<never> { throw new Error("not used"); },
    async verifyConnection() {},
  };
  const store = new FileJobStore(dataRoot, new FeishuExternalPersistence(repository, storage));
  await store.initialize();
  const job = await store.create(chat, collectionRange);
  assert.deepEqual(await store.prepareAttachmentReuse(job.id), []);
});

test("OSS 上传失败计入附件异常但不丢弃消息页", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-oss-failure-"));
  const persistedPages: unknown[] = [];
  const repository = {
    async health() {},
    async saveJob() {},
    async savePage(_job: unknown, messages: unknown[]) { persistedPages.push(messages); },
    async close() {},
  };
  const storage = {
    bucket: "test-private-bucket",
    async uploadFile(): Promise<never> { throw new Error("AccessKey secret=must-not-leak"); },
    async verifyConnection() {},
  };
  const store = new FileJobStore(dataRoot, new FeishuExternalPersistence(repository, storage));
  await store.initialize();
  const job = await store.create(chat, collectionRange);
  const relativePath = "attachments/om_image/img_1.jpg";
  const localFile = path.join(store.taskRoot(job.id), ...relativePath.split("/"));
  await mkdir(path.dirname(localFile), { recursive: true });
  await writeFile(localFile, "image", "utf8");
  const saved = await store.savePage(job.id, {
    event: "page",
    pageNumber: 1,
    nextPageToken: "",
    hasMore: false,
    attachmentCount: 1,
    attachmentFailedCount: 0,
    messages: [{
      messageId: "om_image",
      chatId: chat.chatId,
      senderId: "ou_1",
      senderName: "张三",
      senderType: "user",
      msgType: "image",
      createTime: "2026-08-21T10:00:00+08:00",
      updateTime: "",
      text: "",
      rootId: "",
      parentId: "",
      deleted: false,
      updated: false,
      attachments: [{
        type: "image",
        fileKey: "img_1",
        name: "img_1",
        status: "downloaded",
        relativePath,
        size: 5,
        error: "",
      }],
    }],
  });
  assert.equal(saved.attachmentFailedCount, 1);
  assert.equal(persistedPages.length, 1);
  const pageText = await readFile(path.join(store.taskRoot(job.id), "pages/000001.json"), "utf8");
  assert.match(pageText, /"storageStatus": "upload_failed"/);
  assert.equal(pageText.includes("must-not-leak"), false);
  assert.match(pageText, /AccessKey=\[REDACTED\]/);
});

test("数据库页事务失败时不推进本地分页令牌", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-db-failure-"));
  const repository = {
    async health() {},
    async saveJob() {},
    async savePage(): Promise<never> { throw new Error("database unavailable"); },
    async close() {},
  };
  const storage = {
    bucket: "test-private-bucket",
    async uploadFile(key: string) { return { bucket: this.bucket, objectKey: key, etag: "etag" }; },
    async verifyConnection() {},
  };
  const store = new FileJobStore(dataRoot, new FeishuExternalPersistence(repository, storage));
  await store.initialize();
  const job = await store.create(chat, collectionRange);
  await assert.rejects(() => store.savePage(job.id, {
    event: "page",
    pageNumber: 1,
    nextPageToken: "next-token",
    hasMore: true,
    attachmentCount: 0,
    attachmentFailedCount: 0,
    messages: [{
      messageId: "om_db_failure",
      chatId: chat.chatId,
      senderId: "ou_1",
      senderName: "张三",
      senderType: "user",
      msgType: "text",
      createTime: "2026-08-21T10:00:00+08:00",
      updateTime: "",
      text: "不会提前落本地页",
      rootId: "",
      parentId: "",
      deleted: false,
      updated: false,
      attachments: [],
    }],
  }));
  assert.equal(store.get(job.id)?.pages, 0);
  assert.equal(store.get(job.id)?.nextPageToken, "");
  const pageFiles = await readdir(path.join(store.taskRoot(job.id), "pages"));
  assert.deepEqual(pageFiles, []);
});

test("内部飞书数据接口区分群组和单聊，并按小时范围、快照和固定 20 条分页查询", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-history-"));
  const history = new FakeHistory();
  const app = await buildApp({
    dataRoot,
    history,
    bridge: new FakeBridge(),
    pythonProject: "unused",
    pythonScript: "unused",
    logger: false,
  });
  try {
    const chats = await app.inject({ method: "GET", url: "/api/internal/feishu/chats" });
    assert.equal(chats.statusCode, 200);
    assert.equal(chats.json().items[0].messageCount, 25);
    assert.equal(chats.json().items.length, 2);

    const groups = await app.inject({ method: "GET", url: "/api/internal/feishu/chats?category=group" });
    assert.equal(groups.statusCode, 200);
    assert.deepEqual(groups.json().items.map((item: { chatId: string }) => item.chatId), [chat.chatId]);
    assert.equal(groups.json().items[0].chatMode, "group");

    const directChats = await app.inject({ method: "GET", url: "/api/internal/feishu/chats?category=p2p" });
    assert.equal(directChats.statusCode, 200);
    assert.deepEqual(directChats.json().items.map((item: { chatId: string }) => item.chatId), [directChat.chatId]);
    assert.equal(directChats.json().items[0].p2pTargetId, "ou_zhang");

    const invalidCategory = await app.inject({ method: "GET", url: "/api/internal/feishu/chats?category=private" });
    assert.equal(invalidCategory.statusCode, 400);

    const response = await app.inject({
      method: "GET",
      url: "/api/internal/feishu/chats/oc_test/messages?page=2&pageSize=20&order=desc&from=2026-08-21T02%3A00%3A00.000Z&to=2026-08-21T05%3A00%3A00.000Z&snapshot=2026-08-21T12%3A00%3A00.000Z",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().page, 2);
    assert.deepEqual(history.queries[0], {
      chatId: "oc_test",
      page: 2,
      pageSize: 20,
      order: "desc",
      from: "2026-08-21T02:00:00.000Z",
      to: "2026-08-21T05:00:00.000Z",
      snapshotAt: "2026-08-21T12:00:00.000Z",
    });

    const defaultResponse = await app.inject({
      method: "GET",
      url: "/api/internal/feishu/chats/oc_test/messages",
    });
    assert.equal(defaultResponse.statusCode, 200);
    assert.equal(history.queries[1].page, 1);
    assert.equal(history.queries[1].pageSize, 20);
    assert.equal(history.queries[1].order, "asc");
    assert.equal(history.queries[1].from, undefined);
    assert.equal(history.queries[1].to, undefined);
    assert.equal(defaultResponse.headers["cache-control"], "private, no-store");
    assert.equal(
      defaultResponse.json().items[0].attachments[0].url,
      "/api/internal/feishu/messages/om_history/attachments/file_1",
    );
    assert.equal(defaultResponse.json().items[0].attachments[1].url, "");
    assert.equal(defaultResponse.body.includes("localhost"), false);
    assert.equal(history.attachmentUrlRequests.length, 0);
  } finally {
    await app.close();
  }
});

test("内部飞书数据接口拒绝非法范围和分页大小，未配置时明确返回 503", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-history-validation-"));
  const history = new FakeHistory();
  const app = await buildApp({
    dataRoot,
    history,
    bridge: new FakeBridge(),
    pythonProject: "unused",
    pythonScript: "unused",
    logger: false,
  });
  try {
    const invalidRange = await app.inject({
      method: "GET",
      url: "/api/internal/feishu/chats/oc_test/messages?from=2026-08-21T05%3A00%3A00.000Z&to=2026-08-21T02%3A00%3A00.000Z",
    });
    assert.equal(invalidRange.statusCode, 400);
    assert.match(invalidRange.json().error, /开始时间/);

    const invalidPageSize = await app.inject({
      method: "GET",
      url: "/api/internal/feishu/chats/oc_test/messages?pageSize=100",
    });
    assert.equal(invalidPageSize.statusCode, 400);

    const attachment = await app.inject({
      method: "GET",
      url: "/api/internal/feishu/messages/om_history/attachments/file_1",
    });
    assert.equal(attachment.statusCode, 200);
    assert.equal(attachment.headers["content-type"], "text/csv; charset=utf-8");
    assert.match(attachment.headers["content-disposition"] ?? "", /^inline;/);
    assert.equal(attachment.body, "name,value\nexample,1\n");
    assert.deepEqual(history.attachmentReadRequests[0], { range: undefined });

    const download = await app.inject({
      method: "GET",
      url: "/api/internal/feishu/messages/om_history/attachments/file_1?download=1",
    });
    assert.equal(download.statusCode, 200);
    assert.match(download.headers["content-disposition"] ?? "", /^attachment;/);
    assert.equal(history.attachmentUrlRequests.length, 0);

    const partial = await app.inject({
      method: "GET",
      url: "/api/internal/feishu/messages/om_history/attachments/file_1",
      headers: { range: "bytes=0-3" },
    });
    assert.equal(partial.statusCode, 206);
    assert.equal(partial.headers["content-range"], "bytes 0-3/21");
    assert.equal(partial.body, "name");
    assert.deepEqual(history.attachmentReadRequests[2], { range: "bytes=0-3" });

    const invalidByteRange = await app.inject({
      method: "GET",
      url: "/api/internal/feishu/messages/om_history/attachments/file_1",
      headers: { range: "bytes=0-1,4-5" },
    });
    assert.equal(invalidByteRange.statusCode, 416);

    const extensionlessImage = await app.inject({
      method: "GET",
      url: "/api/internal/feishu/messages/om_history/attachments/image_1",
    });
    assert.equal(extensionlessImage.statusCode, 200);
    assert.equal(extensionlessImage.headers["content-type"], "image/png");
    assert.match(extensionlessImage.headers["content-disposition"] ?? "", /^inline;/);
  } finally {
    await app.close();
  }

  const noHistoryRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-history-disabled-"));
  const noHistory = await buildApp({
    dataRoot: noHistoryRoot,
    bridge: new FakeBridge(),
    pythonProject: "unused",
    pythonScript: "unused",
    logger: false,
  });
  try {
    const response = await noHistory.inject({ method: "GET", url: "/api/internal/feishu/chats" });
    assert.equal(response.statusCode, 503);
    assert.match(response.json().error, /postgres-oss/);
  } finally {
    await noHistory.close();
  }
});

test("飞书历史回填默认只预览、支持排除测试群并按页显式写入", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-feishu-backfill-"));
  const job = {
    id: "7bed9531-c32b-4ac8-a8a4-1bc05fd5a8c1",
    chatId: chat.chatId,
    chatName: chat.name,
    status: "completed" as const,
    pages: 1,
    messageCount: 1,
    attachmentCount: 0,
    attachmentFailedCount: 0,
    nextPageToken: "",
    hasMore: false,
    error: "",
    createdAt: "2026-08-21T01:00:00.000Z",
    updatedAt: "2026-08-21T02:00:00.000Z",
    completedAt: "2026-08-21T02:00:00.000Z",
  };
  const taskRoot = path.join(dataRoot, "jobs", job.id);
  await mkdir(path.join(taskRoot, "pages"), { recursive: true });
  await writeFile(path.join(taskRoot, "job.json"), JSON.stringify(job), "utf8");
  await writeFile(path.join(taskRoot, "pages", "000001.json"), JSON.stringify([{
    messageId: "om_backfill",
    chatId: chat.chatId,
    senderId: "ou_1",
    senderName: "张三",
    senderType: "user",
    msgType: "text",
    createTime: "2026-08-21T10:00:00+08:00",
    updateTime: "",
    text: "待回填消息",
    rootId: "",
    parentId: "",
    deleted: false,
    updated: false,
    attachments: [],
  }]), "utf8");

  const preview = await backfillFeishuHistory({ dataRoot, excludedChatIds: [chat.chatId] });
  assert.equal(preview.applied, false);
  assert.equal(preview.includedJobs, 0);
  assert.equal(preview.jobs[0].excluded, true);

  const calls: string[] = [];
  const applied = await backfillFeishuHistory({
    dataRoot,
    apply: true,
    persistence: {
      async saveJob(savedJob) { calls.push(`job:${savedJob.id}:${savedJob.chatMode}`); },
      async preparePage(_savedJob, event) { calls.push(`prepare:${event.pageNumber}`); return event; },
      async savePage(_savedJob, event) { calls.push(`page:${event.messages[0].messageId}`); },
    },
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.appliedPages, 1);
  assert.equal(applied.appliedMessages, 1);
  assert.deepEqual(calls, [
    `job:${job.id}:group`,
    "prepare:1",
    "page:om_backfill",
  ]);
});
