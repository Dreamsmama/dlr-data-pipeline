import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import type { BridgeCallbacks, BridgeEvent, CrawlRequest, FeishuBridge, FeishuChat } from "./types.js";

interface PythonBridgeOptions {
  pythonProject: string;
  scriptPath: string;
  dataRoot: string;
  uvCommand?: string;
}

export class PythonFeishuBridge implements FeishuBridge {
  constructor(private readonly options: PythonBridgeOptions) {}

  async discoverChats(appId: string, appSecret: string): Promise<FeishuChat[]> {
    let chats: FeishuChat[] | undefined;
    await this.run("chats", { appId, appSecret }, {
      onEvent(event) {
        if (event.event === "chats") chats = event.chats;
      },
    });
    if (!chats) throw new Error("Python 任务未返回群聊列表");
    return chats;
  }

  async crawl(request: CrawlRequest, callbacks: BridgeCallbacks): Promise<void> {
    await this.run("crawl", request, callbacks);
  }

  private async run(
    mode: "chats" | "crawl",
    payload: object,
    callbacks: { onEvent(event: BridgeEvent | { event: "chats"; chats: FeishuChat[] }): Promise<void> | void },
  ): Promise<void> {
    const runtimeRoot = path.join(this.options.dataRoot, "runtime");
    await mkdir(runtimeRoot, { recursive: true });
    const child = spawn(
      this.options.uvCommand ?? "uv",
      ["run", "--project", this.options.pythonProject, "python", this.options.scriptPath, mode],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          UV_CACHE_DIR: path.join(runtimeRoot, "uv-cache"),
          UV_PROJECT_ENVIRONMENT: path.join(runtimeRoot, "python-venv"),
        },
      },
    );

    child.stdin.end(`${JSON.stringify(payload)}\n`);
    const errors: string[] = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (errors.join("").length < 12_000) errors.push(chunk);
    });

    let callbackChain = Promise.resolve();
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      callbackChain = callbackChain.then(async () => {
        let event: BridgeEvent | { event: "chats"; chats: FeishuChat[] };
        try {
          event = JSON.parse(line) as typeof event;
        } catch {
          throw new Error("Python 任务返回了无法解析的事件");
        }
        await callbacks.onEvent(event);
      });
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    await callbackChain;
    if (exitCode !== 0) {
      const detail = errors.join("").trim();
      throw new Error(detail || `Python 任务异常退出（${exitCode}）`);
    }
  }
}
