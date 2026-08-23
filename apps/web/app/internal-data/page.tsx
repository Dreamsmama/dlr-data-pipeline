"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";

import {
  FeishuTimeline,
  type FeishuTimelineAttachment,
  type FeishuTimelineMessage,
} from "../components/FeishuTimeline";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
const PAGE_SIZE = 20;
type ChatCategory = "group" | "p2p";

interface ChatSummary {
  chatId: string;
  name: string;
  description: string;
  chatMode: "group" | "topic" | "p2p" | "unknown";
  chatStatus: "normal" | "dissolved" | "dissolved_save" | "unknown";
  external?: boolean;
  ownerId: string;
  p2pTargetType: string;
  p2pTargetId: string;
  messageCount: number;
  firstMessageAt: string;
  lastMessageAt: string;
  lastCollectedAt: string;
}

interface HistoryPage {
  items: FeishuTimelineMessage[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  snapshotAt: string;
}

interface HourRange {
  from: string;
  to: string;
}

async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { cache: "no-store", signal });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body as T;
}

function normalizeHour(value: string): string {
  return value ? `${value.slice(0, 13)}:00` : "";
}

function beijingHourStart(value: string): string {
  return new Date(`${normalizeHour(value)}:00+08:00`).toISOString();
}

function beijingHourEndExclusive(value: string): string {
  return new Date(new Date(`${normalizeHour(value)}:00+08:00`).getTime() + 60 * 60 * 1000).toISOString();
}

function formatBeijing(value: string): string {
  if (!value) return "暂无消息";
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}

function attachmentUrl(_message: FeishuTimelineMessage, attachment: FeishuTimelineAttachment): string {
  const url = attachment.url ?? "";
  if (!url) return "";
  return url.startsWith("/") ? `${API_BASE}${url}` : url;
}

export default function InternalDataPage() {
  const [category, setCategory] = useState<ChatCategory>("group");
  const [groupChats, setGroupChats] = useState<ChatSummary[]>([]);
  const [directChats, setDirectChats] = useState<ChatSummary[]>([]);
  const [selectedChatId, setSelectedChatId] = useState("");
  const [draftRange, setDraftRange] = useState<HourRange>({ from: "", to: "" });
  const [range, setRange] = useState<HourRange>({ from: "", to: "" });
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [snapshot, setSnapshot] = useState("");
  const [data, setData] = useState<HistoryPage | null>(null);
  const [loadingChats, setLoadingChats] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState("");
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialRange = {
      from: normalizeHour(params.get("from") ?? ""),
      to: normalizeHour(params.get("to") ?? ""),
    };
    setCategory(params.get("category") === "p2p" ? "p2p" : "group");
    setSelectedChatId(params.get("chat") ?? "");
    setDraftRange(initialRange);
    setRange(initialRange);
    setOrder(params.get("order") === "desc" ? "desc" : "asc");
    setPage(Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1));
    setSnapshot(params.get("snapshot") ?? "");
    setInitialized(true);
  }, []);

  useEffect(() => {
    if (!initialized) return;
    const controller = new AbortController();
    setLoadingChats(true);
    setError("");
    void Promise.all([
      api<{ items: ChatSummary[] }>("/api/internal/feishu/chats?category=group", controller.signal),
      api<{ items: ChatSummary[] }>("/api/internal/feishu/chats?category=p2p", controller.signal),
    ])
      .then(([groups, direct]) => {
        setGroupChats(groups.items);
        setDirectChats(direct.items);
        const activeChats = category === "p2p" ? direct.items : groups.items;
        setSelectedChatId((current) => (
          activeChats.some((chat) => chat.chatId === current) ? current : (activeChats[0]?.chatId ?? "")
        ));
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : String(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingChats(false);
      });
    return () => controller.abort();
  }, [initialized, category]);

  useEffect(() => {
    if (!initialized || !selectedChatId) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
      order,
    });
    if (range.from) params.set("from", beijingHourStart(range.from));
    if (range.to) params.set("to", beijingHourEndExclusive(range.to));
    if (snapshot) params.set("snapshot", snapshot);

    setData(null);
    setLoadingMessages(true);
    setError("");
    void api<HistoryPage>(
      `/api/internal/feishu/chats/${encodeURIComponent(selectedChatId)}/messages?${params}`,
      controller.signal,
    )
      .then((result) => {
        setData(result);
        setSnapshot(result.snapshotAt);
        if (result.page !== page) setPage(result.page);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : String(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMessages(false);
      });
    return () => controller.abort();
  }, [initialized, category, selectedChatId, range, order, page, snapshot]);

  useEffect(() => {
    if (!initialized) return;
    const params = new URLSearchParams();
    params.set("category", category);
    if (selectedChatId) params.set("chat", selectedChatId);
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    if (order === "desc") params.set("order", order);
    if (page > 1) params.set("page", String(page));
    if (snapshot) params.set("snapshot", snapshot);
    const next = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
    window.history.replaceState({}, "", next);
  }, [initialized, category, selectedChatId, range, order, page, snapshot]);

  const chats = category === "p2p" ? directChats : groupChats;
  const categoryCopy = category === "p2p"
    ? { module: "飞书单聊", list: "单聊列表", empty: "还没有已入库的飞书单聊", select: "请选择单聊", history: "单聊历史", fallback: "聊" }
    : { module: "飞书群组", list: "群组列表", empty: "还没有已入库的飞书群组", select: "请选择群组", history: "群组历史", fallback: "群" };

  const selectedChat = useMemo(
    () => chats.find((chat) => chat.chatId === selectedChatId) ?? null,
    [chats, selectedChatId],
  );

  function selectCategory(nextCategory: ChatCategory) {
    if (nextCategory === category) return;
    const nextChats = nextCategory === "p2p" ? directChats : groupChats;
    setCategory(nextCategory);
    setSelectedChatId(nextChats[0]?.chatId ?? "");
    setPage(1);
    setSnapshot("");
    setData(null);
    setError("");
  }

  function selectChat(chatId: string) {
    if (chatId === selectedChatId) return;
    setSelectedChatId(chatId);
    setPage(1);
    setSnapshot("");
  }

  function applyRange(event: FormEvent) {
    event.preventDefault();
    if (draftRange.from && draftRange.to && draftRange.from > draftRange.to) {
      setError("开始小时不能晚于结束小时");
      return;
    }
    setError("");
    setRange(draftRange);
    setPage(1);
    setSnapshot("");
  }

  function clearRange() {
    const empty = { from: "", to: "" };
    setDraftRange(empty);
    setRange(empty);
    setPage(1);
    setSnapshot("");
    setError("");
  }

  function toggleOrder() {
    setOrder((current) => current === "asc" ? "desc" : "asc");
  }

  const totalPages = data?.totalPages ?? 0;

  return (
    <main className="shell internal-shell">
      <Link className="back-link" href="/">← 返回数据采集后台</Link>
      <header className="hero internal-hero">
        <div>
          <p className="eyebrow">DLR · INTERNAL DATA</p>
          <h1>内部数据</h1>
          <p className="lead">按飞书群组和单聊整理已采集数据，用消息发送时间定位历史上下文。</p>
        </div>
        <Link className="collector-link" href="/collectors/feishu">继续采集飞书数据 →</Link>
      </header>

      <div className="internal-layout">
        <aside className="internal-sidebar" aria-label="内部数据分类">
          <section>
            <p className="sidebar-label">数据分类</p>
            <div className="source-list">
              <button
                className={`source-category ${category === "group" ? "selected" : ""}`}
                type="button"
                onClick={() => selectCategory("group")}
              >
                <span>群</span><strong>飞书群组</strong><small>{groupChats.length} 个群组</small>
              </button>
              <button
                className={`source-category ${category === "p2p" ? "selected" : ""}`}
                type="button"
                onClick={() => selectCategory("p2p")}
              >
                <span>聊</span><strong>飞书单聊</strong><small>{directChats.length} 个单聊</small>
              </button>
            </div>
          </section>
          <section className="group-section">
            <p className="sidebar-label">{categoryCopy.list}</p>
            {loadingChats && <div className="sidebar-state">正在读取{category === "p2p" ? "单聊" : "群组"}…</div>}
            {!loadingChats && chats.length === 0 && <div className="sidebar-state">{categoryCopy.empty}</div>}
            <div className="group-list">
              {chats.map((chat) => (
                <button
                  className={`group-option ${chat.chatId === selectedChatId ? "selected" : ""}`}
                  type="button"
                  key={chat.chatId}
                  onClick={() => selectChat(chat.chatId)}
                >
                  <span className="chat-avatar">{chat.name.trim().slice(0, 1) || categoryCopy.fallback}</span>
                  <span><strong>{chat.name}</strong><small>{chat.messageCount} 条 · {formatBeijing(chat.lastMessageAt)}</small></span>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <section className="internal-content">
          <div className="internal-content-heading">
            <div>
              <p className="sidebar-label">内部数据 / {categoryCopy.module}</p>
              <h2>{selectedChat?.name ?? categoryCopy.select}</h2>
              {selectedChat && <p>{selectedChat.description || selectedChat.chatId}</p>}
            </div>
            {selectedChat && <div className="group-stat"><strong>{data?.total ?? selectedChat.messageCount}</strong><span>当前范围消息</span></div>}
          </div>

          <form className="history-toolbar" onSubmit={applyRange}>
            <label>
              <span>开始小时（北京时间）</span>
              <input
                type="datetime-local"
                step="3600"
                value={draftRange.from}
                onChange={(event) => setDraftRange((current) => ({ ...current, from: normalizeHour(event.target.value) }))}
              />
            </label>
            <label>
              <span>结束小时（北京时间）</span>
              <input
                type="datetime-local"
                step="3600"
                value={draftRange.to}
                onChange={(event) => setDraftRange((current) => ({ ...current, to: normalizeHour(event.target.value) }))}
              />
            </label>
            <div className="toolbar-actions">
              <button className="toolbar-primary" type="submit" disabled={!selectedChatId || loadingMessages}>应用日期</button>
              <button className="toolbar-secondary" type="button" onClick={clearRange} disabled={!range.from && !range.to}>清空日期</button>
            </div>
          </form>

          <div className="history-summary">
            <span>{range.from || range.to ? "已按消息发送时间筛选" : "未选择日期，展示全部历史数据"}</span>
            <button className="sort-toggle" type="button" onClick={toggleOrder} disabled={!selectedChatId || loadingMessages}>
              {order === "asc" ? "↑ 旧内容在上" : "↓ 新内容在上"}
            </button>
          </div>

          {error && <div className="error-banner"><strong>数据未加载</strong><span>{error}</span></div>}
          {!selectedChatId && !loadingChats && <div className="timeline-empty"><div className="empty-icon">↳</div><h3>暂无可选{category === "p2p" ? "单聊" : "群组"}</h3><p>{category === "p2p" ? "完成个人账号 CLI 单聊采集后，记录会显示在这里。" : "先完成一次启用 PostgreSQL 的飞书群组采集或历史回填。"}</p></div>}
          {loadingMessages && <div className="timeline-empty"><div className="loader" /><h3>正在读取{categoryCopy.history}</h3><p>正在应用时间范围和分页快照。</p></div>}
          {!loadingMessages && data && data.items.length === 0 && <div className="timeline-empty"><div className="empty-icon">⌕</div><h3>当前范围没有消息</h3><p>可以清空日期或选择更大的小时范围。</p></div>}
          {!loadingMessages && data && data.items.length > 0 && (
            <FeishuTimeline messages={data.items} attachmentUrl={attachmentUrl} />
          )}

          {data && data.total > 0 && (
            <nav className="pagination" aria-label={`${categoryCopy.module}消息分页`}>
              <span>共 {data.total} 条 · 每页 {data.pageSize} 条</span>
              <div>
                <button type="button" onClick={() => setPage(1)} disabled={page <= 1 || loadingMessages}>首页</button>
                <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || loadingMessages}>上一页</button>
                <strong>第 {data.page} / {Math.max(1, totalPages)} 页</strong>
                <button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page >= totalPages || loadingMessages}>下一页</button>
                <button type="button" onClick={() => setPage(totalPages)} disabled={page >= totalPages || loadingMessages}>末页</button>
              </div>
            </nav>
          )}
        </section>
      </div>
    </main>
  );
}
