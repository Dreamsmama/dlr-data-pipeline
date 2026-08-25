import { createHash } from "node:crypto";

export function appNamespace(appId: string): string {
  return `sha256:${createHash("sha256").update(appId.trim(), "utf8").digest("hex")}`;
}

export function profileForApp(appId: string): string {
  return `dlr-history-${appNamespace(appId).slice("sha256:".length, "sha256:".length + 12)}`;
}
