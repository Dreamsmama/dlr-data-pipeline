import { randomUUID } from "node:crypto";

import { appNamespace } from "./identity.js";
import type { FeishuChat } from "./types.js";

interface BaseCredentialSession {
  id: string;
  collectorType: "robot" | "cli";
  callerIdentity: "bot" | "user";
  appNamespace: string;
  userName: string;
  chats: FeishuChat[];
  expiresAt: number;
}

export interface RobotCredentialSession extends BaseCredentialSession {
  collectorType: "robot";
  callerIdentity: "bot";
  appId: string;
  appSecret: string;
}

export interface CliCredentialSession extends BaseCredentialSession {
  collectorType: "cli";
  callerIdentity: "user";
  profile: string;
}

export type CredentialSession = RobotCredentialSession | CliCredentialSession;

export interface PublicCredentialSession {
  sessionId: string;
  collectorType: "robot" | "cli";
  callerIdentity: "bot" | "user";
  userName: string;
  expiresAt: string;
  chats: FeishuChat[];
}

export class CredentialSessionStore {
  readonly #sessions = new Map<string, CredentialSession>();
  readonly #expiryTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly ttlMs = 30 * 60 * 1000) {}

  createBot(appId: string, appSecret: string, chats: FeishuChat[]): PublicCredentialSession {
    this.purgeExpired();
    const session: RobotCredentialSession = {
      id: randomUUID(),
      collectorType: "robot",
      callerIdentity: "bot",
      appNamespace: appNamespace(appId),
      userName: "",
      appId,
      appSecret,
      chats,
      expiresAt: Date.now() + this.ttlMs,
    };
    return this.add(session);
  }

  createCli(
    profile: string,
    namespace: string,
    userName: string,
    chats: FeishuChat[],
  ): PublicCredentialSession {
    this.purgeExpired();
    const session: CliCredentialSession = {
      id: randomUUID(),
      collectorType: "cli",
      callerIdentity: "user",
      appNamespace: namespace,
      userName,
      profile,
      chats,
      expiresAt: Date.now() + this.ttlMs,
    };
    return this.add(session);
  }

  private add(session: CredentialSession): PublicCredentialSession {
    this.#sessions.set(session.id, session);
    const timer = setTimeout(() => this.delete(session.id), this.ttlMs);
    timer.unref();
    this.#expiryTimers.set(session.id, timer);
    return this.toPublic(session);
  }

  get(sessionId: string): CredentialSession | undefined {
    this.purgeExpired();
    return this.#sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.#sessions.delete(sessionId);
    const timer = this.#expiryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.#expiryTimers.delete(sessionId);
  }

  purgeExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.delete(id);
    }
  }

  private toPublic(session: CredentialSession): PublicCredentialSession {
    return {
      sessionId: session.id,
      collectorType: session.collectorType,
      callerIdentity: session.callerIdentity,
      userName: session.userName,
      expiresAt: new Date(session.expiresAt).toISOString(),
      chats: session.chats,
    };
  }
}
