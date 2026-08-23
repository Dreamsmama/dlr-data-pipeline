import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";

export type FeishuChatMode = "group" | "topic" | "p2p" | "unknown";
export type FeishuChatStatus = "normal" | "dissolved" | "dissolved_save" | "unknown";
export type FeishuChatCategory = "group" | "p2p";
export type FeishuCollectorType = "robot" | "cli";
export type FeishuCallerIdentity = "bot" | "user";

export interface FeishuChatRecord {
  chatId: string;
  chatName: string;
  description?: string;
  chatMode: FeishuChatMode;
  chatStatus: FeishuChatStatus;
  external?: boolean;
  ownerId?: string;
  p2pTargetType?: string;
  p2pTargetId?: string;
}

export interface FeishuJobRecord extends FeishuChatRecord {
  id: string;
  collectorType: FeishuCollectorType;
  callerIdentity: FeishuCallerIdentity;
  appNamespace: string;
  status: "queued" | "running" | "completed" | "partial" | "failed";
  pages: number;
  messageCount: number;
  attachmentCount: number;
  attachmentFailedCount: number;
  nextPageToken: string;
  hasMore: boolean;
  error: string;
  startTime?: string;
  endTimeExclusive?: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
}

export interface FeishuAttachmentRecord {
  type: "image" | "file";
  fileKey: string;
  name: string;
  status: string;
  relativePath: string;
  size: number;
  error: string;
  storageStatus?: string;
  ossBucket?: string;
  ossObjectKey?: string;
  ossEtag?: string;
  storageError?: string;
  uploadedAt?: string;
}

export interface FeishuMessageRecord {
  messageId: string;
  chatId: string;
  senderId: string;
  senderName: string;
  senderType: string;
  msgType: string;
  createTime: string;
  updateTime: string;
  text: string;
  rootId: string;
  parentId: string;
  deleted: boolean;
  updated: boolean;
  attachments: FeishuAttachmentRecord[];
}

export interface FeishuChatSummary {
  chatId: string;
  name: string;
  description: string;
  chatMode: FeishuChatMode;
  chatStatus: FeishuChatStatus;
  external?: boolean;
  ownerId: string;
  p2pTargetType: string;
  p2pTargetId: string;
  messageCount: number;
  firstMessageAt: string;
  lastMessageAt: string;
  lastCollectedAt: string;
}

export interface FeishuHistoryAttachmentRecord extends FeishuAttachmentRecord {
  messageId: string;
  lastJobId: string;
}

export interface FeishuAttachmentRangeQuery {
  chatId: string;
  from: string;
  to: string;
}

export interface FeishuHistoryMessageRecord extends Omit<FeishuMessageRecord, "attachments"> {
  attachments: FeishuHistoryAttachmentRecord[];
}

export interface FeishuHistoryQuery {
  chatId: string;
  page: number;
  pageSize: number;
  order: "asc" | "desc";
  snapshotAt: string;
  from?: string;
  to?: string;
}

export interface FeishuHistoryPage {
  items: FeishuHistoryMessageRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  snapshotAt: string;
}

function asIso(value: Date | string | null): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function requireDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL 未配置");
  return value;
}

export function createDatabasePool(connectionString = requireDatabaseUrl()): Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "dlr-data-pipeline",
  });
}

export async function runMigrations(pool: Pool, migrationsDirectory?: string): Promise<string[]> {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const directory = migrationsDirectory ?? path.resolve(currentDirectory, "../migrations");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('dlr_schema_migrations'))");
    const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    for (const name of files) {
      const exists = await client.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1) AS exists",
        [name],
      );
      if (exists.rows[0]?.exists) continue;
      const sql = await readFile(path.join(directory, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('dlr_schema_migrations'))").catch(() => undefined);
    client.release();
  }
  return applied;
}

async function upsertJob(client: Pool | PoolClient, job: FeishuJobRecord): Promise<void> {
  await client.query(
    `INSERT INTO feishu_chats (
       chat_id, name, description, chat_mode, chat_status, external,
       owner_id, p2p_target_type, p2p_target_id, last_seen_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
     ON CONFLICT (chat_id) DO UPDATE SET
       name = EXCLUDED.name,
       description = CASE WHEN EXCLUDED.description <> '' THEN EXCLUDED.description ELSE feishu_chats.description END,
       chat_mode = CASE WHEN EXCLUDED.chat_mode <> 'unknown' THEN EXCLUDED.chat_mode ELSE feishu_chats.chat_mode END,
       chat_status = CASE WHEN EXCLUDED.chat_status <> 'unknown' THEN EXCLUDED.chat_status ELSE feishu_chats.chat_status END,
       external = COALESCE(EXCLUDED.external, feishu_chats.external),
       owner_id = CASE WHEN EXCLUDED.owner_id <> '' THEN EXCLUDED.owner_id ELSE feishu_chats.owner_id END,
       p2p_target_type = CASE WHEN EXCLUDED.p2p_target_type <> '' THEN EXCLUDED.p2p_target_type ELSE feishu_chats.p2p_target_type END,
       p2p_target_id = CASE WHEN EXCLUDED.p2p_target_id <> '' THEN EXCLUDED.p2p_target_id ELSE feishu_chats.p2p_target_id END,
       last_seen_at = now()`,
    [
      job.chatId,
      job.chatName,
      job.description ?? "",
      job.chatMode || "group",
      job.chatStatus || "unknown",
      job.external ?? null,
      job.ownerId ?? "",
      job.p2pTargetType ?? "",
      job.p2pTargetId ?? "",
    ],
  );
  await client.query(
    `INSERT INTO feishu_collection_jobs (
       id, chat_id, chat_name, collector_type, caller_identity, app_namespace,
       status, pages, message_count, attachment_count,
       attachment_failed_count, next_page_token, has_more, error, start_time, end_time_exclusive,
       created_at, updated_at, completed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (id) DO UPDATE SET
       chat_id = EXCLUDED.chat_id,
       chat_name = EXCLUDED.chat_name,
       collector_type = EXCLUDED.collector_type,
       caller_identity = EXCLUDED.caller_identity,
       app_namespace = EXCLUDED.app_namespace,
       status = EXCLUDED.status,
       pages = EXCLUDED.pages,
       message_count = EXCLUDED.message_count,
       attachment_count = EXCLUDED.attachment_count,
       attachment_failed_count = EXCLUDED.attachment_failed_count,
       next_page_token = EXCLUDED.next_page_token,
       has_more = EXCLUDED.has_more,
       error = EXCLUDED.error,
       start_time = EXCLUDED.start_time,
       end_time_exclusive = EXCLUDED.end_time_exclusive,
       updated_at = EXCLUDED.updated_at,
       completed_at = EXCLUDED.completed_at`,
    [
      job.id, job.chatId, job.chatName, job.collectorType, job.callerIdentity,
      job.appNamespace, job.status, job.pages, job.messageCount, job.attachmentCount,
      job.attachmentFailedCount, job.nextPageToken || null, job.hasMore, job.error,
      job.startTime || null, job.endTimeExclusive || null, job.createdAt, job.updatedAt,
      job.completedAt || null,
    ],
  );
}

export class PostgresFeishuRepository {
  constructor(readonly pool: Pool) {}

  async health(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async saveJob(job: FeishuJobRecord): Promise<void> {
    await upsertJob(this.pool, job);
  }

  async savePage(job: FeishuJobRecord, messages: FeishuMessageRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await upsertJob(client, job);
      for (const message of messages) {
        await client.query(
          `INSERT INTO feishu_messages (
             message_id, chat_id, last_job_id, sender_id, sender_name, sender_type, msg_type,
             create_time, update_time, text, root_id, parent_id, deleted, updated, last_collected_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
           ON CONFLICT (message_id) DO UPDATE SET
             chat_id = EXCLUDED.chat_id,
             last_job_id = EXCLUDED.last_job_id,
             sender_id = EXCLUDED.sender_id,
             sender_name = EXCLUDED.sender_name,
             sender_type = EXCLUDED.sender_type,
             msg_type = EXCLUDED.msg_type,
             create_time = EXCLUDED.create_time,
             update_time = EXCLUDED.update_time,
             text = EXCLUDED.text,
             root_id = EXCLUDED.root_id,
             parent_id = EXCLUDED.parent_id,
             deleted = EXCLUDED.deleted,
             updated = EXCLUDED.updated,
             last_collected_at = now()
           WHERE (
             feishu_messages.chat_id,
             feishu_messages.sender_id,
             feishu_messages.sender_name,
             feishu_messages.sender_type,
             feishu_messages.msg_type,
             feishu_messages.create_time,
             feishu_messages.update_time,
             feishu_messages.text,
             feishu_messages.root_id,
             feishu_messages.parent_id,
             feishu_messages.deleted,
             feishu_messages.updated
           ) IS DISTINCT FROM (
             EXCLUDED.chat_id,
             EXCLUDED.sender_id,
             EXCLUDED.sender_name,
             EXCLUDED.sender_type,
             EXCLUDED.msg_type,
             EXCLUDED.create_time,
             EXCLUDED.update_time,
             EXCLUDED.text,
             EXCLUDED.root_id,
             EXCLUDED.parent_id,
             EXCLUDED.deleted,
             EXCLUDED.updated
           )`,
          [
            message.messageId, message.chatId, job.id, message.senderId, message.senderName,
            message.senderType, message.msgType, message.createTime || null, message.updateTime || null,
            message.text, message.rootId, message.parentId, message.deleted, message.updated,
          ],
        );
        for (const attachment of message.attachments) {
          await client.query(
            `INSERT INTO feishu_attachments (
               message_id, file_key, last_job_id, type, name, source_status, source_relative_path,
               size_bytes, source_error, storage_status, oss_bucket, oss_object_key, oss_etag,
               storage_error, uploaded_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
             ON CONFLICT (message_id, file_key) DO UPDATE SET
               last_job_id = EXCLUDED.last_job_id,
               type = EXCLUDED.type,
               name = EXCLUDED.name,
               source_status = EXCLUDED.source_status,
               source_relative_path = EXCLUDED.source_relative_path,
               size_bytes = EXCLUDED.size_bytes,
               source_error = EXCLUDED.source_error,
               storage_status = EXCLUDED.storage_status,
               oss_bucket = EXCLUDED.oss_bucket,
               oss_object_key = EXCLUDED.oss_object_key,
               oss_etag = EXCLUDED.oss_etag,
               storage_error = EXCLUDED.storage_error,
               uploaded_at = EXCLUDED.uploaded_at,
               updated_at = now()
             WHERE (
               feishu_attachments.type,
               feishu_attachments.name,
               feishu_attachments.source_status,
               feishu_attachments.source_relative_path,
               feishu_attachments.size_bytes,
               feishu_attachments.source_error,
               feishu_attachments.storage_status,
               feishu_attachments.oss_bucket,
               feishu_attachments.oss_object_key,
               feishu_attachments.oss_etag,
               feishu_attachments.storage_error,
               feishu_attachments.uploaded_at
             ) IS DISTINCT FROM (
               EXCLUDED.type,
               EXCLUDED.name,
               EXCLUDED.source_status,
               EXCLUDED.source_relative_path,
               EXCLUDED.size_bytes,
               EXCLUDED.source_error,
               EXCLUDED.storage_status,
               EXCLUDED.oss_bucket,
               EXCLUDED.oss_object_key,
               EXCLUDED.oss_etag,
               EXCLUDED.storage_error,
               EXCLUDED.uploaded_at
             )`,
            [
              message.messageId, attachment.fileKey, job.id, attachment.type, attachment.name,
              attachment.status, attachment.relativePath, attachment.size, attachment.error,
              attachment.storageStatus ?? "not_configured", attachment.ossBucket || null,
              attachment.ossObjectKey || null, attachment.ossEtag || null,
              attachment.storageError ?? "", attachment.uploadedAt || null,
            ],
          );
        }
      }
      await client.query(
        "UPDATE feishu_chats SET last_collected_at = now(), last_seen_at = now() WHERE chat_id = $1",
        [job.chatId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listChats(category?: FeishuChatCategory): Promise<FeishuChatSummary[]> {
    const categoryFilter = category === "p2p"
      ? "WHERE c.chat_mode = 'p2p'"
      : category === "group"
        ? "WHERE c.chat_mode IN ('group', 'topic', 'unknown')"
        : "";
    const result = await this.pool.query<{
      chatId: string;
      name: string;
      description: string;
      chatMode: FeishuChatMode;
      chatStatus: FeishuChatStatus;
      external: boolean | null;
      ownerId: string;
      p2pTargetType: string;
      p2pTargetId: string;
      messageCount: number;
      firstMessageAt: Date | null;
      lastMessageAt: Date | null;
      lastCollectedAt: Date | null;
    }>(
      `SELECT
         c.chat_id AS "chatId",
         c.name,
         c.description,
         c.chat_mode AS "chatMode",
         c.chat_status AS "chatStatus",
         c.external,
         c.owner_id AS "ownerId",
         c.p2p_target_type AS "p2pTargetType",
         c.p2p_target_id AS "p2pTargetId",
         COUNT(m.message_id)::integer AS "messageCount",
         MIN(m.create_time) AS "firstMessageAt",
         MAX(m.create_time) AS "lastMessageAt",
         c.last_collected_at AS "lastCollectedAt"
       FROM feishu_chats c
       LEFT JOIN feishu_messages m ON m.chat_id = c.chat_id
       ${categoryFilter}
       GROUP BY c.chat_id, c.name, c.description, c.chat_mode, c.chat_status,
                c.external, c.owner_id, c.p2p_target_type, c.p2p_target_id, c.last_collected_at
       ORDER BY MAX(m.create_time) DESC NULLS LAST,
                c.last_collected_at DESC NULLS LAST,
                c.name ASC,
                c.chat_id ASC`,
    );
    return result.rows.map((row) => ({
      ...row,
      external: row.external ?? undefined,
      messageCount: Number(row.messageCount),
      firstMessageAt: asIso(row.firstMessageAt),
      lastMessageAt: asIso(row.lastMessageAt),
      lastCollectedAt: asIso(row.lastCollectedAt),
    }));
  }

  async listAttachmentsForRange(
    query: FeishuAttachmentRangeQuery,
  ): Promise<FeishuHistoryAttachmentRecord[]> {
    const result = await this.pool.query<{
      messageId: string;
      fileKey: string;
      lastJobId: string | null;
      type: "image" | "file";
      name: string;
      status: string;
      relativePath: string;
      size: string | number;
      error: string;
      storageStatus: string;
      ossBucket: string | null;
      ossObjectKey: string | null;
      ossEtag: string | null;
      storageError: string;
      uploadedAt: Date | null;
    }>(
      `SELECT
         a.message_id AS "messageId",
         a.file_key AS "fileKey",
         a.last_job_id::text AS "lastJobId",
         a.type,
         a.name,
         a.source_status AS status,
         a.source_relative_path AS "relativePath",
         a.size_bytes AS size,
         a.source_error AS error,
         a.storage_status AS "storageStatus",
         a.oss_bucket AS "ossBucket",
         a.oss_object_key AS "ossObjectKey",
         a.oss_etag AS "ossEtag",
         a.storage_error AS "storageError",
         a.uploaded_at AS "uploadedAt"
       FROM feishu_attachments a
       JOIN feishu_messages m ON m.message_id = a.message_id
       WHERE m.chat_id = $1
         AND m.create_time >= $2::timestamptz
         AND m.create_time < $3::timestamptz`,
      [query.chatId, query.from, query.to],
    );
    return result.rows.map((attachment) => ({
      ...attachment,
      lastJobId: attachment.lastJobId ?? "",
      size: Number(attachment.size),
      ossBucket: attachment.ossBucket ?? "",
      ossObjectKey: attachment.ossObjectKey ?? "",
      ossEtag: attachment.ossEtag ?? "",
      uploadedAt: asIso(attachment.uploadedAt),
    }));
  }

  async listMessages(query: FeishuHistoryQuery): Promise<FeishuHistoryPage | null> {
    const chat = await this.pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM feishu_chats WHERE chat_id = $1) AS exists",
      [query.chatId],
    );
    if (!chat.rows[0]?.exists) return null;

    const values: unknown[] = [query.chatId, query.snapshotAt];
    const filters = ["m.chat_id = $1", "m.first_collected_at <= $2"];
    if (query.from) {
      values.push(query.from);
      filters.push(`m.create_time >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      filters.push(`m.create_time < $${values.length}`);
    }
    const where = filters.join(" AND ");
    const count = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM feishu_messages m WHERE ${where}`,
      values,
    );
    const total = Number(count.rows[0]?.total ?? 0);
    const totalPages = Math.ceil(total / query.pageSize);
    const page = totalPages ? Math.min(query.page, totalPages) : 1;
    const pageValues = [...values, query.pageSize, (page - 1) * query.pageSize];
    const messages = await this.pool.query<{
      messageId: string;
      chatId: string;
      senderId: string;
      senderName: string;
      senderType: string;
      msgType: string;
      createTime: Date | null;
      updateTime: Date | null;
      text: string;
      rootId: string;
      parentId: string;
      deleted: boolean;
      updated: boolean;
    }>(
      `SELECT
         m.message_id AS "messageId",
         m.chat_id AS "chatId",
         m.sender_id AS "senderId",
         m.sender_name AS "senderName",
         m.sender_type AS "senderType",
         m.msg_type AS "msgType",
         m.create_time AS "createTime",
         m.update_time AS "updateTime",
         m.text,
         m.root_id AS "rootId",
         m.parent_id AS "parentId",
         m.deleted,
         m.updated
       FROM feishu_messages m
       WHERE ${where}
       ORDER BY m.create_time DESC NULLS LAST, m.message_id DESC
       LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues,
    );

    const messageIds = messages.rows.map((message) => message.messageId);
    const attachments = messageIds.length
      ? await this.pool.query<{
          messageId: string;
          fileKey: string;
          lastJobId: string | null;
          type: "image" | "file";
          name: string;
          status: string;
          relativePath: string;
          size: string;
          error: string;
          storageStatus: string;
          ossBucket: string | null;
          ossObjectKey: string | null;
          ossEtag: string | null;
          storageError: string;
          uploadedAt: Date | null;
        }>(
          `SELECT
             a.message_id AS "messageId",
             a.file_key AS "fileKey",
             a.last_job_id::text AS "lastJobId",
             a.type,
             a.name,
             a.source_status AS status,
             a.source_relative_path AS "relativePath",
             a.size_bytes::text AS size,
             a.source_error AS error,
             a.storage_status AS "storageStatus",
             a.oss_bucket AS "ossBucket",
             a.oss_object_key AS "ossObjectKey",
             a.oss_etag AS "ossEtag",
             a.storage_error AS "storageError",
             a.uploaded_at AS "uploadedAt"
           FROM feishu_attachments a
           WHERE a.message_id = ANY($1::text[])
           ORDER BY a.message_id ASC, a.file_key ASC`,
          [messageIds],
        )
      : { rows: [] };
    const attachmentsByMessage = new Map<string, FeishuHistoryAttachmentRecord[]>();
    for (const attachment of attachments.rows) {
      const list = attachmentsByMessage.get(attachment.messageId) ?? [];
      list.push({
        ...attachment,
        lastJobId: attachment.lastJobId ?? "",
        size: Number(attachment.size),
        ossBucket: attachment.ossBucket ?? "",
        ossObjectKey: attachment.ossObjectKey ?? "",
        ossEtag: attachment.ossEtag ?? "",
        uploadedAt: asIso(attachment.uploadedAt),
      });
      attachmentsByMessage.set(attachment.messageId, list);
    }
    const items: FeishuHistoryMessageRecord[] = messages.rows.map((message) => ({
      ...message,
      createTime: asIso(message.createTime),
      updateTime: asIso(message.updateTime),
      attachments: attachmentsByMessage.get(message.messageId) ?? [],
    }));
    if (query.order === "asc") items.reverse();
    return { items, page, pageSize: query.pageSize, total, totalPages, snapshotAt: query.snapshotAt };
  }

  async getAttachment(messageId: string, fileKey: string): Promise<FeishuHistoryAttachmentRecord | null> {
    const result = await this.pool.query<{
      messageId: string;
      fileKey: string;
      lastJobId: string | null;
      type: "image" | "file";
      name: string;
      status: string;
      relativePath: string;
      size: string;
      error: string;
      storageStatus: string;
      ossBucket: string | null;
      ossObjectKey: string | null;
      ossEtag: string | null;
      storageError: string;
      uploadedAt: Date | null;
    }>(
      `SELECT
         a.message_id AS "messageId",
         a.file_key AS "fileKey",
         a.last_job_id::text AS "lastJobId",
         a.type,
         a.name,
         a.source_status AS status,
         a.source_relative_path AS "relativePath",
         a.size_bytes::text AS size,
         a.source_error AS error,
         a.storage_status AS "storageStatus",
         a.oss_bucket AS "ossBucket",
         a.oss_object_key AS "ossObjectKey",
         a.oss_etag AS "ossEtag",
         a.storage_error AS "storageError",
         a.uploaded_at AS "uploadedAt"
       FROM feishu_attachments a
       WHERE a.message_id = $1 AND a.file_key = $2`,
      [messageId, fileKey],
    );
    const attachment = result.rows[0];
    if (!attachment) return null;
    return {
      ...attachment,
      lastJobId: attachment.lastJobId ?? "",
      size: Number(attachment.size),
      ossBucket: attachment.ossBucket ?? "",
      ossObjectKey: attachment.ossObjectKey ?? "",
      ossEtag: attachment.ossEtag ?? "",
      uploadedAt: asIso(attachment.uploadedAt),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
