import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LarkCliFeishuBridge,
  type LarkCliCommandResult,
  type LarkCliExecutor,
} from "./lark-cli-bridge.js";
import type { BridgeEvent } from "./types.js";

class FakeExecutor implements LarkCliExecutor {
  readonly calls: Array<{ args: string[]; input: string; cwd: string; timeoutMs?: number }> = [];
  verifyStatusError = "";
  unverifiedUserAvailable = false;

  async run(
    args: string[],
    options: { cwd?: string; input?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<LarkCliCommandResult> {
    this.calls.push({
      args,
      input: options.input ?? "",
      cwd: options.cwd ?? "",
      timeoutMs: options.timeoutMs,
    });
    if (args.includes("--version")) return this.ok("lark-cli version 1.0.88\n");
    if (args.includes("config") && args.includes("init")) return this.ok("configured\n");
    if (args.includes("auth") && args.includes("qrcode")) {
      await writeFile(path.join(options.cwd ?? "", "qrcode.png"), "fake-png", "utf8");
      return this.ok("qrcode.png\n");
    }
    if (args.includes("auth") && args.includes("login") && args.includes("--no-wait")) {
      return this.json({
        ok: true,
        data: {
          device_code: "device-secret",
          verification_url: "https://accounts.example.test/device?opaque=1&next=2",
          expires_in: 600,
        },
      });
    }
    if (args.includes("auth") && args.includes("login") && args.includes("--device-code")) {
      return this.json({ ok: true, identity: "user", data: {} });
    }
    if (args.includes("auth") && args.includes("status")) {
      if (!args.includes("--verify")) {
        if (this.unverifiedUserAvailable) {
          return this.json({
            identity: "user",
            verified: false,
            identities: {
              user: {
                available: true,
                status: "valid",
                tokenStatus: "valid",
                userName: "缓存用户",
              },
            },
          });
        }
        return this.json({
          identity: "none",
          identities: { user: { available: false, status: "missing" } },
        });
      }
      if (this.verifyStatusError) throw new Error(this.verifyStatusError);
      return this.json({
        identity: "user",
        verified: true,
        identities: {
          user: {
            available: true,
            status: "valid",
            tokenStatus: "valid",
            userName: "测试用户",
          },
        },
      });
    }
    if (args.includes("+chat-list")) {
      return this.json({
        ok: true,
        identity: "user",
        data: {
          has_more: false,
          chats: [{
            chat_id: "oc_direct",
            name: "联系人",
            chat_mode: "p2p",
            chat_status: "normal",
            external: false,
            p2p_target_type: "user",
            p2p_target_id: "ou_peer",
          }, {
            chat_id: "oc_group",
            name: "测试群",
            chat_mode: "group",
            chat_status: "normal",
            external: true,
            owner_id: "ou_owner",
          }],
        },
        meta: { pagination: { complete: true } },
      });
    }
    if (args.includes("+chat-messages-list")) {
      return this.json({
        ok: true,
        identity: "user",
        data: {
          has_more: false,
          page_token: "",
          messages: [{
            message_id: "om_root",
            chat_id: "oc_direct",
            msg_type: "image",
            create_time: "1787287200000",
            content: "![Image](img_1)",
            sender: { id: "ou_sender", name: "发送者", sender_type: "user" },
            deleted: false,
            updated: false,
            thread_has_more: true,
            thread_replies: [{
              message_id: "om_reply",
              msg_type: "text",
              create_time: "2026-08-21T10:01:00+08:00",
              content: "回复",
              sender: { id: "ou_reply", name: "回复者", sender_type: "user" },
              deleted: false,
              updated: false,
            }],
          }],
        },
      });
    }
    if (args.includes("+messages-mget")) {
      const resourceRoot = path.join(options.cwd ?? "", "lark-im-resources");
      await mkdir(resourceRoot, { recursive: true });
      await writeFile(path.join(resourceRoot, "photo.png"), "file", "utf8");
      return this.json({
        ok: true,
        identity: "user",
        data: {
          messages: [{
            message_id: "om_root",
            resources: [{
              message_id: "om_root",
              key: "img_1",
              type: "image",
              local_path: "lark-im-resources/photo.png",
              size_bytes: 4,
            }],
          }],
        },
      });
    }
    throw new Error(`unexpected fake command: ${args.join(" ")}`);
  }

  private ok(stdout: string): LarkCliCommandResult {
    return { exitCode: 0, stdout, stderr: "" };
  }

  private json(value: unknown): LarkCliCommandResult {
    return this.ok(JSON.stringify(value));
  }
}

test("Lark CLI 桥接完成应用配置、设备授权、会话映射和消息附件规范化", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-lark-cli-bridge-"));
  const executor = new FakeExecutor();
  const bridge = new LarkCliFeishuBridge({ dataRoot, executor, attachmentTimeoutMs: 12_345 });
  const secret = "app-secret-through-stdin";

  const connection = await bridge.configureApp("cli_test123", secret);
  assert.equal(connection.cliVersion, "1.0.88");
  assert.equal(connection.authStatus.identity, "none");
  const configCall = executor.calls.find((call) => call.args.includes("config"));
  assert.ok(configCall);
  assert.equal(configCall.args.includes(secret), false);
  assert.equal(configCall.input, `${secret}\n`);

  const challenge = await bridge.beginAuth(connection.connectionId);
  assert.equal(challenge.verificationUrl, "https://accounts.example.test/device?opaque=1&next=2");
  assert.equal((await readFile(await bridge.resolveQrCode(challenge.authSessionId), "utf8")), "fake-png");
  assert.equal(JSON.stringify(challenge).includes("device-secret"), false);
  const authCall = executor.calls.find((call) => call.args.includes("auth") && call.args.includes("--no-wait"));
  assert.ok(authCall);
  const scopeIndex = authCall.args.indexOf("--scope");
  assert.deepEqual(authCall.args[scopeIndex + 1].split(" "), [
    "im:chat:read",
    "im:message:readonly",
    "im:message.group_msg:get_as_user",
    "im:message.p2p_msg:get_as_user",
    "im:message.reactions:read",
  ]);

  const status = await bridge.completeAuth(challenge.authSessionId);
  assert.equal(status.identity, "user");
  assert.equal(status.userName, "测试用户");

  const access = await bridge.discoverChats(connection.connectionId);
  assert.deepEqual(access.chats.map((chat) => chat.chatMode), ["p2p", "group"]);
  assert.equal(access.chats[0].p2pTargetId, "ou_peer");
  assert.match(access.appNamespace, /^sha256:[a-f0-9]{64}$/);

  const jobRoot = path.join(dataRoot, "job");
  const events: BridgeEvent[] = [];
  await bridge.crawl({
    profile: access.profile,
    chatId: "oc_direct",
    chatName: "联系人",
    outputDir: jobRoot,
    pageToken: "",
    pageNumber: 0,
    startTime: "2026-08-21T02:00:00.000Z",
    endTimeExclusive: "2026-08-21T03:00:00.000Z",
  }, { onEvent(event) { events.push(event); } });

  const warning = events.find((event) => event.event === "warning");
  assert.ok(warning && warning.event === "warning" && warning.message.includes("展开上限"));
  const page = events.find((event) => event.event === "page");
  assert.ok(page && page.event === "page");
  assert.equal(page.messages.length, 2);
  assert.equal(page.messages[1].rootId, "om_root");
  assert.equal(page.messages[0].senderName, "发送者");
  assert.equal(page.messages[0].attachments[0].status, "pending");
  assert.equal(page.messages[0].attachments[0].storageStatus, "pending");
  const pageCall = executor.calls.find((call) => call.args.includes("+chat-messages-list"));
  assert.ok(pageCall);
  assert.equal(pageCall.args.includes("--download-resources"), false);
  assert.equal(pageCall.timeoutMs, 180_000);

  const downloaded = await bridge.downloadMessageAttachments({
    profile: access.profile,
    chatId: "oc_direct",
    messageId: "om_root",
    outputDir: jobRoot,
  });
  assert.equal(downloaded[0].status, "downloaded");
  assert.equal(downloaded[0].size, 4);
  const attachmentCall = executor.calls.find((call) => call.args.includes("+messages-mget"));
  assert.ok(attachmentCall);
  assert.equal(attachmentCall.args.includes("--download-resources"), true);
  assert.equal(attachmentCall.timeoutMs, 12_345);
  const storedAttachment = path.join(jobRoot, ...downloaded[0].relativePath.split("/"));
  assert.equal(await readFile(storedAttachment, "utf8"), "file");
});

test("既有 CLI profile 可在服务重启后仅凭 App ID 恢复，连接使用滑动过期", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-lark-cli-restore-"));
  const executor = new FakeExecutor();
  let now = 1_000;
  const options = {
    dataRoot,
    executor,
    connectionTtlMs: 100,
    now: () => now,
  };
  const firstBridge = new LarkCliFeishuBridge(options);
  const configured = await firstBridge.configureApp("cli_restore123", "secret-only-for-config");
  const configCallsBeforeRestore = executor.calls.filter((call) => call.args.includes("config")).length;

  const restartedBridge = new LarkCliFeishuBridge(options);
  const restored = await restartedBridge.restoreApp("cli_restore123");
  assert.notEqual(restored.connectionId, configured.connectionId);
  assert.equal(restored.authStatus.identity, "user");
  assert.equal(restored.authStatus.verified, true);
  assert.equal(executor.calls.filter((call) => call.args.includes("config")).length, configCallsBeforeRestore);
  assert.ok(executor.calls.some((call) => call.args.includes("status") && call.args.includes("--verify")));
  assert.equal(executor.calls.some((call) => call.args.includes("secret-only-for-config")), false);

  now = 1_090;
  await restartedBridge.beginAuth(restored.connectionId);
  now = 1_180;
  const access = await restartedBridge.discoverChats(restored.connectionId);
  assert.equal(access.userName, "测试用户");
  now = 1_281;
  await assert.rejects(
    restartedBridge.discoverChats(restored.connectionId),
    /临时应用连接已过期/,
  );
});

test("飞书网络校验暂时失败时仍保留可恢复的 profile 连接", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-lark-cli-offline-restore-"));
  const executor = new FakeExecutor();
  executor.verifyStatusError = "temporary network failure";
  executor.unverifiedUserAvailable = true;
  const bridge = new LarkCliFeishuBridge({ dataRoot, executor });

  const restored = await bridge.restoreApp("cli_offline123");
  assert.equal(restored.authStatus.identity, "user");
  assert.equal(restored.authStatus.available, true);
  assert.equal(restored.authStatus.verified, false);
  assert.equal(restored.authStatus.userName, "缓存用户");
});

test("不存在的 profile 返回可执行提示且不暴露其他 profile 名称", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-lark-cli-missing-profile-"));
  const executor: LarkCliExecutor = {
    async run(args) {
      if (args.includes("--version")) {
        return { exitCode: 0, stdout: "lark-cli version 1.0.88\n", stderr: "" };
      }
      throw new Error(JSON.stringify({
        ok: false,
        error: {
          subtype: "not_configured",
          message: "profile missing-profile not found",
          hint: "pass one of: unrelated-private-profile",
        },
      }));
    },
  };
  const bridge = new LarkCliFeishuBridge({ dataRoot, executor });

  await assert.rejects(
    bridge.restoreApp("cli_missing123"),
    (error: Error) => {
      assert.match(error.message, /不存在该 App ID 对应的 profile/);
      assert.equal(error.message.includes("unrelated-private-profile"), false);
      return true;
    },
  );
});

test("Windows 密钥链拒绝访问时返回可执行的说明且不泄露 Secret", async () => {
  const secret = "must-not-appear-in-the-error";
  const executor: LarkCliExecutor = {
    async run(args) {
      if (args.includes("--version")) {
        return { exitCode: 0, stdout: "lark-cli version 1.0.88\n", stderr: "" };
      }
      throw new Error(
        `keychain unavailable: keychain Set failed: registry create/open failed: Access is denied. app_secret=${secret}`,
      );
    },
  };
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "dlr-lark-cli-keychain-"));
  const bridge = new LarkCliFeishuBridge({ dataRoot, executor });

  let message = "";
  try {
    await bridge.configureApp("cli_keychaintest", secret);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert.match(message, /当前登录的 Windows 用户启动 API 服务/);
  assert.match(message, /用户 OAuth Token 仍然依赖 Windows 密钥链/);
  assert.equal(message.includes(secret), false);
});
