import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FileJobStore } from "./job-store.js";
import type { TimelineAttachment, TimelineMessage, UserCliFeishuBridge } from "./types.js";

type AttachmentTaskStatus = "pending" | "running" | "completed" | "failed";

interface AttachmentTask {
  messageId: string;
  pageNumber: number;
  status: AttachmentTaskStatus;
  attempts: number;
  nextAttemptAt: string;
  error: string;
  updatedAt: string;
  attachments?: TimelineAttachment[];
  terminalError?: string;
}

interface AttachmentQueueState {
  version: 1;
  profile: string;
  items: AttachmentTask[];
}

export interface CliAttachmentWorkerOptions {
  maxAttempts?: number;
  retryDelaysMs?: number[];
  now?: () => number;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:access|refresh|tenant|user)[-_ ]?token\s*[=:]\s*[^\s,}&}]+/gi, "token=[REDACTED]")
    .replace(/app[-_ ]?secret\s*[=:]\s*[^\s,}&}]+/gi, "app_secret=[REDACTED]")
    .replace(/device[-_ ]?code\s*[=:]\s*[^\s,}&}]+/gi, "device_code=[REDACTED]")
    .slice(0, 2_000);
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, target);
}

export class CliAttachmentWorker {
  readonly #activeJobs = new Set<string>();
  #draining = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #controller: AbortController | undefined;
  #drainPromise: Promise<void> | undefined;

  constructor(
    private readonly store: FileJobStore,
    private readonly bridge: UserCliFeishuBridge,
    private readonly options: CliAttachmentWorkerOptions = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get maxAttempts(): number {
    return Math.max(1, Math.min(10, this.options.maxAttempts ?? 3));
  }

  async initialize(): Promise<void> {
    const entries = await readdir(this.store.jobsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const state = await this.read(entry.name);
      if (!state) continue;
      let changed = false;
      for (const item of state.items) {
        if (item.status === "running") {
          item.status = "pending";
          item.nextAttemptAt = "";
          item.updatedAt = new Date(this.now()).toISOString();
          changed = true;
        }
      }
      if (changed) await this.write(entry.name, state);
      if (state.items.some((item) => item.status === "pending")) this.#activeJobs.add(entry.name);
    }
    this.kick();
  }

  async enqueue(
    jobId: string,
    profile: string,
    pageNumber: number,
    messages: TimelineMessage[],
  ): Promise<void> {
    const messageIds = messages
      .filter((message) => message.attachments.some((attachment) => attachment.status === "pending"))
      .map((message) => message.messageId)
      .filter(Boolean);
    if (!messageIds.length) return;
    const state = await this.read(jobId) ?? { version: 1, profile, items: [] };
    if (state.profile !== profile) throw new Error("附件队列 profile 与当前采集身份不一致");
    const existing = new Set(state.items.map((item) => item.messageId));
    const timestamp = new Date(this.now()).toISOString();
    for (const messageId of messageIds) {
      if (existing.has(messageId)) continue;
      state.items.push({
        messageId,
        pageNumber,
        status: "pending",
        attempts: 0,
        nextAttemptAt: "",
        error: "",
        updatedAt: timestamp,
      });
    }
    await this.write(jobId, state);
  }

  activate(jobId: string): void {
    if (this.#stopped) return;
    this.#activeJobs.add(jobId);
    this.kick();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#controller?.abort();
    await this.#drainPromise?.catch(() => undefined);
  }

  private kick(delayMs = 0): void {
    if (this.#stopped || this.#draining) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const draining = this.drain();
      this.#drainPromise = draining;
      void draining
        .catch(() => {
          if (!this.#stopped) this.kick(5_000);
        })
        .finally(() => {
          if (this.#drainPromise === draining) this.#drainPromise = undefined;
        });
    }, Math.max(0, delayMs));
    this.#timer.unref();
  }

  private async drain(): Promise<void> {
    if (this.#stopped || this.#draining) return;
    this.#draining = true;
    let nextWake = Number.POSITIVE_INFINITY;
    try {
      for (const jobId of [...this.#activeJobs]) {
        const state = await this.read(jobId);
        if (!state) {
          this.#activeJobs.delete(jobId);
          continue;
        }
        const now = this.now();
        const ready = state.items.find((item) =>
          item.status === "pending" && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now));
        if (ready) {
          await this.process(jobId, state, ready);
          this.#draining = false;
          this.kick();
          return;
        }
        const pending = state.items.filter((item) => item.status === "pending");
        if (!pending.length) {
          this.#activeJobs.delete(jobId);
          continue;
        }
        for (const item of pending) {
          if (item.nextAttemptAt) nextWake = Math.min(nextWake, Date.parse(item.nextAttemptAt));
        }
      }
    } finally {
      this.#draining = false;
    }
    if (Number.isFinite(nextWake)) this.kick(Math.max(0, nextWake - this.now()));
  }

  private async process(jobId: string, state: AttachmentQueueState, item: AttachmentTask): Promise<void> {
    item.status = "running";
    item.nextAttemptAt = "";
    item.updatedAt = new Date(this.now()).toISOString();
    if (!item.attachments?.length && !item.terminalError) item.attempts += 1;
    await this.write(jobId, state);
    const job = this.store.get(jobId);
    if (!job) {
      item.status = "failed";
      item.error = "附件任务对应的采集任务不存在";
      item.updatedAt = new Date(this.now()).toISOString();
      await this.write(jobId, state);
      return;
    }
    if (item.terminalError) {
      await this.finalizeFailure(jobId, state, item);
      return;
    }

    let attachments = item.attachments;
    if (!attachments?.length) {
      const controller = new AbortController();
      this.#controller = controller;
      try {
        attachments = await this.bridge.downloadMessageAttachments({
          profile: state.profile,
          chatId: job.chatId,
          messageId: item.messageId,
          outputDir: this.store.taskRoot(jobId),
          signal: controller.signal,
        });
        if (!attachments.length) throw new Error("Lark CLI 未返回消息中的附件资源");
        item.attachments = attachments;
        item.error = "";
        item.updatedAt = new Date(this.now()).toISOString();
        await this.write(jobId, state);
      } catch (error) {
        const message = safeError(error);
        item.error = message;
        if (item.attempts >= this.maxAttempts) {
          item.terminalError = message;
          await this.finalizeFailure(jobId, state, item);
          return;
        }
        this.scheduleRetry(item);
        await this.write(jobId, state);
        return;
      } finally {
        if (this.#controller === controller) this.#controller = undefined;
      }
    }

    try {
      await this.store.saveAttachmentResult(jobId, item.pageNumber, item.messageId, attachments);
      item.status = "completed";
      item.error = "";
      delete item.attachments;
    } catch (error) {
      item.error = `附件已下载，持久化失败：${safeError(error)}`;
      this.scheduleRetry(item);
    }
    item.updatedAt = new Date(this.now()).toISOString();
    await this.write(jobId, state);
  }

  private async finalizeFailure(
    jobId: string,
    state: AttachmentQueueState,
    item: AttachmentTask,
  ): Promise<void> {
    const terminalError = item.terminalError || item.error || "未知附件错误";
    try {
      await this.store.saveAttachmentResult(
        jobId,
        item.pageNumber,
        item.messageId,
        [],
        `附件后台处理失败：${terminalError}`,
      );
      item.status = "failed";
      item.error = terminalError;
    } catch (error) {
      item.error = `附件失败状态持久化失败：${safeError(error)}`;
      this.scheduleRetry(item);
    }
    item.updatedAt = new Date(this.now()).toISOString();
    await this.write(jobId, state);
  }

  private scheduleRetry(item: AttachmentTask): void {
    const delays = this.options.retryDelaysMs ?? [5_000, 30_000, 120_000];
    const delay = delays[Math.min(Math.max(0, item.attempts - 1), delays.length - 1)] ?? 0;
    item.status = "pending";
    item.nextAttemptAt = new Date(this.now() + Math.max(0, delay)).toISOString();
  }

  private queuePath(jobId: string): string {
    return path.join(this.store.taskRoot(jobId), "attachment-queue.json");
  }

  private async read(jobId: string): Promise<AttachmentQueueState | null> {
    try {
      const value = JSON.parse(await readFile(this.queuePath(jobId), "utf8")) as AttachmentQueueState;
      return value.version === 1 && typeof value.profile === "string" && Array.isArray(value.items) ? value : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }

  private async write(jobId: string, state: AttachmentQueueState): Promise<void> {
    await writeJsonAtomic(this.queuePath(jobId), state);
  }
}
