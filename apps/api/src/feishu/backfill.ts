import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { CollectionJob, FeishuChat, PageEvent, TimelineMessage } from "./types.js";

export interface BackfillPersistence {
  saveJob(job: CollectionJob, chat?: FeishuChat): Promise<void>;
  preparePage(job: CollectionJob, event: PageEvent, taskRoot: string): Promise<PageEvent>;
  savePage(job: CollectionJob, event: PageEvent): Promise<void>;
}

export interface BackfillJobPlan {
  jobId: string;
  chatId: string;
  chatName: string;
  pages: number;
  messages: number;
  excluded: boolean;
}

export interface BackfillResult {
  applied: boolean;
  jobs: BackfillJobPlan[];
  includedJobs: number;
  includedPages: number;
  includedMessages: number;
  appliedPages: number;
  appliedMessages: number;
  uploadFailures: number;
}

interface JobFiles {
  job: CollectionJob;
  taskRoot: string;
  pageFiles: string[];
  plan: BackfillJobPlan;
}

async function readPage(file: string): Promise<TimelineMessage[]> {
  const value = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!Array.isArray(value)) throw new Error(`历史页不是消息数组：${file}`);
  return value as TimelineMessage[];
}

async function scanJobs(dataRoot: string, excludedChatIds: Set<string>): Promise<JobFiles[]> {
  const jobsRoot = path.join(dataRoot, "jobs");
  const directories = (await readdir(jobsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const jobs: JobFiles[] = [];
  for (const directory of directories) {
    const taskRoot = path.join(jobsRoot, directory.name);
    const stored = JSON.parse(await readFile(path.join(taskRoot, "job.json"), "utf8")) as Partial<CollectionJob>;
    const job: CollectionJob = {
      collectorType: "robot",
      callerIdentity: "bot",
      appNamespace: "",
      chatMode: "group",
      chatStatus: "unknown",
      ownerId: "",
      p2pTargetType: "",
      p2pTargetId: "",
      ...stored,
    } as CollectionJob;
    const pageFiles = (await readdir(path.join(taskRoot, "pages")))
      .filter((name) => /^\d{6}\.json$/.test(name))
      .sort()
      .map((name) => path.join(taskRoot, "pages", name));
    let messages = 0;
    for (const pageFile of pageFiles) messages += (await readPage(pageFile)).length;
    jobs.push({
      job,
      taskRoot,
      pageFiles,
      plan: {
        jobId: job.id,
        chatId: job.chatId,
        chatName: job.chatName,
        pages: pageFiles.length,
        messages,
        excluded: excludedChatIds.has(job.chatId),
      },
    });
  }
  return jobs;
}

export async function backfillFeishuHistory(options: {
  dataRoot: string;
  persistence?: BackfillPersistence;
  apply?: boolean;
  excludedChatIds?: string[];
}): Promise<BackfillResult> {
  const apply = options.apply ?? false;
  if (apply && !options.persistence) throw new Error("执行历史回填时必须配置 PostgreSQL 与 OSS 持久化");
  const excluded = new Set(options.excludedChatIds ?? []);
  const jobs = await scanJobs(options.dataRoot, excluded);
  const included = jobs.filter((item) => !item.plan.excluded);
  const result: BackfillResult = {
    applied: apply,
    jobs: jobs.map((item) => item.plan),
    includedJobs: included.length,
    includedPages: included.reduce((total, item) => total + item.plan.pages, 0),
    includedMessages: included.reduce((total, item) => total + item.plan.messages, 0),
    appliedPages: 0,
    appliedMessages: 0,
    uploadFailures: 0,
  };
  if (!apply || !options.persistence) return result;

  for (const item of included) {
    await options.persistence.saveJob(item.job, {
      chatId: item.job.chatId,
      name: item.job.chatName,
      chatMode: item.job.chatMode,
      chatStatus: item.job.chatStatus,
      external: item.job.external,
      ownerId: item.job.ownerId,
      p2pTargetType: item.job.p2pTargetType,
      p2pTargetId: item.job.p2pTargetId,
    });
    let jobUploadFailures = 0;
    for (const [index, pageFile] of item.pageFiles.entries()) {
      const messages = await readPage(pageFile);
      const attachmentCount = messages.reduce((total, message) => total + message.attachments.length, 0);
      const sourceFailures = messages.reduce(
        (total, message) => total + message.attachments.filter(
          (attachment) => !["downloaded", "reused"].includes(attachment.status),
        ).length,
        0,
      );
      const event: PageEvent = {
        event: "page",
        pageNumber: index + 1,
        messages,
        nextPageToken: "",
        hasMore: index < item.pageFiles.length - 1,
        attachmentCount,
        attachmentFailedCount: sourceFailures,
      };
      const prepared = await options.persistence.preparePage(item.job, event, item.taskRoot);
      const newUploadFailures = Math.max(0, prepared.attachmentFailedCount - sourceFailures);
      jobUploadFailures += newUploadFailures;
      await options.persistence.savePage({
        ...item.job,
        status: jobUploadFailures > 0 && item.job.status === "completed" ? "partial" : item.job.status,
        attachmentFailedCount: item.job.attachmentFailedCount + jobUploadFailures,
      }, prepared);
      result.appliedPages += 1;
      result.appliedMessages += messages.length;
      result.uploadFailures += newUploadFailures;
    }
  }
  return result;
}
