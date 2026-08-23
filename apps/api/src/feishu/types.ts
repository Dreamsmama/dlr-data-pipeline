export type FeishuChatMode = "group" | "topic" | "p2p" | "unknown";
export type FeishuChatStatus = "normal" | "dissolved" | "dissolved_save" | "unknown";
export type FeishuCollectorType = "robot" | "cli";
export type FeishuCallerIdentity = "bot" | "user";

export interface FeishuChat {
  chatId: string;
  name: string;
  description?: string;
  chatMode: FeishuChatMode;
  chatStatus: FeishuChatStatus;
  external?: boolean;
  ownerId?: string;
  p2pTargetType?: string;
  p2pTargetId?: string;
}

export interface TimelineAttachment {
  type: "image" | "file";
  fileKey: string;
  name: string;
  status: "pending" | "downloaded" | "reused" | "unavailable" | "failed";
  relativePath: string;
  size: number;
  error: string;
  storageStatus?: "pending" | "not_configured" | "source_failed" | "uploaded" | "upload_failed";
  ossBucket?: string;
  ossObjectKey?: string;
  ossEtag?: string;
  storageError?: string;
  uploadedAt?: string;
}

export interface TimelineMessage {
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
  attachments: TimelineAttachment[];
}

export interface AttachmentIdentity {
  messageId: string;
  fileKey: string;
}

export type JobStatus = "queued" | "running" | "completed" | "partial" | "failed";

export interface CollectionJob {
  id: string;
  collectorType: FeishuCollectorType;
  callerIdentity: FeishuCallerIdentity;
  appNamespace: string;
  chatId: string;
  chatName: string;
  chatMode: FeishuChatMode;
  chatStatus: FeishuChatStatus;
  external?: boolean;
  ownerId: string;
  p2pTargetType: string;
  p2pTargetId: string;
  status: JobStatus;
  pages: number;
  messageCount: number;
  attachmentCount: number;
  attachmentPendingCount: number;
  attachmentProcessedCount: number;
  attachmentFailedCount: number;
  nextPageToken: string;
  hasMore: boolean;
  error: string;
  /** UTC instant, inclusive. Optional only for legacy jobs created before range capture existed. */
  startTime?: string;
  /** UTC instant, exclusive. Optional only for legacy jobs created before range capture existed. */
  endTimeExclusive?: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
}

export interface PageEvent {
  event: "page";
  pageNumber: number;
  messages: TimelineMessage[];
  nextPageToken: string;
  hasMore: boolean;
  attachmentCount: number;
  attachmentFailedCount: number;
}

export interface WarningEvent {
  event: "warning";
  message: string;
}

export interface DoneEvent {
  event: "done";
}

export type BridgeEvent = PageEvent | WarningEvent | DoneEvent;

export interface CrawlRequest {
  appId: string;
  appSecret: string;
  chatId: string;
  chatName: string;
  outputDir: string;
  pageToken: string;
  pageNumber: number;
  startTime: string;
  endTimeExclusive: string;
  skipAttachments: AttachmentIdentity[];
}

export interface CliCrawlRequest {
  profile: string;
  chatId: string;
  chatName: string;
  outputDir: string;
  pageToken: string;
  pageNumber: number;
  startTime: string;
  endTimeExclusive: string;
}

export interface CliAttachmentDownloadRequest {
  profile: string;
  chatId: string;
  messageId: string;
  outputDir: string;
  signal?: AbortSignal;
}

export interface CliAuthStatus {
  identity: "user" | "bot" | "none";
  available: boolean;
  userName: string;
  tokenStatus: string;
  verified: boolean;
}

export interface CliConnection {
  connectionId: string;
  cliVersion: string;
  expiresAt: string;
  authStatus: CliAuthStatus;
}

export interface CliAuthChallenge {
  authSessionId: string;
  verificationUrl: string;
  expiresAt: string;
}

export interface CliCollectionAccess {
  profile: string;
  appNamespace: string;
  userName: string;
  chats: FeishuChat[];
}

export interface BridgeCallbacks {
  onEvent(event: BridgeEvent): Promise<void> | void;
}

export interface FeishuBridge {
  discoverChats(appId: string, appSecret: string): Promise<FeishuChat[]>;
  crawl(request: CrawlRequest, callbacks: BridgeCallbacks): Promise<void>;
}

export interface UserCliFeishuBridge {
  configureApp(appId: string, appSecret: string): Promise<CliConnection>;
  restoreApp(appId: string): Promise<CliConnection>;
  beginAuth(connectionId: string): Promise<CliAuthChallenge>;
  resolveQrCode(authSessionId: string): Promise<string>;
  completeAuth(authSessionId: string): Promise<CliAuthStatus>;
  discoverChats(connectionId: string): Promise<CliCollectionAccess>;
  crawl(request: CliCrawlRequest, callbacks: BridgeCallbacks): Promise<void>;
  downloadMessageAttachments(request: CliAttachmentDownloadRequest): Promise<TimelineAttachment[]>;
}
