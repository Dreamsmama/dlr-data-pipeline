import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AttachmentIdentity,
  CollectionJob,
  FeishuChat,
  PageEvent,
  TimelineAttachment,
  TimelineMessage,
} from "./types.js";

export interface JobPersistence {
  saveJob(job: CollectionJob, chat?: FeishuChat): Promise<void>;
  prepareAttachmentReuse?(job: CollectionJob, taskRoot: string): Promise<AttachmentIdentity[]>;
  preparePage(job: CollectionJob, event: PageEvent, taskRoot: string): Promise<PageEvent>;
  savePage(job: CollectionJob, event: PageEvent): Promise<void>;
  close?(): Promise<void>;
}

const localOnlyPersistence: JobPersistence = {
  async saveJob() {},
  async prepareAttachmentReuse() { return []; },
  async preparePage(_job, event) { return event; },
  async savePage() {},
};

function nowIso(): string {
  return new Date().toISOString();
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, target);
}

export class FileJobStore {
  readonly #jobs = new Map<string, CollectionJob>();
  readonly jobsRoot: string;

  constructor(
    readonly root: string,
    private readonly external: JobPersistence = localOnlyPersistence,
  ) {
    this.jobsRoot = path.join(root, "jobs");
  }

  async initialize(): Promise<void> {
    await mkdir(this.jobsRoot, { recursive: true });
    const entries = await readdir(this.jobsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metadataPath = this.jobMetadataPath(entry.name);
      try {
        const stored = JSON.parse(await readFile(metadataPath, "utf8")) as Partial<CollectionJob>;
        const job: CollectionJob = {
          collectorType: "robot",
          callerIdentity: "bot",
          appNamespace: "",
          chatMode: "group",
          chatStatus: "unknown",
          ownerId: "",
          p2pTargetType: "",
          p2pTargetId: "",
          attachmentPendingCount: 0,
          attachmentProcessedCount: Number(stored.attachmentCount ?? 0),
          ...stored,
        } as CollectionJob;
        if (job.status === "queued" || job.status === "running") {
          job.status = "failed";
          job.error = "API 服务重启导致采集任务中断，请重新输入凭证后继续。";
          job.updatedAt = nowIso();
          await writeJsonAtomic(metadataPath, job);
        }
        this.#jobs.set(job.id, job);
      } catch {
        // 损坏或不完整的任务目录不会阻止其他任务加载。
      }
    }
  }

  async create(
    chat: FeishuChat,
    range: { startTime: string; endTimeExclusive: string },
    provenance: {
      collectorType: CollectionJob["collectorType"];
      callerIdentity: CollectionJob["callerIdentity"];
      appNamespace: string;
    } = { collectorType: "robot", callerIdentity: "bot", appNamespace: "" },
  ): Promise<CollectionJob> {
    const timestamp = nowIso();
    const job: CollectionJob = {
      id: randomUUID(),
      collectorType: provenance.collectorType,
      callerIdentity: provenance.callerIdentity,
      appNamespace: provenance.appNamespace,
      chatId: chat.chatId,
      chatName: chat.name,
      chatMode: chat.chatMode,
      chatStatus: chat.chatStatus,
      external: chat.external,
      ownerId: chat.ownerId ?? "",
      p2pTargetType: chat.p2pTargetType ?? "",
      p2pTargetId: chat.p2pTargetId ?? "",
      status: "queued",
      pages: 0,
      messageCount: 0,
      attachmentCount: 0,
      attachmentPendingCount: 0,
      attachmentProcessedCount: 0,
      attachmentFailedCount: 0,
      nextPageToken: "",
      hasMore: true,
      error: "",
      startTime: range.startTime,
      endTimeExclusive: range.endTimeExclusive,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: "",
    };
    await mkdir(this.pageRoot(job.id), { recursive: true });
    await mkdir(this.attachmentRoot(job.id), { recursive: true });
    await this.external.saveJob(job, chat);
    this.#jobs.set(job.id, job);
    await this.persist(job);
    return { ...job };
  }

  list(): CollectionJob[] {
    return [...this.#jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((job) => ({ ...job }));
  }

  get(id: string): CollectionJob | undefined {
    const job = this.#jobs.get(id);
    return job ? { ...job } : undefined;
  }

  hasActiveChat(chatId: string, excludingJobId = ""): boolean {
    return [...this.#jobs.values()].some(
      (job) =>
        job.id !== excludingJobId &&
        job.chatId === chatId &&
        (job.status === "queued" || job.status === "running"),
    );
  }

  async update(id: string, values: Partial<CollectionJob>): Promise<CollectionJob> {
    const current = this.#jobs.get(id);
    if (!current) throw new Error("采集任务不存在");
    const next = { ...current, ...values, id: current.id, updatedAt: nowIso() };
    this.#jobs.set(id, next);
    await this.persist(next);
    await this.external.saveJob(next);
    return { ...next };
  }

  async prepareAttachmentReuse(jobId: string): Promise<AttachmentIdentity[]> {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error("采集任务不存在");
    return this.external.prepareAttachmentReuse?.(job, this.taskRoot(jobId)) ?? [];
  }

  async savePage(jobId: string, event: PageEvent): Promise<CollectionJob> {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error("采集任务不存在");
    if (event.pageNumber !== job.pages + 1) {
      throw new Error(`页序号异常：期望 ${job.pages + 1}，收到 ${event.pageNumber}`);
    }
    const prepared = await this.external.preparePage(job, event, this.taskRoot(jobId));
    const pendingCount = prepared.messages.reduce(
      (total, message) => total + message.attachments.filter((attachment) => attachment.status === "pending").length,
      0,
    );
    const next: CollectionJob = {
      ...job,
      pages: prepared.pageNumber,
      messageCount: job.messageCount + prepared.messages.length,
      attachmentCount: job.attachmentCount + prepared.attachmentCount,
      attachmentPendingCount: job.attachmentPendingCount + pendingCount,
      attachmentProcessedCount: job.attachmentProcessedCount + prepared.attachmentCount - pendingCount,
      attachmentFailedCount: job.attachmentFailedCount + prepared.attachmentFailedCount,
      nextPageToken: prepared.nextPageToken,
      hasMore: prepared.hasMore,
      updatedAt: nowIso(),
    };
    await this.external.savePage(next, prepared);
    const pagePath = path.join(this.pageRoot(jobId), `${String(prepared.pageNumber).padStart(6, "0")}.json`);
    await writeJsonAtomic(pagePath, prepared.messages);
    this.#jobs.set(jobId, next);
    await this.persist(next);
    return { ...next };
  }

  async saveAttachmentResult(
    jobId: string,
    pageNumber: number,
    messageId: string,
    downloaded: TimelineAttachment[],
    missingError = "Lark CLI 未返回该附件资源",
  ): Promise<CollectionJob> {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error("采集任务不存在");
    const pagePath = path.join(this.pageRoot(jobId), `${String(pageNumber).padStart(6, "0")}.json`);
    const messages = JSON.parse(await readFile(pagePath, "utf8")) as TimelineMessage[];
    const messageIndex = messages.findIndex((message) => message.messageId === messageId);
    if (messageIndex < 0) throw new Error(`附件任务对应的消息不存在：${messageId}`);
    const current = messages[messageIndex];
    const results = new Map(downloaded.map((attachment) => [attachment.fileKey, attachment]));
    const currentKeys = new Set(current.attachments.map((attachment) => attachment.fileKey));
    const additionalResults = [...results.values()].filter((attachment) => !currentKeys.has(attachment.fileKey));
    const oldPending = current.attachments.filter((attachment) => attachment.status === "pending").length;
    const oldFailed = current.attachments.filter((attachment) => attachmentFailed(attachment)).length;
    const merged = current.attachments.map((attachment): TimelineAttachment => {
      if (attachment.status !== "pending") return attachment;
      return results.get(attachment.fileKey) ?? {
        ...attachment,
        status: "failed",
        error: missingError,
        storageStatus: "source_failed",
      };
    });
    merged.push(...additionalResults);
    const candidate = { ...current, attachments: merged };
    const sourceFailures = merged.filter((attachment) => attachmentFailed(attachment)).length;
    const prepared = await this.external.preparePage(job, {
      event: "page",
      pageNumber,
      messages: [candidate],
      nextPageToken: job.nextPageToken,
      hasMore: job.hasMore,
      attachmentCount: merged.length,
      attachmentFailedCount: sourceFailures,
    }, this.taskRoot(jobId));
    const updatedMessage = prepared.messages[0];
    messages[messageIndex] = updatedMessage;
    const newPending = updatedMessage.attachments.filter((attachment) => attachment.status === "pending").length;
    const newFailed = updatedMessage.attachments.filter((attachment) => attachmentFailed(attachment)).length;
    const nextPending = Math.max(0, job.attachmentPendingCount - oldPending + newPending);
    const nextFailed = Math.max(0, job.attachmentFailedCount - oldFailed + newFailed);
    const next: CollectionJob = {
      ...job,
      attachmentCount: job.attachmentCount + additionalResults.length,
      attachmentPendingCount: nextPending,
      attachmentProcessedCount: Math.max(
        0,
        job.attachmentProcessedCount
          + oldPending
          - newPending
          + additionalResults.filter((attachment) => attachment.status !== "pending").length,
      ),
      attachmentFailedCount: nextFailed,
      status: job.status === "failed" ? "failed" : nextPending === 0 && nextFailed > 0 ? "partial" : job.status,
      error: job.status === "failed"
        ? job.error
        : nextPending === 0 && nextFailed > 0 ? `${nextFailed} 个附件后台处理失败` : job.error,
      updatedAt: nowIso(),
    };
    await this.external.savePage(next, prepared);
    await writeJsonAtomic(pagePath, messages);
    this.#jobs.set(jobId, next);
    await this.persist(next);
    await this.external.saveJob(next);
    return { ...next };
  }

  async readMessages(
    jobId: string,
    cursor: number,
    limit: number,
  ): Promise<{ items: TimelineMessage[]; nextCursor: number | null }> {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error("采集任务不存在");
    const files = (await readdir(this.pageRoot(jobId)))
      .filter((name) => /^\d{6}\.json$/.test(name))
      .sort();
    const items: TimelineMessage[] = [];
    let seen = 0;
    for (const file of files) {
      const page = JSON.parse(await readFile(path.join(this.pageRoot(jobId), file), "utf8")) as TimelineMessage[];
      for (const message of page) {
        if (seen++ < cursor) continue;
        if (items.length < limit) items.push(message);
      }
      if (items.length >= limit) break;
    }
    const consumed = cursor + items.length;
    return {
      items,
      nextCursor: consumed < job.messageCount ? consumed : null,
    };
  }

  async readPageMessages(jobId: string, pageNumber: number): Promise<TimelineMessage[]> {
    if (!this.#jobs.has(jobId)) throw new Error("采集任务不存在");
    if (!Number.isSafeInteger(pageNumber) || pageNumber <= 0) throw new Error("页面序号不合法");
    const pagePath = path.join(this.pageRoot(jobId), `${String(pageNumber).padStart(6, "0")}.json`);
    return JSON.parse(await readFile(pagePath, "utf8")) as TimelineMessage[];
  }

  async resolveAttachment(jobId: string, messageId: string, fileName: string): Promise<string> {
    if (!this.#jobs.has(jobId)) throw new Error("采集任务不存在");
    if (path.basename(messageId) !== messageId || path.basename(fileName) !== fileName) {
      throw new Error("附件路径不合法");
    }
    const root = path.resolve(this.attachmentRoot(jobId));
    const candidate = path.resolve(root, messageId, fileName);
    if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error("附件路径超出任务目录");
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error("附件不存在");
    return candidate;
  }

  taskRoot(jobId: string): string {
    return path.join(this.jobsRoot, jobId);
  }

  async close(): Promise<void> {
    await this.external.close?.();
  }

  private pageRoot(jobId: string): string {
    return path.join(this.taskRoot(jobId), "pages");
  }

  private attachmentRoot(jobId: string): string {
    return path.join(this.taskRoot(jobId), "attachments");
  }

  private jobMetadataPath(jobId: string): string {
    return path.join(this.taskRoot(jobId), "job.json");
  }

  private async persist(job: CollectionJob): Promise<void> {
    await writeJsonAtomic(this.jobMetadataPath(job.id), job);
  }
}

function attachmentFailed(attachment: TimelineAttachment): boolean {
  return ["failed", "unavailable"].includes(attachment.status)
    || ["source_failed", "upload_failed"].includes(attachment.storageStatus ?? "");
}
