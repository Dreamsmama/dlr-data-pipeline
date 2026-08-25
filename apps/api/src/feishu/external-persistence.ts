import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  FeishuChatCategory,
  FeishuChatSummary,
  FeishuHistoryAttachmentRecord,
  FeishuHistoryPage,
  FeishuHistoryQuery,
  FeishuJobRecord,
  FeishuMessageRecord,
  PostgresFeishuRepository,
} from "@dlr/database";
import { objectKey, type ObjectStorage, type StoredObjectStream } from "@dlr/storage";

import type { JobPersistence } from "./job-store.js";
import type { CollectionJob, FeishuChat, PageEvent, TimelineAttachment } from "./types.js";

type PersistenceRepository = Pick<PostgresFeishuRepository, "health" | "saveJob" | "savePage" | "close">;
type HistoryRepository = Pick<PostgresFeishuRepository, "listChats" | "listMessages" | "getAttachment">;
type AttachmentReuseRepository = Partial<Pick<PostgresFeishuRepository, "listAttachmentsForRange">>;

interface AttachmentIdentity {
  messageId: string;
  fileKey: string;
}

function attachmentIdentity(messageId: string, fileKey: string): string {
  return `${messageId.length}:${messageId}${fileKey}`;
}

function safeLocalSegment(value: string, fallback: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/[. ]+$/g, "");
  return cleaned.slice(0, 180) || fallback;
}

function sourceStatus(value: string): TimelineAttachment["status"] {
  return ["pending", "downloaded", "reused", "unavailable", "failed"].includes(value)
    ? value as TimelineAttachment["status"]
    : "failed";
}

function storageStatus(value: string): TimelineAttachment["storageStatus"] {
  return ["pending", "not_configured", "source_failed", "uploaded", "upload_failed"].includes(value)
    ? value as TimelineAttachment["storageStatus"]
    : "not_configured";
}

function timelineAttachment(record: FeishuHistoryAttachmentRecord): TimelineAttachment {
  return {
    type: record.type,
    fileKey: record.fileKey,
    name: record.name,
    status: sourceStatus(record.status),
    relativePath: record.relativePath,
    size: record.size,
    error: record.error,
    storageStatus: storageStatus(record.storageStatus ?? "not_configured"),
    ossBucket: record.ossBucket,
    ossObjectKey: record.ossObjectKey,
    ossEtag: record.ossEtag,
    storageError: record.storageError,
    uploadedAt: record.uploadedAt,
  };
}

export interface FeishuHistoryDataSource {
  listChats(category?: FeishuChatCategory): Promise<FeishuChatSummary[]>;
  listMessages(query: FeishuHistoryQuery): Promise<FeishuHistoryPage | null>;
  getAttachment(messageId: string, fileKey: string): Promise<FeishuHistoryAttachmentRecord | null>;
  createAttachmentUrl(
    attachment: FeishuHistoryAttachmentRecord,
    options?: { download?: boolean },
  ): string;
  readAttachment(
    attachment: FeishuHistoryAttachmentRecord,
    range?: string,
  ): Promise<StoredObjectStream | null>;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/access[-_ ]?key(?:[-_ ]?(?:id|secret))?\s*[=:]\s*[^\s,}]+/gi, "AccessKey=[REDACTED]")
    .slice(0, 2_000);
}

export class FeishuExternalPersistence implements JobPersistence {
  readonly #attachmentReuse = new Map<string, Map<string, TimelineAttachment>>();

  constructor(
    private readonly repository: PersistenceRepository & Partial<HistoryRepository> & AttachmentReuseRepository,
    private readonly storage: ObjectStorage,
  ) {}

  private historyRepository(): HistoryRepository {
    if (!this.repository.listChats || !this.repository.listMessages || !this.repository.getAttachment) {
      throw new Error("飞书内部数据查询源未配置");
    }
    return this.repository as PersistenceRepository & HistoryRepository;
  }

  async health(): Promise<void> {
    await this.repository.health();
  }

  async saveJob(job: CollectionJob, chat?: FeishuChat): Promise<void> {
    await this.repository.saveJob({
      ...job,
      description: chat?.description ?? "",
      chatMode: chat?.chatMode ?? job.chatMode,
      chatStatus: chat?.chatStatus ?? job.chatStatus,
      external: chat?.external ?? job.external,
      ownerId: chat?.ownerId ?? job.ownerId,
      p2pTargetType: chat?.p2pTargetType ?? job.p2pTargetType,
      p2pTargetId: chat?.p2pTargetId ?? job.p2pTargetId,
    } satisfies FeishuJobRecord);
    if (["completed", "partial", "failed"].includes(job.status)) {
      this.#attachmentReuse.delete(job.id);
    }
  }

  async prepareAttachmentReuse(
    job: CollectionJob,
    taskRoot: string,
  ): Promise<AttachmentIdentity[]> {
    if (!job.startTime || !job.endTimeExclusive || !this.repository.listAttachmentsForRange) return [];
    const existing = await this.repository.listAttachmentsForRange({
      chatId: job.chatId,
      from: job.startTime,
      to: job.endTimeExclusive,
    });
    const reusable = new Map<string, TimelineAttachment>();
    for (const record of existing) {
      const key = attachmentIdentity(record.messageId, record.fileKey);
      if (
        record.storageStatus === "uploaded" &&
        record.ossBucket === this.storage.bucket &&
        Boolean(record.ossObjectKey)
      ) {
        reusable.set(key, timelineAttachment(record));
        continue;
      }
      if (
        record.storageStatus !== "upload_failed" ||
        !["downloaded", "reused"].includes(record.status) ||
        !record.lastJobId ||
        !record.relativePath
      ) {
        continue;
      }
      const copied = await this.copyReusableLocalFile(taskRoot, record).catch(() => null);
      if (copied) reusable.set(key, copied);
    }
    this.#attachmentReuse.set(job.id, reusable);
    return existing
      .filter((record) => reusable.has(attachmentIdentity(record.messageId, record.fileKey)))
      .map((record) => ({ messageId: record.messageId, fileKey: record.fileKey }));
  }

  async preparePage(job: CollectionJob, event: PageEvent, taskRoot: string): Promise<PageEvent> {
    let uploadFailures = 0;
    const root = path.resolve(taskRoot);
    const messages = [];
    for (const message of event.messages) {
      const attachments: TimelineAttachment[] = [];
      for (const incoming of message.attachments) {
        let attachment = incoming;
        if (attachment.status === "pending") {
          const reused = this.#attachmentReuse.get(job.id)?.get(
            attachmentIdentity(message.messageId, attachment.fileKey),
          );
          if (reused) attachment = reused;
        }
        if (
          attachment.storageStatus === "uploaded" &&
          attachment.ossBucket === this.storage.bucket &&
          attachment.ossObjectKey
        ) {
          attachments.push(attachment);
          continue;
        }
        if (attachment.status === "pending") {
          attachments.push({ ...attachment, storageStatus: "pending" });
          continue;
        }
        if (!["downloaded", "reused"].includes(attachment.status) || !attachment.relativePath) {
          attachments.push({ ...attachment, storageStatus: "source_failed" });
          continue;
        }
        try {
          const localFile = path.resolve(root, attachment.relativePath);
          if (!localFile.startsWith(`${root}${path.sep}`)) throw new Error("附件暂存路径超出任务目录");
          const info = await stat(localFile);
          if (!info.isFile()) throw new Error("附件暂存文件不存在");
          const key = objectKey(
            "internal",
            `feishu/${job.chatId}/${message.messageId}`,
            `${attachment.fileKey}__${attachment.name || path.basename(localFile)}`,
          );
          const stored = await this.storage.uploadFile(key, localFile);
          attachments.push({
            ...attachment,
            storageStatus: "uploaded",
            ossBucket: stored.bucket,
            ossObjectKey: stored.objectKey,
            ossEtag: stored.etag,
            storageError: "",
            uploadedAt: new Date().toISOString(),
          });
        } catch (error) {
          uploadFailures += 1;
          attachments.push({
            ...attachment,
            storageStatus: "upload_failed",
            storageError: safeError(error),
          });
        }
      }
      messages.push({ ...message, attachments });
    }
    return {
      ...event,
      messages,
      attachmentFailedCount: event.attachmentFailedCount + uploadFailures,
    };
  }

  async savePage(job: CollectionJob, event: PageEvent): Promise<void> {
    await this.repository.savePage(job, event.messages satisfies FeishuMessageRecord[]);
  }

  async listChats(category?: FeishuChatCategory): Promise<FeishuChatSummary[]> {
    return this.historyRepository().listChats(category);
  }

  async listMessages(query: FeishuHistoryQuery): Promise<FeishuHistoryPage | null> {
    return this.historyRepository().listMessages(query);
  }

  async getAttachment(messageId: string, fileKey: string): Promise<FeishuHistoryAttachmentRecord | null> {
    return this.historyRepository().getAttachment(messageId, fileKey);
  }

  createAttachmentUrl(
    attachment: FeishuHistoryAttachmentRecord,
    options: { download?: boolean } = {},
  ): string {
    if (
      attachment.storageStatus !== "uploaded" ||
      !attachment.ossObjectKey ||
      attachment.ossBucket !== this.storage.bucket ||
      !this.storage.createSignedDownloadUrl
    ) {
      return "";
    }
    return this.storage.createSignedDownloadUrl(
      attachment.ossObjectKey,
      attachment.name,
      options.download ?? false,
      900,
    );
  }

  async readAttachment(
    attachment: FeishuHistoryAttachmentRecord,
    range?: string,
  ): Promise<StoredObjectStream | null> {
    if (
      attachment.storageStatus !== "uploaded" ||
      !attachment.ossObjectKey ||
      attachment.ossBucket !== this.storage.bucket ||
      !this.storage.getObjectStream
    ) {
      return null;
    }
    return this.storage.getObjectStream(attachment.ossObjectKey, range);
  }

  async close(): Promise<void> {
    this.#attachmentReuse.clear();
    await this.repository.close();
  }

  private async copyReusableLocalFile(
    taskRoot: string,
    record: FeishuHistoryAttachmentRecord,
  ): Promise<TimelineAttachment | null> {
    if (path.basename(record.lastJobId) !== record.lastJobId) return null;
    const jobsRoot = path.dirname(path.resolve(taskRoot));
    const previousRoot = path.resolve(jobsRoot, record.lastJobId);
    const previousRootReal = await realpath(previousRoot);
    const source = await realpath(path.resolve(previousRoot, record.relativePath));
    if (!source.startsWith(`${previousRootReal}${path.sep}`)) return null;
    const sourceInfo = await stat(source);
    if (!sourceInfo.isFile() || sourceInfo.size <= 0) return null;
    if (record.size > 0 && sourceInfo.size !== record.size) return null;

    const messageSegment = safeLocalSegment(record.messageId, "message");
    const fileSegment = safeLocalSegment(path.basename(source), safeLocalSegment(record.fileKey, "attachment"));
    const destination = path.resolve(taskRoot, "attachments", messageSegment, fileSegment);
    if (!destination.startsWith(`${path.resolve(taskRoot)}${path.sep}`)) return null;
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const copiedInfo = await stat(destination);
    if (!copiedInfo.isFile() || copiedInfo.size !== sourceInfo.size) return null;
    return {
      ...timelineAttachment(record),
      status: "reused",
      relativePath: path.relative(taskRoot, destination).replaceAll("\\", "/"),
      size: copiedInfo.size,
    };
  }
}
