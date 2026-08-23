"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";

import {
  FeishuTimeline,
  type FeishuTimelineAttachment as Attachment,
  type FeishuTimelineMessage as Message,
} from "../../components/FeishuTimeline";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
const CLI_APP_ID_STORAGE_KEY = "dlr.feishu.cli.app-id.v1";

type CollectorMode = "robot" | "cli";
type ChatMode = "group" | "topic" | "p2p" | "unknown";

interface Chat {
  chatId: string;
  name: string;
  description?: string;
  chatMode: ChatMode;
  chatStatus: "normal" | "dissolved" | "dissolved_save" | "unknown";
  external?: boolean;
  p2pTargetId?: string;
}

interface CredentialSession {
  sessionId: string;
  collectorType: CollectorMode;
  callerIdentity: "bot" | "user";
  userName: string;
  expiresAt: string;
  chats: Chat[];
}

interface CliAuthStatus {
  identity: "user" | "bot" | "none";
  available: boolean;
  userName: string;
  tokenStatus: string;
  verified: boolean;
}

interface CliConnection {
  connectionId: string;
  cliVersion: string;
  expiresAt: string;
  authStatus: CliAuthStatus;
}

interface CliAuthChallenge {
  authSessionId: string;
  verificationUrl: string;
  expiresAt: string;
  qrCodeUrl: string;
}

interface Job {
  id: string;
  collectorType: CollectorMode;
  callerIdentity: "bot" | "user";
  chatId: string;
  chatName: string;
  chatMode: ChatMode;
  status: "queued" | "running" | "completed" | "partial" | "failed";
  pages: number;
  messageCount: number;
  attachmentCount: number;
  attachmentPendingCount: number;
  attachmentProcessedCount: number;
  attachmentFailedCount: number;
  error: string;
  startTime?: string;
  endTimeExclusive?: string;
  createdAt: string;
  updatedAt: string;
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1_000;

function beijingMinute(instant: string, offsetMs = 0): string {
  const milliseconds = new Date(instant).getTime() + BEIJING_OFFSET_MS + offsetMs;
  return new Date(milliseconds).toISOString().slice(0, 16).replace("T", " ");
}

function jobRange(job: Job): string {
  if (!job.startTime || !job.endTimeExclusive) return "旧任务未记录抓取时间范围";
  return `${beijingMinute(job.startTime)} — ${beijingMinute(job.endTimeExclusive, -60_000)}（北京时间，首尾分钟均包含）`;
}

function chatTypeLabel(mode: ChatMode): string {
  if (mode === "p2p") return "单聊";
  if (mode === "topic") return "话题群";
  return "群聊";
}

const statusLabel: Record<Job["status"], string> = {
  queued: "等待启动",
  running: "采集中",
  completed: "采集完成",
  partial: "部分数据异常",
  failed: "采集失败",
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && init.body !== null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
  if (!response.ok) throw new Error(body.message || body.error || `请求失败（${response.status}）`);
  return body as T;
}

function attachmentUrl(jobId: string, relativePath: string): string {
  const parts = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "attachments") return "";
  return `${API_BASE}/api/feishu/jobs/${encodeURIComponent(jobId)}/attachments/${encodeURIComponent(parts[1])}/${encodeURIComponent(parts[2])}`;
}

export default function FeishuCollectorPage() {
  const [mode, setMode] = useState<CollectorMode>("robot");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [cliAppId, setCliAppId] = useState("");
  const [cliAppSecret, setCliAppSecret] = useState("");
  const [cliConnection, setCliConnection] = useState<CliConnection | null>(null);
  const [cliChallenge, setCliChallenge] = useState<CliAuthChallenge | null>(null);
  const [cliAuthStatus, setCliAuthStatus] = useState<CliAuthStatus | null>(null);
  const [cliRestored, setCliRestored] = useState(false);
  const [session, setSession] = useState<CredentialSession | null>(null);
  const [selectedChatId, setSelectedChatId] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [jobId, setJobId] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [refreshingAuth, setRefreshingAuth] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(false);
  const [refreshingChats, setRefreshingChats] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const cursor = useRef(0);
  const loadingMessages = useRef(false);
  const attachmentProgress = useRef("");
  const cliRestoreRequest = useRef(0);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const requestedMode = parameters.get("mode");
    if (requestedMode === "cli" || requestedMode === "robot") setMode(requestedMode);
    const id = parameters.get("job") ?? "";
    if (id) setJobId(id);
    const rememberedAppId = window.localStorage.getItem(CLI_APP_ID_STORAGE_KEY)?.trim() ?? "";
    if (rememberedAppId) {
      setCliAppId(rememberedAppId);
      if (requestedMode === "cli") void restoreCliApp(rememberedAppId, true);
    }
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("mode", mode);
    window.history.replaceState({}, "", url);
  }, [mode]);

  useEffect(() => {
    if (!jobId) return;
    cursor.current = 0;
    attachmentProgress.current = "";
    setMessages([]);
    const url = new URL(window.location.href);
    url.searchParams.set("job", jobId);
    window.history.replaceState({}, "", url);

    let active = true;
    const refresh = async () => {
      if (!active) return;
      try {
        const nextJob = await api<Job>(`/api/feishu/jobs/${jobId}`);
        const nextAttachmentProgress = `${nextJob.attachmentPendingCount ?? 0}:${nextJob.attachmentProcessedCount ?? 0}:${nextJob.attachmentFailedCount}`;
        if (attachmentProgress.current && attachmentProgress.current !== nextAttachmentProgress) {
          cursor.current = 0;
          setMessages([]);
        }
        attachmentProgress.current = nextAttachmentProgress;
        if (active) {
          setJob(nextJob);
          setMode(nextJob.collectorType === "cli" ? "cli" : "robot");
        }
        if (!loadingMessages.current) {
          loadingMessages.current = true;
          try {
            const page = await api<{ items: Message[]; nextCursor: number | null }>(
              `/api/feishu/jobs/${jobId}/messages?cursor=${cursor.current}&limit=100`,
            );
            if (active && page.items.length) {
              cursor.current += page.items.length;
              setMessages((current) => [...current, ...page.items]);
            }
          } finally {
            loadingMessages.current = false;
          }
        }
      } catch (requestError) {
        if (active) setError(requestError instanceof Error ? requestError.message : String(requestError));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [jobId]);

  function changeMode(nextMode: CollectorMode) {
    if (nextMode === mode) return;
    setMode(nextMode);
    setSession(null);
    setSelectedChatId("");
    setError("");
    setAppSecret("");
    setCliAppSecret("");
    setCliConnection(null);
    setCliChallenge(null);
    setCliAuthStatus(null);
    setCliRestored(false);
    setConnecting(false);
    cliRestoreRequest.current += 1;
    if (nextMode === "cli") {
      const rememberedAppId = window.localStorage.getItem(CLI_APP_ID_STORAGE_KEY)?.trim() ?? "";
      if (rememberedAppId) {
        setCliAppId(rememberedAppId);
        void restoreCliApp(rememberedAppId, true);
      }
    }
  }

  async function connectRobot(event: FormEvent) {
    event.preventDefault();
    setConnecting(true);
    setError("");
    setSession(null);
    setSelectedChatId("");
    try {
      const nextSession = await api<CredentialSession>("/api/feishu/sessions", {
        method: "POST",
        body: JSON.stringify({ appId, appSecret }),
      });
      setSession(nextSession);
      setAppSecret("");
      if (nextSession.chats.length === 1) setSelectedChatId(nextSession.chats[0].chatId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setConnecting(false);
    }
  }

  async function connectCli(event: FormEvent) {
    event.preventDefault();
    setConnecting(true);
    setError("");
    setSession(null);
    setSelectedChatId("");
    setCliConnection(null);
    setCliChallenge(null);
    setCliAuthStatus(null);
    setCliRestored(false);
    cliRestoreRequest.current += 1;
    try {
      const connection = await api<CliConnection>("/api/feishu/cli/connections", {
        method: "POST",
        body: JSON.stringify({ appId: cliAppId, appSecret: cliAppSecret }),
      });
      const normalizedAppId = cliAppId.trim();
      window.localStorage.setItem(CLI_APP_ID_STORAGE_KEY, normalizedAppId);
      setCliAppId(normalizedAppId);
      setCliConnection(connection);
      setCliAuthStatus(connection.authStatus);
      setCliAppSecret("");
      if (connection.authStatus.identity === "user" && connection.authStatus.available) {
        await loadCliSession(connection);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setConnecting(false);
    }
  }

  async function loadCliSession(connection: CliConnection): Promise<void> {
    const nextSession = await api<CredentialSession>(
      `/api/feishu/cli/connections/${encodeURIComponent(connection.connectionId)}/chats`,
      { method: "POST" },
    );
    setSession(nextSession);
    if (nextSession.chats.length === 1) setSelectedChatId(nextSession.chats[0].chatId);
  }

  async function requestRestoredCliConnection(
    appIdForRestore = cliAppId,
    expectedRequestId?: number,
  ): Promise<CliConnection> {
    const normalizedAppId = appIdForRestore.trim();
    if (!normalizedAppId) throw new Error("没有可恢复的 App ID，请先接入 CLI 应用");
    const connection = await api<CliConnection>("/api/feishu/cli/connections/restore", {
      method: "POST",
      body: JSON.stringify({ appId: normalizedAppId }),
    });
    if (expectedRequestId !== undefined && expectedRequestId !== cliRestoreRequest.current) return connection;
    window.localStorage.setItem(CLI_APP_ID_STORAGE_KEY, normalizedAppId);
    setCliAppId(normalizedAppId);
    setCliConnection(connection);
    setCliAuthStatus(connection.authStatus);
    setCliChallenge(null);
    setCliRestored(true);
    return connection;
  }

  async function restoreCliApp(appIdForRestore: string, loadChats: boolean): Promise<void> {
    const requestId = ++cliRestoreRequest.current;
    setConnecting(true);
    setError("");
    setSession(null);
    setSelectedChatId("");
    try {
      const connection = await requestRestoredCliConnection(appIdForRestore, requestId);
      if (requestId !== cliRestoreRequest.current) return;
      if (loadChats && connection.authStatus.identity === "user" && connection.authStatus.available) {
        try {
          await loadCliSession(connection);
        } catch (requestError) {
          if (requestId !== cliRestoreRequest.current) return;
          setError(`用户授权已恢复，但读取可访问会话失败：${requestError instanceof Error ? requestError.message : String(requestError)}`);
        }
      }
    } catch (requestError) {
      if (requestId !== cliRestoreRequest.current) return;
      setCliConnection(null);
      setCliAuthStatus(null);
      setCliRestored(false);
      setError(`应用 profile 无法自动恢复：${requestError instanceof Error ? requestError.message : String(requestError)}。请重新输入 App Secret 接入应用。`);
    } finally {
      if (requestId === cliRestoreRequest.current) setConnecting(false);
    }
  }

  async function refreshCliAuth() {
    setRefreshingAuth(true);
    setError("");
    setCliChallenge(null);
    setCliAuthStatus(null);
    setSession(null);
    setSelectedChatId("");
    try {
      const connection = await requestRestoredCliConnection();
      const challenge = await api<CliAuthChallenge>(
        `/api/feishu/cli/connections/${encodeURIComponent(connection.connectionId)}/auth`,
        { method: "POST" },
      );
      setCliChallenge(challenge);
      setCliAuthStatus(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setRefreshingAuth(false);
    }
  }

  async function completeCliAuth() {
    if (!cliChallenge) return;
    setCheckingAuth(true);
    setError("");
    try {
      const status = await api<CliAuthStatus>(
        `/api/feishu/cli/auth/${encodeURIComponent(cliChallenge.authSessionId)}/complete`,
        { method: "POST" },
      );
      setCliAuthStatus(status);
      setCliChallenge(null);
      if (cliConnection && status.identity === "user" && status.available) {
        await loadCliSession(cliConnection);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setCheckingAuth(false);
    }
  }

  async function refreshCliChats() {
    setRefreshingChats(true);
    setError("");
    setSession(null);
    setSelectedChatId("");
    try {
      const connection = await requestRestoredCliConnection();
      if (connection.authStatus.identity !== "user" || !connection.authStatus.available) {
        throw new Error("飞书用户授权已失效，请重新扫码授权");
      }
      await loadCliSession(connection);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setRefreshingChats(false);
    }
  }

  async function startJob() {
    if (!session || !selectedChatId) return;
    if (!startTime || !endTime) {
      setError("请选择完整的开始时间和结束时间");
      return;
    }
    if (startTime > endTime) {
      setError("开始时间不能晚于结束时间");
      return;
    }
    setStarting(true);
    setError("");
    try {
      const nextJob = await api<Job>("/api/feishu/jobs", {
        method: "POST",
        body: JSON.stringify({
          sessionId: session.sessionId,
          chatId: selectedChatId,
          startTime,
          endTime,
        }),
      });
      setJob(nextJob);
      setJobId(nextJob.id);
      setSession(null);
      setSelectedChatId("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setStarting(false);
    }
  }

  async function resumeJob() {
    if (!session || !job || !session.chats.some((chat) => chat.chatId === job.chatId)) return;
    setStarting(true);
    setError("");
    try {
      await api<Job>(`/api/feishu/jobs/${job.id}/resume`, {
        method: "POST",
        body: JSON.stringify({ sessionId: session.sessionId }),
      });
      setSession(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setStarting(false);
    }
  }

  const canResume = Boolean(
    session && job?.status === "failed" && job.startTime && job.endTimeExclusive &&
    session.collectorType === job.collectorType &&
    session.chats.some((chat) => chat.chatId === job.chatId),
  );
  const invalidRange = Boolean(startTime && endTime && startTime > endTime);
  const cliAuthorized = cliAuthStatus?.identity === "user" && cliAuthStatus.available;
  const chatStep = mode === "cli" ? "03" : "02";
  const timelineStep = mode === "cli" ? "04" : "03";

  return (
    <main className="shell">
      <Link className="back-link" href="/">← 返回数据采集后台</Link>
      <header className="hero">
        <div>
          <p className="eyebrow">DLR · INTERNAL COLLECTOR</p>
          <h1>飞书历史采集</h1>
          <p className="lead">
            {mode === "robot"
              ? "机器人读取已加入群聊；适合持续采集公共项目群。"
              : "官方 Lark CLI 以当前授权用户身份读取其可访问的群聊与单聊。"}
          </p>
        </div>
        <div className="privacy-note">
          <span>●</span>
          {mode === "robot"
            ? "App Secret 仅在当前任务期间驻留服务端内存"
            : "Secret 经 stdin 交给 CLI，并由 CLI profile / Windows 凭据存储管理"}
        </div>
      </header>

      <div className="collector-mode-switch" role="tablist" aria-label="飞书采集方式">
        <button type="button" role="tab" aria-selected={mode === "robot"} className={mode === "robot" ? "selected" : ""} onClick={() => changeMode("robot")}>
          <span>机器人采集</span><small>tenant_access_token · 群聊</small>
        </button>
        <button type="button" role="tab" aria-selected={mode === "cli"} className={mode === "cli" ? "selected" : ""} onClick={() => changeMode("cli")}>
          <span>个人 CLI 采集</span><small>user_access_token · 群聊与单聊</small>
        </button>
      </div>

      <section className={`control-grid ${mode === "cli" ? "cli-grid" : ""}`}>
        {mode === "robot" ? (
          <form className="panel credential-panel" onSubmit={connectRobot}>
            <div className="step-title"><span>01</span><div><h2>连接机器人应用</h2><p>凭证不会写入任务文件或浏览器存储</p></div></div>
            <label>App ID<input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="cli_xxxxxxxxx" autoComplete="off" /></label>
            <label>App Secret<input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder="输入后仅用于当前会话" autoComplete="new-password" /></label>
            <button className="primary" disabled={connecting || !appId.trim() || !appSecret}>
              {connecting ? "正在验证…" : "验证并获取群聊"}
            </button>
            {session && <p className="success">验证成功，共找到 {session.chats.length} 个群聊。Secret 已从输入框清空。</p>}
          </form>
        ) : (
          <div className="access-stack">
            <form className="panel credential-panel" onSubmit={connectCli}>
              <div className="step-title"><span>01</span><div><h2>恢复或接入 CLI 应用</h2><p>已配置应用会只凭非敏感 App ID 自动恢复</p></div></div>
              <label>App ID<input value={cliAppId} onChange={(event) => setCliAppId(event.target.value)} placeholder="cli_xxxxxxxxx" autoComplete="off" /></label>
              <label>App Secret<input type="password" value={cliAppSecret} onChange={(event) => setCliAppSecret(event.target.value)} placeholder="通过 stdin 交给官方 CLI" autoComplete="new-password" /></label>
              <button className="secondary" type="button" disabled={connecting || !cliAppId.trim()} onClick={() => void restoreCliApp(cliAppId, true)}>
                {connecting ? "正在恢复…" : "只用 App ID 恢复已有应用"}
              </button>
              <button className="primary" disabled={connecting || !cliAppId.trim() || !cliAppSecret}>
                {connecting ? "正在恢复或接入…" : "重新接入官方 CLI"}
              </button>
              {cliConnection && (
                <p className="success">
                  {cliRestored ? "已从本机安全凭据恢复" : "应用已接入"} · Lark CLI {cliConnection.cliVersion}。App Secret 不会保存在浏览器。
                </p>
              )}
              <p className="credential-footnote">浏览器只记住 App ID；App Secret 与用户 Token 由官方 CLI profile / Windows 安全存储管理，不进入 localStorage、任务或数据库。</p>
            </form>

            <section className={`panel cli-auth-panel ${cliConnection ? "active" : "muted"}`}>
              <div className="step-title"><span>02</span><div><h2>恢复或登录个人飞书</h2><p>有效授权自动恢复；真实失效时才需要二维码</p></div></div>
              {!cliConnection && <div className="empty-state">正在尝试恢复既有 profile；恢复失败后再重新接入应用。</div>}
              {cliConnection && (
                <>
                  {cliAuthorized && <p className="success">已验证用户身份：{cliAuthStatus.userName || "已授权用户"}</p>}
                  {cliAuthStatus && !cliAuthorized && <div className="empty-state">飞书用户授权不可用或已失效，请重新扫码；这与应用 profile 连接失败不是同一个问题。</div>}
                  <button className="secondary" type="button" disabled={refreshingAuth} onClick={refreshCliAuth}>
                    {refreshingAuth ? "正在生成二维码…" : cliChallenge ? "刷新登录二维码" : cliAuthorized ? "重新授权或更换用户" : "生成登录二维码"}
                  </button>
                  {cliChallenge && (
                    <div className="cli-qr-card">
                      <img src={`${API_BASE}${cliChallenge.qrCodeUrl}`} alt="飞书用户 OAuth 登录二维码" />
                      <div>
                        <strong>使用飞书扫码并完成授权</strong>
                        <a href={cliChallenge.verificationUrl} target="_blank" rel="noreferrer">无法扫码？打开授权链接 ↗</a>
                        <small>二维码约 10 分钟有效；过期后请刷新。</small>
                      </div>
                    </div>
                  )}
                  <button className="primary" type="button" disabled={!cliChallenge || checkingAuth} onClick={completeCliAuth}>
                    {checkingAuth ? "正在检查登录…" : "我已扫码，检查登录"}
                  </button>
                </>
              )}
            </section>
          </div>
        )}

        <section className={`panel chat-panel ${mode === "robot" ? session ? "active" : "muted" : cliAuthorized ? "active" : "muted"}`}>
          <div className="step-title"><span>{chatStep}</span><div><h2>{mode === "robot" ? "选择目标群聊" : "刷新并选择会话"}</h2><p>{mode === "robot" ? "机器人必须已经加入目标群" : "同时列出授权用户可访问的群聊和单聊"}</p></div></div>
          {mode === "cli" && cliAuthorized && (
            <button className="secondary compact-action" type="button" disabled={refreshingChats} onClick={refreshCliChats}>
              {refreshingChats ? "正在刷新会话…" : session ? "重新刷新可抓取会话" : "刷新可抓取会话"}
            </button>
          )}
          {mode === "robot" && !session && <div className="empty-state">验证机器人凭证后，这里会展示可采集的群聊。</div>}
          {mode === "cli" && !cliAuthorized && <div className="empty-state">等待恢复有效用户授权，或完成扫码后再读取群聊和单聊。</div>}
          {mode === "cli" && cliAuthorized && !session && <div className="empty-state">正在恢复或等待刷新当前用户的可访问会话。</div>}
          {session && !session.chats.length && <div className="empty-state">当前身份没有返回可抓取会话，请检查权限和可见范围。</div>}
          {session && session.chats.length > 0 && (
            <>
              <div className="chat-list">
                {session.chats.map((chat) => (
                  <label className={`chat-option ${selectedChatId === chat.chatId ? "selected" : ""}`} key={chat.chatId}>
                    <input type="radio" name="chat" value={chat.chatId} checked={selectedChatId === chat.chatId} onChange={() => setSelectedChatId(chat.chatId)} />
                    <span className="chat-avatar">{chat.name.slice(0, 1).toUpperCase()}</span>
                    <span><strong>{chat.name}</strong><small>{chat.chatId}</small></span>
                    <em className={`chat-type chat-type-${chat.chatMode}`}>{chatTypeLabel(chat.chatMode)}</em>
                  </label>
                ))}
              </div>
              <div className="collection-range">
                <div className="range-heading"><strong>抓取时间范围</strong><span>北京时间 · 按飞书消息发送时间</span></div>
                <div className="range-inputs">
                  <label>开始时间<input type="datetime-local" step="60" value={startTime} onChange={(event) => setStartTime(event.target.value)} /></label>
                  <label>结束时间<input type="datetime-local" step="60" value={endTime} onChange={(event) => setEndTime(event.target.value)} /></label>
                </div>
                <p className={invalidRange ? "range-error" : "range-help"}>
                  {invalidRange ? "开始时间不能晚于结束时间" : "首尾分钟均包含，例如 10:00–12:00 会抓取到 12:00:59。"}
                </p>
              </div>
            </>
          )}
          <button className="primary" type="button" disabled={!session || !selectedChatId || !startTime || !endTime || invalidRange || starting} onClick={startJob}>
            {starting ? "正在启动…" : "开始采集历史记录"}
          </button>
          {canResume && <button className="secondary" type="button" disabled={starting} onClick={resumeJob}>使用当前身份继续失败任务</button>}
        </section>
      </section>

      {error && <div className="error-banner"><strong>操作未完成</strong><span>{error}</span></div>}

      <section className="timeline-section">
        <div className="timeline-heading">
          <div className="step-title"><span>{timelineStep}</span><div><h2>{job ? job.chatName : mode === "cli" ? "CLI 会话时间线" : "群聊时间线"}</h2><p>{job ? `任务 ${job.id}` : "任务启动后逐页展示消息"}</p></div></div>
          {job && <div className="job-status-cluster"><span className="collector-pill">{job.collectorType === "cli" ? "CLI · 用户" : "机器人"}</span><span className={`status status-${job.status}`}><i />{statusLabel[job.status]}</span></div>}
        </div>

        {job && (
          <>
            <div className="job-range"><span>抓取范围</span><strong>{jobRange(job)}</strong></div>
            <div className="metrics">
              <div><span>已完成页</span><strong>{job.pages}</strong></div>
              <div><span>已采集消息</span><strong>{job.messageCount}</strong></div>
              <div><span>附件引用</span><strong>{job.attachmentCount}</strong></div>
              <div><span>附件待处理</span><strong>{job.attachmentPendingCount ?? 0}</strong></div>
              <div><span>附件已处理</span><strong>{job.attachmentProcessedCount ?? 0}</strong></div>
              <div><span>附件异常</span><strong>{job.attachmentFailedCount}</strong></div>
            </div>
          </>
        )}

        {job?.error && <div className="job-warning">{job.error}</div>}
        {!job && <div className="timeline-empty"><div className="empty-icon">↳</div><h3>尚未开始采集</h3><p>完成上方流程后，消息会按创建时间从早到晚出现在这里。</p></div>}
        {job && messages.length === 0 && ["queued", "running"].includes(job.status) && <div className="timeline-empty"><div className="loader" /><h3>等待时间段内的消息</h3><p>采集任务正在按飞书消息发送时间读取历史记录。</p></div>}
        {job && messages.length === 0 && !["queued", "running"].includes(job.status) && <div className="timeline-empty"><div className="empty-icon">↳</div><h3>该时间段没有消息</h3><p>任务已完成，所选北京时间范围内没有匹配的飞书消息。</p></div>}

        {messages.length > 0 && (
          <FeishuTimeline
            messages={messages}
            attachmentUrl={(_message, attachment) => attachmentUrl(jobId, attachment.relativePath)}
          />
        )}
      </section>
    </main>
  );
}
