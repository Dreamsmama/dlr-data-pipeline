import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabasePool, PostgresFeishuRepository, requireDatabaseUrl } from "./index.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, "../../..");
try {
  process.loadEnvFile(path.join(repositoryRoot, ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const suffix = randomUUID().replaceAll("-", "");
const chatId = `oc_check_${suffix}`;
const jobId = randomUUID();
const messageId = `om_check_${suffix}`;
const fileKey = `file_check_${suffix}`;
const now = new Date().toISOString();
const pool = createDatabasePool(requireDatabaseUrl());
const repository = new PostgresFeishuRepository(pool);
try {
  const job = {
    id: jobId,
    collectorType: "robot" as const,
    callerIdentity: "bot" as const,
    appNamespace: "sha256:database-check",
    chatId,
    chatName: "数据库幂等检查群",
    description: "temporary integration check",
    chatMode: "group" as const,
    chatStatus: "normal" as const,
    external: false,
    ownerId: "ou_owner",
    p2pTargetType: "",
    p2pTargetId: "",
    status: "completed" as const,
    pages: 1,
    messageCount: 1,
    attachmentCount: 1,
    attachmentFailedCount: 0,
    nextPageToken: "",
    hasMore: false,
    error: "",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  };
  const messages = [{
    messageId,
    chatId,
    senderId: "ou_check",
    senderName: "检查用户",
    senderType: "user",
    msgType: "file",
    createTime: now,
    updateTime: now,
    text: "",
    rootId: "",
    parentId: "",
    deleted: false,
    updated: false,
    attachments: [{
      type: "file" as const,
      fileKey,
      name: "check.txt",
      status: "downloaded",
      relativePath: "attachments/check.txt",
      size: 5,
      error: "",
      storageStatus: "uploaded",
      ossBucket: "integration-check",
      ossObjectKey: `dlr/internal/_database-checks/${fileKey}`,
      ossEtag: "integration-etag",
      storageError: "",
      uploadedAt: now,
    }],
  }];
  await repository.saveJob(job);
  await repository.savePage(job, messages);
  const beforeRepeat = await pool.query<{ messageXmin: string; attachmentXmin: string }>(
    `SELECT
       (SELECT xmin::text FROM feishu_messages WHERE message_id = $1) AS "messageXmin",
       (SELECT xmin::text FROM feishu_attachments WHERE message_id = $1 AND file_key = $2) AS "attachmentXmin"`,
    [messageId, fileKey],
  );
  await repository.savePage(job, messages);
  const counts = await pool.query<{ messages: number; attachments: number }>(
    `SELECT
       (SELECT count(*)::int FROM feishu_messages WHERE message_id = $1) AS messages,
       (SELECT count(*)::int FROM feishu_attachments WHERE message_id = $1 AND file_key = $2) AS attachments`,
    [messageId, fileKey],
  );
  const result = counts.rows[0];
  if (!result || result.messages !== 1 || result.attachments !== 1) {
    throw new Error("数据库幂等检查失败");
  }
  const afterRepeat = await pool.query<{ messageXmin: string; attachmentXmin: string }>(
    `SELECT
       (SELECT xmin::text FROM feishu_messages WHERE message_id = $1) AS "messageXmin",
       (SELECT xmin::text FROM feishu_attachments WHERE message_id = $1 AND file_key = $2) AS "attachmentXmin"`,
    [messageId, fileKey],
  );
  if (
    beforeRepeat.rows[0]?.messageXmin !== afterRepeat.rows[0]?.messageXmin ||
    beforeRepeat.rows[0]?.attachmentXmin !== afterRepeat.rows[0]?.attachmentXmin
  ) {
    throw new Error("相同飞书消息或附件被重复更新");
  }
  const reusable = await repository.listAttachmentsForRange({
    chatId,
    from: new Date(Date.parse(now) - 1_000).toISOString(),
    to: new Date(Date.parse(now) + 1_000).toISOString(),
  });
  if (reusable.length !== 1 || reusable[0].messageId !== messageId || reusable[0].fileKey !== fileKey) {
    throw new Error("附件范围预查询失败");
  }
  process.stdout.write(JSON.stringify({ status: "ok", ...result, unchangedRowsSkipped: true }) + "\n");
} finally {
  await pool.query("DELETE FROM feishu_attachments WHERE message_id = $1 AND file_key = $2", [messageId, fileKey]).catch(() => undefined);
  await pool.query("DELETE FROM feishu_messages WHERE message_id = $1", [messageId]).catch(() => undefined);
  await pool.query("DELETE FROM feishu_collection_jobs WHERE id = $1", [jobId]).catch(() => undefined);
  await pool.query("DELETE FROM feishu_chats WHERE chat_id = $1", [chatId]).catch(() => undefined);
  await pool.end();
}
