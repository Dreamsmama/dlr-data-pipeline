import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CliAttachmentWorker } from "./attachment-worker.js";
import { FileJobStore, type JobPersistence } from "./job-store.js";
import type {
  CliAttachmentDownloadRequest,
  FeishuChat,
  TimelineAttachment,
  TimelineMessage,
  UserCliFeishuBridge,
} from "./types.js";

const chat: FeishuChat = {
  chatId: "oc_worker",
  name: "附件队列测试群",
  chatMode: "group",
  chatStatus: "normal",
  external: false,
};

function pendingMessage(messageId: string, fileKey: string): TimelineMessage {
  return {
    messageId,
    chatId: chat.chatId,
    senderId: "ou_sender",
    senderName: "测试用户",
    senderType: "user",
    msgType: "image",
    createTime: "2026-08-22T02:00:00.000Z",
    updateTime: "",
    text: `![Image](${fileKey})`,
    rootId: "",
    parentId: "",
    deleted: false,
    updated: false,
    attachments: [{
      type: "image",
      fileKey,
      name: fileKey,
      status: "pending",
      relativePath: "",
      size: 0,
      error: "附件后台处理中",
      storageStatus: "pending",
    }],
  };
}

function downloaded(messageId: string, fileKey: string): TimelineAttachment {
  return {
    type: "image",
    fileKey,
    name: `${fileKey}.png`,
    status: "downloaded",
    relativePath: `attachments/${messageId}/${fileKey}.png`,
    size: 4,
    error: "",
  };
}

function fakeBridge(
  handler: (request: CliAttachmentDownloadRequest) => Promise<TimelineAttachment[]>,
): UserCliFeishuBridge {
  return { downloadMessageAttachments: handler } as UserCliFeishuBridge;
}

async function createJobWithMessages(
  root: string,
  messages: TimelineMessage[],
  persistence?: JobPersistence,
) {
  const store = new FileJobStore(root, persistence);
  await store.initialize();
  const job = await store.create(chat, {
    startTime: "2026-08-22T02:00:00.000Z",
    endTimeExclusive: "2026-08-22T03:00:00.000Z",
  }, {
    collectorType: "cli",
    callerIdentity: "user",
    appNamespace: "sha256:test",
  });
  await store.savePage(job.id, {
    event: "page",
    pageNumber: 1,
    messages,
    nextPageToken: "",
    hasMore: false,
    attachmentCount: messages.reduce((total, message) => total + message.attachments.length, 0),
    attachmentFailedCount: 0,
  });
  await store.update(job.id, { status: "completed", hasMore: false });
  return { store, job: store.get(job.id)! };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

test("attachment worker retries a command failure and updates only attachment state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dlr-attachment-worker-retry-"));
  const message = pendingMessage("om_retry", "img_retry");
  const { store, job } = await createJobWithMessages(root, [message]);
  let attempts = 0;
  const worker = new CliAttachmentWorker(store, fakeBridge(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary download failure");
    return [downloaded(message.messageId, "img_retry")];
  }), { maxAttempts: 3, retryDelaysMs: [0] });

  try {
    await worker.enqueue(job.id, "dlr-history-test", 1, [message]);
    worker.activate(job.id);
    await waitFor(() => store.get(job.id)?.attachmentPendingCount === 0, "附件重试没有完成");

    const completed = store.get(job.id)!;
    assert.equal(attempts, 2);
    assert.equal(completed.status, "completed");
    assert.equal(completed.pages, 1);
    assert.equal(completed.messageCount, 1);
    assert.equal(completed.attachmentPendingCount, 0);
    assert.equal(completed.attachmentProcessedCount, 1);
    assert.equal(completed.attachmentFailedCount, 0);
    const saved = await store.readMessages(job.id, 0, 20);
    assert.equal(saved.items[0].attachments[0].status, "downloaded");
    const queue = JSON.parse(await readFile(path.join(store.taskRoot(job.id), "attachment-queue.json"), "utf8"));
    assert.equal(queue.items[0].status, "completed");
    assert.equal(queue.items[0].attempts, 2);
  } finally {
    await worker.stop();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("one terminal attachment failure does not stop later queue items", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dlr-attachment-worker-continue-"));
  const failedMessage = pendingMessage("om_too_large", "file_too_large");
  const successfulMessage = pendingMessage("om_small", "img_small");
  const { store, job } = await createJobWithMessages(root, [failedMessage, successfulMessage]);
  const called: string[] = [];
  const worker = new CliAttachmentWorker(store, fakeBridge(async (request) => {
    called.push(request.messageId);
    if (request.messageId === failedMessage.messageId) throw new Error("attachment timed out");
    return [downloaded(successfulMessage.messageId, "img_small")];
  }), { maxAttempts: 1, retryDelaysMs: [0] });

  try {
    await worker.enqueue(job.id, "dlr-history-test", 1, [failedMessage, successfulMessage]);
    worker.activate(job.id);
    await waitFor(() => store.get(job.id)?.attachmentPendingCount === 0, "后续附件没有继续处理");

    const completed = store.get(job.id)!;
    assert.deepEqual(called, [failedMessage.messageId, successfulMessage.messageId]);
    assert.equal(completed.status, "partial");
    assert.equal(completed.attachmentProcessedCount, 2);
    assert.equal(completed.attachmentFailedCount, 1);
    const saved = await store.readMessages(job.id, 0, 20);
    assert.equal(saved.items[0].attachments[0].status, "failed");
    assert.equal(saved.items[1].attachments[0].status, "downloaded");
  } finally {
    await worker.stop();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a persistence retry reuses the downloaded file instead of downloading it again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dlr-attachment-worker-persist-"));
  const message = pendingMessage("om_persist", "img_persist");
  let persistenceAttempts = 0;
  const persistence: JobPersistence = {
    async saveJob() {},
    async preparePage(_job, event) { return event; },
    async savePage(_job, event) {
      if (!event.messages.some((item) => item.attachments.some((attachment) => attachment.status === "downloaded"))) {
        return;
      }
      persistenceAttempts += 1;
      if (persistenceAttempts === 1) throw new Error("temporary database failure");
    },
  };
  const { store, job } = await createJobWithMessages(root, [message], persistence);
  let downloads = 0;
  const worker = new CliAttachmentWorker(store, fakeBridge(async () => {
    downloads += 1;
    return [downloaded(message.messageId, "img_persist")];
  }), { maxAttempts: 3, retryDelaysMs: [0] });

  try {
    await worker.enqueue(job.id, "dlr-history-test", 1, [message]);
    worker.activate(job.id);
    await waitFor(() => store.get(job.id)?.attachmentPendingCount === 0, "持久化重试没有完成");

    assert.equal(downloads, 1);
    assert.equal(persistenceAttempts, 2);
    const queue = JSON.parse(await readFile(path.join(store.taskRoot(job.id), "attachment-queue.json"), "utf8"));
    assert.equal(queue.items[0].status, "completed");
    assert.equal(queue.items[0].attempts, 1);
    assert.equal(queue.items[0].attachments, undefined);
  } finally {
    await worker.stop();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an uploaded attachment from the persisted page is not enqueued again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dlr-attachment-worker-uploaded-"));
  const message = pendingMessage("om_uploaded", "img_uploaded");
  const persistence: JobPersistence = {
    async saveJob() {},
    async preparePage(_job, event) {
      return {
        ...event,
        messages: event.messages.map((item) => ({
          ...item,
          attachments: item.attachments.map((attachment) => ({
            ...attachment,
            status: "downloaded" as const,
            relativePath: "attachments/old/img_uploaded.png",
            size: 4,
            error: "",
            storageStatus: "uploaded" as const,
            ossBucket: "test-private-bucket",
            ossObjectKey: "dlr/internal/feishu/oc_worker/om_uploaded/img_uploaded.png",
            ossEtag: "existing-etag",
          })),
        })),
      };
    },
    async savePage() {},
  };
  const { store, job } = await createJobWithMessages(root, [message], persistence);
  const persistedMessages = await store.readPageMessages(job.id, 1);
  let downloads = 0;
  const worker = new CliAttachmentWorker(store, fakeBridge(async () => {
    downloads += 1;
    return [];
  }));
  try {
    await worker.enqueue(job.id, "dlr-history-test", 1, persistedMessages);
    worker.activate(job.id);
    assert.equal(downloads, 0);
    await assert.rejects(
      () => readFile(path.join(store.taskRoot(job.id), "attachment-queue.json"), "utf8"),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  } finally {
    await worker.stop();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("initialize restores a persisted running item after process restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dlr-attachment-worker-restart-"));
  const message = pendingMessage("om_restart", "img_restart");
  const { store, job } = await createJobWithMessages(root, [message]);
  const firstWorker = new CliAttachmentWorker(store, fakeBridge(async () => []));
  const queuePath = path.join(store.taskRoot(job.id), "attachment-queue.json");

  await firstWorker.enqueue(job.id, "dlr-history-test", 1, [message]);
  await firstWorker.stop();
  const interrupted = JSON.parse(await readFile(queuePath, "utf8"));
  interrupted.items[0].status = "running";
  await writeFile(queuePath, JSON.stringify(interrupted, null, 2), "utf8");

  const restartedWorker = new CliAttachmentWorker(store, fakeBridge(async () => [
    downloaded(message.messageId, "img_restart"),
  ]), { retryDelaysMs: [0] });
  try {
    await restartedWorker.initialize();
    await waitFor(async () => {
      if (store.get(job.id)?.attachmentPendingCount !== 0) return false;
      const queue = JSON.parse(await readFile(queuePath, "utf8"));
      return queue.items[0].status === "completed";
    }, "重启后附件队列没有恢复");
    const queue = JSON.parse(await readFile(queuePath, "utf8"));
    assert.equal(queue.items[0].status, "completed");
    assert.equal(queue.items[0].attempts, 1);
  } finally {
    await restartedWorker.stop();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
