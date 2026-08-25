import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabasePool, requireDatabaseUrl } from "@dlr/database";

import { SpawnLarkCliExecutor } from "./lark-cli-bridge.js";
import {
  resolveStoredMentions,
  type ConfirmedMention,
  type MentionResolutionResult,
} from "./mention-resolution.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, "../../../..");
try {
  process.loadEnvFile(path.join(repositoryRoot, ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const argumentsList = process.argv.slice(2);
const apply = argumentsList.includes("--apply");
const targetChatId = argumentsList
  .find((argument) => argument.startsWith("--target-chat="))
  ?.slice("--target-chat=".length)
  .trim() ?? "";
const profile = argumentsList
  .find((argument) => argument.startsWith("--profile="))
  ?.slice("--profile=".length)
  .trim() ?? "";

if (!targetChatId) throw new Error("缺少 --target-chat=<群聊 chat_id>");
if (!profile) throw new Error("缺少 --profile=<Lark CLI profile>");
if (apply && process.env.FEISHU_PERSISTENCE_MODE !== "postgres-oss") {
  throw new Error("--apply 只允许在 FEISHU_PERSISTENCE_MODE=postgres-oss 时执行");
}

interface StoredMessage {
  messageId: string;
  text: string;
}

interface LarkMessage {
  message_id?: unknown;
  chat_id?: unknown;
  content?: unknown;
  deleted?: unknown;
  mentions?: unknown;
}

interface ConfirmedReplacement {
  messageId: string;
  originalText: string;
  resolvedText: string;
  mapping: Record<string, ConfirmedMention>;
}

interface JsonEnvelope {
  ok?: boolean;
  data?: { messages?: unknown };
}

type SkipReason = Exclude<MentionResolutionResult, { ok: true }>["reason"]
  | "not_returned"
  | "wrong_chat"
  | "deleted"
  | "duplicate_response";

function value(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

function parseEnvelope(text: string): JsonEnvelope {
  const envelope = JSON.parse(text.replace(/^\uFEFF/, "").trim()) as JsonEnvelope;
  if (envelope.ok !== true || !Array.isArray(envelope.data?.messages)) {
    throw new Error("Lark CLI 批量消息详情没有返回有效 messages");
  }
  return envelope;
}

function batches<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

const pool = createDatabasePool(requireDatabaseUrl());
try {
  const target = await pool.query<{ chatName: string; chatMode: string }>(
    `SELECT name AS "chatName", chat_mode AS "chatMode"
     FROM feishu_chats
     WHERE chat_id = $1`,
    [targetChatId],
  );
  if (!target.rows[0]) throw new Error("目标飞书群聊不存在");
  if (!["group", "topic"].includes(target.rows[0].chatMode)) {
    throw new Error("--target-chat 必须指向群聊或话题群");
  }

  const storedResult = await pool.query<StoredMessage>(
    `SELECT message_id AS "messageId", text
     FROM feishu_messages
     WHERE chat_id = $1 AND text ~ '@_user_[0-9]+'
     ORDER BY create_time ASC NULLS LAST, message_id ASC`,
    [targetChatId],
  );
  const storedMessages = storedResult.rows;
  const messageById = new Map<string, LarkMessage>();
  const duplicateResponseIds = new Set<string>();
  const executor = new SpawnLarkCliExecutor();
  const requestBatches = batches(storedMessages, 50);
  for (let index = 0; index < requestBatches.length; index += 1) {
    const batch = requestBatches[index]!;
    process.stderr.write(`读取飞书 mention 元数据：${index + 1}/${requestBatches.length}\n`);
    const result = await executor.run([
      "--profile", profile,
      "im", "+messages-mget",
      "--as", "user",
      "--message-ids", batch.map((message) => message.messageId).join(","),
      "--no-reactions",
      "--format", "json",
    ], { timeoutMs: 120_000 });
    const envelope = parseEnvelope(result.stdout);
    for (const raw of envelope.data!.messages as unknown[]) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const message = raw as LarkMessage;
      const messageId = value(message.message_id);
      if (!messageId) continue;
      if (messageById.has(messageId)) duplicateResponseIds.add(messageId);
      else messageById.set(messageId, message);
    }
  }

  const skipped: Record<SkipReason, number> = {
    no_placeholder: 0,
    missing_name: 0,
    conflicting_mapping: 0,
    unresolved_placeholder: 0,
    content_mismatch: 0,
    not_returned: 0,
    wrong_chat: 0,
    deleted: 0,
    duplicate_response: 0,
  };
  const confirmed: ConfirmedReplacement[] = [];
  for (const stored of storedMessages) {
    if (duplicateResponseIds.has(stored.messageId)) {
      skipped.duplicate_response += 1;
      continue;
    }
    const message = messageById.get(stored.messageId);
    if (!message) {
      skipped.not_returned += 1;
      continue;
    }
    if (value(message.chat_id) !== targetChatId) {
      skipped.wrong_chat += 1;
      continue;
    }
    if (booleanValue(message.deleted)) {
      skipped.deleted += 1;
      continue;
    }
    const resolution = resolveStoredMentions(stored.text, value(message.content), message.mentions);
    if (!resolution.ok) {
      skipped[resolution.reason] += 1;
      continue;
    }
    confirmed.push({
      messageId: stored.messageId,
      originalText: stored.text,
      resolvedText: resolution.resolvedText,
      mapping: resolution.mapping,
    });
  }

  let appliedCount = 0;
  if (apply && confirmed.length) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('feishu_mention_mget_backfill'))");
      for (const replacement of confirmed) {
        await client.query(
          `INSERT INTO feishu_mention_replacements (
             message_id, target_chat_id, mention_mapping, original_text, resolved_text
           ) VALUES ($1,$2,$3::jsonb,$4,$5)`,
          [
            replacement.messageId,
            targetChatId,
            JSON.stringify(replacement.mapping),
            replacement.originalText,
            replacement.resolvedText,
          ],
        );
        const updated = await client.query(
          `UPDATE feishu_messages
           SET text = $1
           WHERE message_id = $2 AND chat_id = $3 AND text = $4`,
          [replacement.resolvedText, replacement.messageId, targetChatId, replacement.originalText],
        );
        if (updated.rowCount !== 1) {
          throw new Error(`消息在分析后发生变化，已回滚：${replacement.messageId}`);
        }
        appliedCount += 1;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const userCounts = new Map<string, { id: string; name: string; occurrences: number }>();
  for (const replacement of confirmed) {
    for (const mention of Object.values(replacement.mapping)) {
      const key = `${mention.id}\u0000${mention.name}`;
      const current = userCounts.get(key) ?? { ...mention, occurrences: 0 };
      current.occurrences += 1;
      userCounts.set(key, current);
    }
  }
  const verification = await pool.query<{ remaining: string; audited: string }>(
    `SELECT
       (SELECT COUNT(*)::text
        FROM feishu_messages
        WHERE chat_id = $1 AND text ~ '@_user_[0-9]+') AS remaining,
       (SELECT COUNT(*)::text
        FROM feishu_mention_replacements
        WHERE target_chat_id = $1) AS audited`,
    [targetChatId],
  );
  process.stdout.write(`${JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    targetChat: { chatId: targetChatId, chatName: target.rows[0].chatName },
    profile,
    placeholderMessageCount: storedMessages.length,
    returnedMessageCount: messageById.size,
    confirmedCount: confirmed.length,
    appliedCount,
    remainingPlaceholderCount: Number(verification.rows[0]?.remaining ?? 0),
    auditedReplacementCount: Number(verification.rows[0]?.audited ?? 0),
    skipped,
    confirmedUsers: [...userCounts.values()].sort((left, right) =>
      right.occurrences - left.occurrences || left.name.localeCompare(right.name)),
    samples: confirmed.slice(0, 20),
  }, null, 2)}\n`);
} finally {
  await pool.end();
}
