import type { CredentialSessionStore } from "./session-store.js";
import type { CredentialSession } from "./session-store.js";
import type { FileJobStore } from "./job-store.js";
import type { CliAttachmentWorker } from "./attachment-worker.js";
import type { BridgeCallbacks, CollectionJob, FeishuBridge, UserCliFeishuBridge } from "./types.js";

export class FeishuJobRunner {
  readonly #runningJobs = new Set<string>();

  constructor(
    private readonly store: FileJobStore,
    private readonly sessions: CredentialSessionStore,
    private readonly bridge: FeishuBridge,
    private readonly cliBridge?: UserCliFeishuBridge,
    private readonly attachmentWorker?: CliAttachmentWorker,
  ) {}

  isRunning(jobId: string): boolean {
    return this.#runningJobs.has(jobId);
  }

  start(job: CollectionJob, sessionId: string): void {
    if (this.#runningJobs.has(job.id)) throw new Error("任务已经在运行");
    if (!job.startTime || !job.endTimeExclusive) {
      throw new Error("旧任务未记录抓取时间范围，不能继续，请新建采集任务");
    }
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("凭证会话已过期，请重新接入并验证身份");
    if (
      session.collectorType !== job.collectorType ||
      session.callerIdentity !== job.callerIdentity ||
      (job.appNamespace && session.appNamespace !== job.appNamespace)
    ) {
      throw new Error("当前凭证身份与原采集任务不一致");
    }
    this.#runningJobs.add(job.id);
    void this.run(job, sessionId, session);
  }

  private async run(job: CollectionJob, sessionId: string, session: CredentialSession): Promise<void> {
    try {
      const startTime = job.startTime;
      const endTimeExclusive = job.endTimeExclusive;
      if (!startTime || !endTimeExclusive) {
        throw new Error("旧任务未记录抓取时间范围，不能继续，请新建采集任务");
      }
      await this.store.update(job.id, { status: "running", error: "" });
      const skipAttachments = await this.store.prepareAttachmentReuse(job.id);
      const baseRequest = {
        chatId: job.chatId,
        chatName: job.chatName,
        outputDir: this.store.taskRoot(job.id),
        pageToken: job.nextPageToken,
        pageNumber: job.pages,
        startTime,
        endTimeExclusive,
      };
      const callbacks: BridgeCallbacks = {
        onEvent: async (event) => {
          if (event.event === "page") {
            await this.store.savePage(job.id, event);
            if (session.collectorType === "cli" && this.attachmentWorker) {
              const preparedMessages = await this.store.readPageMessages(job.id, event.pageNumber);
              await this.attachmentWorker.enqueue(job.id, session.profile, event.pageNumber, preparedMessages);
            }
          }
          if (event.event === "warning") {
            const current = this.store.get(job.id)?.error ?? "";
            const warnings = [...new Set([current, event.message].filter(Boolean))];
            await this.store.update(job.id, { error: warnings.join("；") });
          }
        },
      };
      if (session.collectorType === "cli") {
        if (!this.cliBridge) throw new Error("CLI 采集器未配置");
        await this.cliBridge.crawl({
          profile: session.profile,
          ...baseRequest,
        }, callbacks);
      } else {
        await this.bridge.crawl(
          {
            ...baseRequest,
            appId: session.appId,
            appSecret: session.appSecret,
            skipAttachments,
          },
          callbacks,
        );
      }
      const latest = this.store.get(job.id);
      await this.store.update(job.id, {
        status: latest?.attachmentFailedCount || latest?.error ? "partial" : "completed",
        hasMore: false,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.store.update(job.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    } finally {
      if (session.collectorType === "cli") this.attachmentWorker?.activate(job.id);
      this.#runningJobs.delete(job.id);
      this.sessions.delete(sessionId);
    }
  }
}
