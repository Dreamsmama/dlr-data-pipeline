import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { appNamespace, profileForApp } from "./identity.js";
import type {
  BridgeCallbacks,
  CliAuthChallenge,
  CliAuthStatus,
  CliCollectionAccess,
  CliConnection,
  CliCrawlRequest,
  CliAttachmentDownloadRequest,
  FeishuChat,
  FeishuChatMode,
  FeishuChatStatus,
  TimelineAttachment,
  TimelineMessage,
  UserCliFeishuBridge,
} from "./types.js";

const USER_SCOPES = [
  "im:chat:read",
  "im:message:readonly",
  "im:message.group_msg:get_as_user",
  "im:message.p2p_msg:get_as_user",
  "im:message.reactions:read",
].join(" ");

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PAGES = 1000;
const DEFAULT_CONNECTION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ATTACHMENT_TIMEOUT_MS = 30 * 60 * 1000;

interface CommandOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LarkCliCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LarkCliExecutor {
  run(args: string[], options?: CommandOptions): Promise<LarkCliCommandResult>;
}

interface InternalConnection {
  id: string;
  profile: string;
  appNamespace: string;
  cliVersion: string;
  expiresAt: number;
}

interface InternalAuthChallenge {
  id: string;
  connectionId: string;
  deviceCode: string;
  verificationUrl: string;
  qrPath: string;
  expiresAt: number;
}

interface JsonEnvelope {
  ok?: boolean;
  identity?: string;
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

function safeError(error: unknown): string {
  const sanitized = (error instanceof Error ? error.message : String(error))
    .replace(/(?:access|refresh|tenant|user)[-_ ]?token\s*[=:]\s*[^\s,}&}]+/gi, "token=[REDACTED]")
    .replace(/app[-_ ]?secret\s*[=:]\s*[^\s,}&}]+/gi, "app_secret=[REDACTED]")
    .replace(/device[-_ ]?code\s*[=:]\s*[^\s,}&}]+/gi, "device_code=[REDACTED]");
  if (/"subtype"\s*:\s*"not_configured"|profile\s+.+not found/i.test(sanitized)) {
    return "Lark CLI 中不存在该 App ID 对应的 profile，请重新输入 App Secret 接入应用";
  }
  if (
    /keychain unavailable|keychain (?:set|get) failed/i.test(sanitized)
    && /registry|access is denied|permission/i.test(sanitized)
  ) {
    return "Lark CLI 无法访问 Windows 凭据存储。请使用当前登录的 Windows 用户启动 API 服务，并确认该进程可以读写 HKCU\\Software\\LarkCli\\keychain。不能自动改用明文文件：App Secret 可以使用 file 引用，但用户 OAuth Token 仍然依赖 Windows 密钥链。";
  }
  return sanitized.slice(0, 4_000);
}

function parseJson(text: string, label: string): JsonEnvelope {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) throw new Error(`${label}没有返回 JSON`);
  try {
    return JSON.parse(trimmed) as JsonEnvelope;
  } catch {
    throw new Error(`${label}返回了无法解析的 JSON`);
  }
}

function normalizeAppId(appId: string): string {
  const normalizedAppId = appId.trim();
  if (!/^cli_[A-Za-z0-9]+$/.test(normalizedAppId)) throw new Error("App ID 格式不合法");
  return normalizedAppId;
}

function pendingAttachments(raw: Record<string, unknown>): TimelineAttachment[] {
  if (asString(raw.msg_type ?? raw.msgType) === "sticker") return [];
  const content = typeof raw.content === "string"
    ? raw.content
    : raw.content === undefined ? "" : JSON.stringify(raw.content);
  const keys = content.match(/(?:img|file|audio|video|media)_[A-Za-z0-9_-]+/g) ?? [];
  return [...new Set(keys)].map((fileKey) => ({
    type: fileKey.startsWith("img_") ? "image" as const : "file" as const,
    fileKey,
    name: fileKey,
    status: "pending" as const,
    relativePath: "",
    size: 0,
    error: "附件后台处理中",
    storageStatus: "pending" as const,
  }));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function asBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

function deepString(value: unknown, keys: string[]): string {
  if (!value || typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = object[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  for (const candidate of Object.values(object)) {
    const nested = deepString(candidate, keys);
    if (nested) return nested;
  }
  return "";
}

function normalizedTime(value: unknown): string {
  const text = asString(value).trim();
  if (!text) return "";
  if (/^\d{13}$/.test(text)) return new Date(Number(text)).toISOString();
  if (/^\d{10}$/.test(text)) return new Date(Number(text) * 1000).toISOString();
  const instant = new Date(text);
  return Number.isNaN(instant.getTime()) ? text : instant.toISOString();
}

function safeFileName(value: string, fallback: string): string {
  const sanitized = path.basename(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  return sanitized || fallback;
}

function chatMode(value: unknown): FeishuChatMode {
  return ["group", "topic", "p2p"].includes(asString(value))
    ? asString(value) as FeishuChatMode
    : "unknown";
}

function chatStatus(value: unknown): FeishuChatStatus {
  return ["normal", "dissolved", "dissolved_save"].includes(asString(value))
    ? asString(value) as FeishuChatStatus
    : "unknown";
}

function authStatus(envelope: JsonEnvelope): CliAuthStatus {
  const identities = record(envelope.identities);
  const user = record(identities.user);
  const identity = ["user", "bot"].includes(asString(envelope.identity))
    ? asString(envelope.identity) as "user" | "bot"
    : "none";
  return {
    identity,
    available: asBoolean(user.available) || asString(user.status) === "valid",
    userName: asString(user.userName),
    tokenStatus: asString(user.tokenStatus || user.status),
    verified: asBoolean(envelope.verified) || asBoolean(user.verified),
  };
}

function requireSuccess(envelope: JsonEnvelope, label: string, identity?: "user"): Record<string, unknown> {
  if (envelope.ok !== true) throw new Error(`${label}未返回 ok=true`);
  if (identity && envelope.identity !== identity) throw new Error(`${label}返回的身份不是 user`);
  return record(envelope.data);
}

async function findCliEntry(): Promise<string> {
  const configured = process.env.LARK_CLI_ENTRY?.trim();
  if (configured) {
    const info = await stat(configured);
    if (!info.isFile()) throw new Error("LARK_CLI_ENTRY 不是文件");
    return configured;
  }
  if (process.platform !== "win32") return "lark-cli";
  const result = await runExecutable("where.exe", ["lark-cli.cmd"], {});
  if (result.exitCode !== 0) throw new Error("本机未找到 lark-cli.cmd，请先安装 @larksuite/cli");
  for (const line of result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const entry = path.join(path.dirname(line), "node_modules", "@larksuite", "cli", "scripts", "run.js");
    try {
      if ((await stat(entry)).isFile()) return entry;
    } catch {
      // 继续检查 PATH 中的下一个 shim。
    }
  }
  throw new Error("找到了 lark-cli.cmd，但未找到官方 CLI Node 入口");
}

async function runExecutable(
  executable: string,
  args: string[],
  options: CommandOptions,
): Promise<LarkCliCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        NO_COLOR: "1",
      },
      signal: options.signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 120_000);
    timer.unref();
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error("Lark CLI 执行超时"));
      if (outputBytes > MAX_OUTPUT_BYTES) return reject(new Error("Lark CLI 输出超过 64 MB 安全上限"));
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(options.input ?? "");
  });
}

export class SpawnLarkCliExecutor implements LarkCliExecutor {
  #entryPromise: Promise<string> | undefined;

  async run(args: string[], options: CommandOptions = {}): Promise<LarkCliCommandResult> {
    this.#entryPromise ??= findCliEntry();
    const entry = await this.#entryPromise;
    const result = process.platform === "win32" && entry.endsWith(".js")
      ? await runExecutable(process.execPath, [entry, ...args], options)
      : await runExecutable(entry, args, options);
    if (result.exitCode !== 0) {
      throw new Error(safeError(result.stderr || result.stdout || `Lark CLI 异常退出（${result.exitCode}）`));
    }
    return result;
  }
}

export class LarkCliFeishuBridge implements UserCliFeishuBridge {
  readonly #connections = new Map<string, InternalConnection>();
  readonly #authChallenges = new Map<string, InternalAuthChallenge>();

  constructor(
    private readonly options: {
      dataRoot: string;
      executor?: LarkCliExecutor;
      connectionTtlMs?: number;
      authTtlMs?: number;
      attachmentTimeoutMs?: number;
      now?: () => number;
    },
  ) {}

  private get executor(): LarkCliExecutor {
    return this.options.executor ??= new SpawnLarkCliExecutor();
  }

  private get connectionTtlMs(): number {
    return this.options.connectionTtlMs ?? DEFAULT_CONNECTION_TTL_MS;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async configureApp(appId: string, appSecret: string): Promise<CliConnection> {
    const normalizedAppId = normalizeAppId(appId);
    if (!appSecret) throw new Error("App Secret 不能为空");
    const profile = profileForApp(normalizedAppId);
    let version = "";
    try {
      const versionResult = await this.executor.run(["--version"], { timeoutMs: 15_000 });
      version = /(?:version\s+)?([0-9]+(?:\.[0-9]+){2})/i.exec(versionResult.stdout)?.[1] ?? versionResult.stdout.trim();
      await this.executor.run([
        "config", "init",
        "--app-id", normalizedAppId,
        "--app-secret-stdin",
        "--brand", "feishu",
        "--lang", "zh_cn",
        "--name", profile,
      ], { input: `${appSecret}\n`, timeoutMs: 30_000 });
    } catch (error) {
      throw new Error(safeError(error).replaceAll(appSecret, "[REDACTED]"));
    }
    const status = await this.readAuthStatus(profile, false).catch(() => ({
      identity: "none" as const,
      available: false,
      userName: "",
      tokenStatus: "missing",
      verified: false,
    }));
    return this.issueConnection(normalizedAppId, profile, version, status);
  }

  async restoreApp(appId: string): Promise<CliConnection> {
    const normalizedAppId = normalizeAppId(appId);
    const profile = profileForApp(normalizedAppId);
    try {
      const versionResult = await this.executor.run(["--version"], { timeoutMs: 15_000 });
      const version = /(?:version\s+)?([0-9]+(?:\.[0-9]+){2})/i.exec(versionResult.stdout)?.[1]
        ?? versionResult.stdout.trim();
      let status: CliAuthStatus;
      try {
        status = await this.readAuthStatus(profile, true);
      } catch (verifyError) {
        try {
          status = await this.readAuthStatus(profile, false);
        } catch {
          throw verifyError;
        }
      }
      return this.issueConnection(normalizedAppId, profile, version, status);
    } catch (error) {
      throw new Error(`无法恢复 CLI 应用连接：${safeError(error)}`);
    }
  }

  private issueConnection(
    normalizedAppId: string,
    profile: string,
    cliVersion: string,
    authStatus: CliAuthStatus,
  ): CliConnection {
    const connection: InternalConnection = {
      id: randomUUID(),
      profile,
      appNamespace: appNamespace(normalizedAppId),
      cliVersion,
      expiresAt: this.now() + this.connectionTtlMs,
    };
    this.#connections.set(connection.id, connection);
    return {
      connectionId: connection.id,
      cliVersion: connection.cliVersion,
      expiresAt: new Date(connection.expiresAt).toISOString(),
      authStatus,
    };
  }

  async beginAuth(connectionId: string): Promise<CliAuthChallenge> {
    const connection = this.connection(connectionId);
    const result = await this.executor.run([
      "--profile", connection.profile,
      "auth", "login",
      "--scope", USER_SCOPES,
      "--no-wait",
      "--json",
    ], { timeoutMs: 30_000 });
    const envelope = parseJson(result.stdout, "Lark CLI 登录");
    if (envelope.ok === false) throw new Error("Lark CLI 未能创建授权会话");
    const deviceCode = deepString(envelope, ["device_code", "deviceCode"]);
    const verificationUrl = deepString(envelope, [
      "verification_url",
      "verification_uri_complete",
      "verificationUrl",
    ]);
    if (!deviceCode || !verificationUrl) throw new Error("Lark CLI 登录响应缺少授权链接或设备码");
    const id = randomUUID();
    const root = path.join(this.options.dataRoot, "cli-auth", id);
    await mkdir(root, { recursive: true });
    const qrPath = path.join(root, "qrcode.png");
    await this.executor.run(["auth", "qrcode", verificationUrl, "--output", "qrcode.png"], {
      cwd: root,
      timeoutMs: 15_000,
    });
    const expiresSeconds = Number(deepString(envelope, ["expires_in", "expiresIn"])) || 600;
    const challenge: InternalAuthChallenge = {
      id,
      connectionId: connection.id,
      deviceCode,
      verificationUrl,
      qrPath,
      expiresAt: Date.now() + Math.min(600, Math.max(60, expiresSeconds)) * 1000,
    };
    this.#authChallenges.set(challenge.id, challenge);
    return {
      authSessionId: challenge.id,
      verificationUrl: challenge.verificationUrl,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
    };
  }

  async resolveQrCode(authSessionId: string): Promise<string> {
    const challenge = this.authChallenge(authSessionId);
    const info = await stat(challenge.qrPath);
    if (!info.isFile()) throw new Error("登录二维码不存在，请重新刷新");
    return challenge.qrPath;
  }

  async completeAuth(authSessionId: string): Promise<CliAuthStatus> {
    const challenge = this.authChallenge(authSessionId);
    const connection = this.connection(challenge.connectionId);
    await this.executor.run([
      "--profile", connection.profile,
      "auth", "login",
      "--device-code", challenge.deviceCode,
      "--json",
    ], { timeoutMs: 30_000 });
    const status = await this.readAuthStatus(connection.profile, true);
    if (status.identity !== "user" || !status.available) {
      throw new Error("CLI 当前不是可用的用户身份，请重新刷新二维码授权");
    }
    challenge.deviceCode = "";
    return status;
  }

  async discoverChats(connectionId: string): Promise<CliCollectionAccess> {
    const connection = this.connection(connectionId);
    const status = await this.readAuthStatus(connection.profile, true);
    if (status.identity !== "user" || !status.available) {
      throw new Error("CLI 用户登录已失效，请重新扫码授权");
    }
    const result = await this.executor.run([
      "--profile", connection.profile,
      "im", "+chat-list",
      "--as", "user",
      "--types=p2p,group",
      "--sort", "active_time",
      "--page-all",
      "--page-limit", String(MAX_PAGES),
      "--format", "json",
    ]);
    const envelope = parseJson(result.stdout, "Lark CLI 会话列表");
    const data = requireSuccess(envelope, "Lark CLI 会话列表", "user");
    const pagination = record(record(envelope.meta).pagination);
    if (asBoolean(data.has_more) || pagination.complete === false) {
      throw new Error("CLI 会话列表达到分页上限，结果不完整");
    }
    const source = Array.isArray(data.chats) ? data.chats : [];
    const chats = source.map((item): FeishuChat => {
      const raw = record(item);
      const mode = chatMode(raw.chat_mode ?? raw.chatMode);
      const targetId = asString(raw.p2p_target_id ?? raw.p2pTargetId);
      if (mode === "p2p" && !targetId) throw new Error("CLI 单聊缺少 p2p_target_id，已停止刷新会话");
      return {
        chatId: asString(raw.chat_id ?? raw.chatId),
        name: asString(raw.name) || "未命名会话",
        description: asString(raw.description),
        chatMode: mode,
        chatStatus: chatStatus(raw.chat_status ?? raw.chatStatus),
        external: raw.external === undefined ? undefined : asBoolean(raw.external),
        ownerId: asString(raw.owner_id ?? raw.ownerId),
        p2pTargetType: asString(raw.p2p_target_type ?? raw.p2pTargetType),
        p2pTargetId: targetId,
      };
    }).filter((chat) => chat.chatId && chat.chatMode !== "unknown");
    return {
      profile: connection.profile,
      appNamespace: connection.appNamespace,
      userName: status.userName,
      chats,
    };
  }

  async crawl(request: CliCrawlRequest, callbacks: BridgeCallbacks): Promise<void> {
    let pageToken = request.pageToken;
    let pageNumber = request.pageNumber;
    let hasMore = true;
    const seen = new Set<string>();
    while (hasMore) {
      if (pageNumber >= MAX_PAGES) throw new Error("CLI 消息抓取达到 1000 页上限，任务仍未完整");
      const pageRoot = path.join(request.outputDir, "cli-pages", String(pageNumber + 1).padStart(6, "0"));
      await rm(pageRoot, { recursive: true, force: true });
      await mkdir(pageRoot, { recursive: true });
      const args = [
        "--profile", request.profile,
        "im", "+chat-messages-list",
        "--as", "user",
        "--chat-id", request.chatId,
        "--start", request.startTime,
        "--end", request.endTimeExclusive,
        "--order", "asc",
        "--page-size", "50",
        "--page-limit", "1",
        "--no-reactions",
        "--format", "json",
      ];
      if (pageToken) args.push("--page-token", pageToken);
      const result = await this.executor.run(args, { cwd: pageRoot, timeoutMs: 180_000 });
      const envelope = parseJson(result.stdout, "Lark CLI 消息页");
      const data = requireSuccess(envelope, "Lark CLI 消息页", "user");
      const flattened = this.flattenMessages(Array.isArray(data.messages) ? data.messages : []);
      for (const warning of flattened.warnings) {
        await callbacks.onEvent({ event: "warning", message: warning });
      }
      const messages: TimelineMessage[] = [];
      for (const raw of flattened.messages) {
        const messageId = asString(raw.message_id ?? raw.messageId);
        if (!messageId || seen.has(messageId)) continue;
        seen.add(messageId);
        messages.push(await this.normalizeMessage(raw, request.chatId, request.outputDir, pageRoot));
      }
      hasMore = asBoolean(data.has_more ?? data.hasMore);
      const nextPageToken = asString(data.page_token ?? data.pageToken);
      if (hasMore && !nextPageToken) throw new Error("CLI 消息页声明 has_more=true，但缺少 page_token");
      pageNumber += 1;
      await callbacks.onEvent({
        event: "page",
        pageNumber,
        messages,
        nextPageToken,
        hasMore,
        attachmentCount: messages.reduce((total, item) => total + item.attachments.length, 0),
        attachmentFailedCount: messages.reduce(
          (total, item) => total + item.attachments.filter((attachment) => attachment.status === "failed").length,
          0,
        ),
      });
      pageToken = nextPageToken;
    }
    await callbacks.onEvent({ event: "done" });
  }

  async downloadMessageAttachments(request: CliAttachmentDownloadRequest): Promise<TimelineAttachment[]> {
    const attemptRoot = path.join(
      request.outputDir,
      "attachment-attempts",
      safeFileName(request.messageId, "message"),
      randomUUID(),
    );
    await mkdir(attemptRoot, { recursive: true });
    try {
      const result = await this.executor.run([
        "--profile", request.profile,
        "im", "+messages-mget",
        "--as", "user",
        "--message-ids", request.messageId,
        "--no-reactions",
        "--download-resources",
        "--format", "json",
      ], {
        cwd: attemptRoot,
        timeoutMs: this.options.attachmentTimeoutMs ?? DEFAULT_ATTACHMENT_TIMEOUT_MS,
        signal: request.signal,
      });
      const envelope = parseJson(result.stdout, "Lark CLI 附件消息");
      const data = requireSuccess(envelope, "Lark CLI 附件消息", "user");
      const raw = (Array.isArray(data.messages) ? data.messages : [])
        .map(record)
        .find((message) => asString(message.message_id ?? message.messageId) === request.messageId);
      if (!raw) throw new Error(`Lark CLI 附件消息没有返回 ${request.messageId}`);
      const resources = Array.isArray(raw.resources) ? raw.resources : [];
      const attachments: TimelineAttachment[] = [];
      for (const resource of resources) {
        attachments.push(await this.normalizeAttachment(
          record(resource),
          request.messageId,
          request.outputDir,
          attemptRoot,
        ));
      }
      return attachments;
    } finally {
      await rm(attemptRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readAuthStatus(profile: string, verify: boolean): Promise<CliAuthStatus> {
    const args = ["--profile", profile, "auth", "status", "--json"];
    if (verify) args.push("--verify");
    const result = await this.executor.run(args, { timeoutMs: 30_000 });
    return authStatus(parseJson(result.stdout, "Lark CLI 登录状态"));
  }

  private connection(id: string): InternalConnection {
    const connection = this.#connections.get(id);
    const now = this.now();
    if (!connection || connection.expiresAt <= now) {
      this.#connections.delete(id);
      throw new Error("CLI 临时应用连接已过期，请使用已保存的 App ID 自动恢复连接");
    }
    connection.expiresAt = now + this.connectionTtlMs;
    return connection;
  }

  private authChallenge(id: string): InternalAuthChallenge {
    const challenge = this.#authChallenges.get(id);
    if (!challenge || challenge.expiresAt <= Date.now() || !challenge.deviceCode) {
      this.#authChallenges.delete(id);
      throw new Error("CLI 登录二维码已过期，请重新刷新");
    }
    return challenge;
  }

  private flattenMessages(input: unknown[]): { messages: Record<string, unknown>[]; warnings: string[] } {
    const messages: Record<string, unknown>[] = [];
    const warnings: string[] = [];
    const visit = (value: unknown, inheritedRoot = "") => {
      const raw = record(value);
      if (!Object.keys(raw).length) return;
      if (inheritedRoot && !raw.root_id && !raw.rootId) raw.root_id = inheritedRoot;
      messages.push(raw);
      const messageId = asString(raw.message_id ?? raw.messageId);
      if (asBoolean(raw.thread_has_more ?? raw.threadHasMore)) {
        warnings.push(`话题 ${messageId || "未知"} 的回复达到 CLI 展开上限，任务结果可能不完整`);
      }
      if (asBoolean(raw.thread_replies_error ?? raw.threadRepliesError)) {
        warnings.push(`话题 ${messageId || "未知"} 的回复读取失败，任务结果不完整`);
      }
      const replies = raw.thread_replies ?? raw.threadReplies;
      if (Array.isArray(replies)) replies.forEach((reply) => visit(reply, inheritedRoot || messageId));
    };
    input.forEach((item) => visit(item));
    return { messages, warnings: [...new Set(warnings)] };
  }

  private async normalizeMessage(
    raw: Record<string, unknown>,
    fallbackChatId: string,
    outputDir: string,
    pageRoot: string,
  ): Promise<TimelineMessage> {
    const messageId = asString(raw.message_id ?? raw.messageId);
    const sender = record(raw.sender);
    const resources = Array.isArray(raw.resources) ? raw.resources : [];
    const attachments: TimelineAttachment[] = [];
    for (const value of resources) {
      attachments.push(await this.normalizeAttachment(record(value), messageId, outputDir, pageRoot));
    }
    if (!resources.length) attachments.push(...pendingAttachments(raw));
    const content = raw.content;
    return {
      messageId,
      chatId: asString(raw.chat_id ?? raw.chatId) || fallbackChatId,
      senderId: asString(sender.id),
      senderName: asString(sender.name) || asString(sender.id),
      senderType: asString(sender.sender_type ?? sender.senderType),
      msgType: asString(raw.msg_type ?? raw.msgType),
      createTime: normalizedTime(raw.create_time ?? raw.createTime),
      updateTime: normalizedTime(raw.update_time ?? raw.updateTime),
      text: typeof content === "string" ? content : content === undefined ? "" : JSON.stringify(content),
      rootId: asString(raw.root_id ?? raw.rootId),
      parentId: asString(raw.parent_id ?? raw.parentId),
      deleted: asBoolean(raw.deleted),
      updated: asBoolean(raw.updated),
      attachments,
    };
  }

  private async normalizeAttachment(
    resource: Record<string, unknown>,
    fallbackMessageId: string,
    outputDir: string,
    pageRoot: string,
  ): Promise<TimelineAttachment> {
    const fileKey = asString(resource.key ?? resource.file_key ?? resource.fileKey);
    const type = asString(resource.type) === "image" ? "image" as const : "file" as const;
    const localPath = asString(resource.local_path ?? resource.localPath);
    const reportedSize = Math.max(0, Number(resource.size_bytes ?? resource.sizeBytes) || 0);
    const sourceName = safeFileName(localPath ? path.basename(localPath) : fileKey, fileKey || "attachment");
    if (asBoolean(resource.error) || !localPath) {
      return {
        type,
        fileKey,
        name: sourceName,
        status: "failed",
        relativePath: "",
        size: reportedSize,
        error: asString(resource.error_message ?? resource.errorMessage) || "CLI 附件下载失败",
      };
    }
    try {
      const source = path.resolve(pageRoot, localPath);
      const pageBoundary = `${path.resolve(pageRoot)}${path.sep}`;
      if (!source.startsWith(pageBoundary)) throw new Error("CLI 附件路径超出页目录");
      const info = await stat(source);
      if (!info.isFile()) throw new Error("CLI 附件不是文件");
      if (reportedSize && info.size !== reportedSize) throw new Error("CLI 附件大小与输出元数据不一致");
      const messageId = safeFileName(asString(resource.message_id ?? resource.messageId) || fallbackMessageId, "message");
      const destinationName = safeFileName(`${fileKey}__${sourceName}`, sourceName);
      const destination = path.join(outputDir, "attachments", messageId, destinationName);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      return {
        type,
        fileKey,
        name: sourceName,
        status: "downloaded",
        relativePath: path.relative(outputDir, destination).replaceAll("\\", "/"),
        size: info.size,
        error: "",
      };
    } catch (error) {
      return {
        type,
        fileKey,
        name: sourceName,
        status: "failed",
        relativePath: "",
        size: reportedSize,
        error: safeError(error),
      };
    }
  }
}
