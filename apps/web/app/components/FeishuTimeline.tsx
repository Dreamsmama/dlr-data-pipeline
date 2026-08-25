"use client";

import { useState } from "react";

export interface FeishuTimelineAttachment {
  type: "image" | "file";
  fileKey: string;
  name: string;
  status: "downloaded" | "reused" | "unavailable" | "failed" | string;
  relativePath: string;
  size: number;
  error: string;
  storageStatus?: "not_configured" | "source_failed" | "uploaded" | "upload_failed" | string;
  storageError?: string;
  url?: string;
}

export interface FeishuTimelineMessage {
  messageId: string;
  chatId?: string;
  senderId: string;
  senderName: string;
  senderType: string;
  msgType: string;
  createTime: string;
  updateTime?: string;
  text: string;
  rootId: string;
  parentId: string;
  deleted: boolean;
  updated?: boolean;
  attachments: FeishuTimelineAttachment[];
}

interface FeishuTimelineProps {
  messages: FeishuTimelineMessage[];
  attachmentUrl: (message: FeishuTimelineMessage, attachment: FeishuTimelineAttachment) => string;
}

function formatBytes(value: number): string {
  if (!value) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

const TEXT_PREVIEW_EXTENSIONS = new Set(["txt", "csv", "json", "md", "log"]);
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

type AttachmentPreview = {
  name: string;
  url: string;
  kind: "text" | "pdf";
  loading: boolean;
  content: string;
  error: string;
};

function previewKind(fileName: string): AttachmentPreview["kind"] | null {
  const extension = fileName.split(".").pop()?.toLocaleLowerCase() ?? "";
  if (extension === "pdf") return "pdf";
  return TEXT_PREVIEW_EXTENSIONS.has(extension) ? "text" : null;
}

function downloadUrl(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

function storageLabel(attachment: FeishuTimelineAttachment): string {
  if (attachment.status === "pending" || attachment.storageStatus === "pending") return "后台处理中";
  if (attachment.storageStatus === "uploaded") return "OSS 已上传";
  if (attachment.storageStatus === "upload_failed") return "OSS 上传失败";
  if (attachment.storageStatus === "source_failed") return "来源附件不可用";
  return "";
}

function displayFileName(value: string): string {
  if (!/[\u0080-\u009f]/.test(value)) return value;
  try {
    const bytes = Uint8Array.from([...value].map((character) => {
      const code = character.charCodeAt(0);
      if (code > 255) throw new Error("not latin-1 mojibake");
      return code;
    }));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}

function messageTextForDisplay(message: FeishuTimelineMessage): string {
  const text = message.text.trim().replace(/\s+/g, " ");
  if (!text) return "";
  const identity = text.toLocaleLowerCase();
  const repeatsAttachmentName = message.attachments.some(
    (attachment) => displayFileName(attachment.name).trim().replace(/\s+/g, " ").toLocaleLowerCase() === identity,
  );
  if (repeatsAttachmentName) return "";
  if (message.msgType !== "post" || message.attachments.length === 0) return text;
  const parts = text.split(" ");
  if (parts.length % 2 !== 0) return text;
  const midpoint = parts.length / 2;
  const first = parts.slice(0, midpoint).join(" ");
  const second = parts.slice(midpoint).join(" ");
  return first === second ? first : text;
}

function messageTime(value: string): string {
  if (!value) return "时间未知";
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}

export function FeishuTimeline({ messages, attachmentUrl }: FeishuTimelineProps) {
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);

  async function openPreview(
    attachment: FeishuTimelineAttachment,
    name: string,
    url: string,
    kind: AttachmentPreview["kind"],
  ): Promise<void> {
    if (kind === "pdf") {
      setPreview({ name, url, kind, loading: false, content: "", error: "" });
      return;
    }
    if (attachment.size > MAX_TEXT_PREVIEW_BYTES) {
      setPreview({
        name,
        url,
        kind,
        loading: false,
        content: "",
        error: "文本文件超过 2 MB，请使用下载功能查看。",
      });
      return;
    }
    setPreview({ name, url, kind, loading: true, content: "", error: "" });
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`预览请求失败（${response.status}）`);
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > MAX_TEXT_PREVIEW_BYTES) throw new Error("文本文件超过 2 MB，请使用下载功能查看。");
      const content = await response.text();
      if (new Blob([content]).size > MAX_TEXT_PREVIEW_BYTES) {
        throw new Error("文本文件超过 2 MB，请使用下载功能查看。");
      }
      setPreview({ name, url, kind, loading: false, content, error: "" });
    } catch (error) {
      setPreview({
        name,
        url,
        kind,
        loading: false,
        content: "",
        error: error instanceof Error ? error.message : "附件预览失败",
      });
    }
  }

  return (
    <div className="timeline">
      {messages.map((message) => {
        const displayText = messageTextForDisplay(message)
          || (message.attachments.length === 0 ? `[${message.msgType || "未知消息"}]` : "");
        return (
          <article className="message" key={message.messageId}>
            <div className="message-avatar">{message.senderName.trim().slice(0, 1) || "?"}</div>
            <div className="message-body">
              <header>
                <strong>{message.senderName || "未知发送者"}</strong>
                <time>{messageTime(message.createTime)}</time>
                <span>{message.msgType}</span>
              </header>
              {(message.parentId || message.rootId) && (
                <p className="relation">{message.parentId ? `回复 ${message.parentId}` : `话题 ${message.rootId}`}</p>
              )}
              {displayText && <p className={`message-text ${message.deleted ? "deleted" : ""}`}>{displayText}</p>}
              {message.attachments.length > 0 && (
                <div className="attachments">
                  {message.attachments.map((attachment) => {
                    const url = attachmentUrl(message, attachment);
                    const attachmentName = displayFileName(attachment.name);
                    const available = ["downloaded", "reused"].includes(attachment.status) && url;
                    const storage = storageLabel(attachment);
                    if (attachment.status === "pending" || attachment.storageStatus === "pending") {
                      return (
                        <div className="file-attachment unavailable" key={`${attachment.type}-${attachment.fileKey}`}>
                          <b>…</b><span>{attachmentName}<small>附件已排队，消息内容不受影响</small></span>
                        </div>
                      );
                    }
                    if (available && attachment.type === "image") {
                      return (
                        <a href={url} target="_blank" rel="noreferrer" className="image-attachment" key={`${attachment.type}-${attachment.fileKey}`}>
                          <img src={url} alt={attachmentName} />
                          <span>
                            {attachmentName} · {formatBytes(attachment.size)}
                            {storage && <> · <em className={attachment.storageStatus === "upload_failed" ? "storage-error" : ""}>{storage}</em></>}
                          </span>
                        </a>
                      );
                    }
                    if (available) {
                      const kind = previewKind(attachmentName);
                      const fileUrl = kind ? url : downloadUrl(url);
                      return (
                        <div className="file-attachment-row" key={`${attachment.type}-${attachment.fileKey}`}>
                          {kind ? (
                            <button
                              type="button"
                              className="file-attachment"
                              onClick={() => void openPreview(attachment, attachmentName, fileUrl, kind)}
                            >
                              <b>↗</b>
                              <span>
                                {attachmentName}
                                <small>{formatBytes(attachment.size)}{storage && ` · ${storage}`} · 可预览</small>
                              </span>
                            </button>
                          ) : (
                            <a className="file-attachment" href={fileUrl}>
                              <b>↓</b>
                              <span>{attachmentName}<small>{formatBytes(attachment.size)}{storage && ` · ${storage}`}</small></span>
                            </a>
                          )}
                          {kind && (
                            <a className="file-download" href={downloadUrl(url)} aria-label={`下载 ${attachmentName}`}>
                              下载
                            </a>
                          )}
                        </div>
                      );
                    }
                    return (
                      <div className="file-attachment unavailable" key={`${attachment.type}-${attachment.fileKey}`}>
                        <b>!</b><span>{attachmentName}<small>{attachment.error || attachment.storageError || "附件不可用"}</small></span>
                      </div>
                    );
                  })}
                </div>
              )}
              <footer>{message.messageId}</footer>
            </div>
          </article>
        );
      })}
      {preview && (
        <div className="attachment-preview-backdrop" role="presentation" onClick={() => setPreview(null)}>
          <section
            className="attachment-preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`预览 ${preview.name}`}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>附件预览</span>
                <strong>{preview.name}</strong>
              </div>
              <button type="button" onClick={() => setPreview(null)} aria-label="关闭附件预览">×</button>
            </header>
            <div className="attachment-preview-content">
              {preview.loading && <p className="attachment-preview-state">正在读取附件…</p>}
              {preview.error && <p className="attachment-preview-state error">{preview.error}</p>}
              {!preview.loading && !preview.error && preview.kind === "text" && (
                <pre>{preview.content}</pre>
              )}
              {!preview.error && preview.kind === "pdf" && (
                <iframe src={preview.url} title={`预览 ${preview.name}`} />
              )}
            </div>
            <footer>
              <a href={downloadUrl(preview.url)}>下载原文件</a>
              <button type="button" onClick={() => setPreview(null)}>关闭</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
