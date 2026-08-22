import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { chromium } from "playwright";

const EXTENSION_NAME = "淘宝店铺公开信息采集助手";
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const EXTENSION_PATH = path.join(PACKAGE_ROOT, "extension");

function printUsage() {
  console.log(`Usage:
  node scripts/run-extension.js --shop-url <store-or-product-url> [options]
  node scripts/run-extension.js --resume [options]

Connection (attach mode is recommended):
  --cdp-url <url>            Existing Chrome CDP endpoint (default: http://127.0.0.1:9333)
  --extension-id <id>        Extension id when it cannot be discovered automatically

Launch mode (isolated profile, mainly for development):
  --launch                   Launch a persistent Chromium context with the extension
  --user-data-dir <path>     Dedicated browser profile directory
  --executable-path <path>   Optional Chrome/Chromium executable

Collection:
  --max-pages <n>            Default: 1
  --max-products <n>         Default: 20
  --max-images <n>           Default: 40
  --wait-ms <n>              Default: 3500
  --timeout-ms <n>           Default: 1800000
  --manual-wait              Wait for Enter when login or verification is required
  --out <file>               Export JSON path (default: data/extension/latest.json)
  --resume                   Continue the task stored by the extension
  --help                     Show this help
`);
}

function parseArgs(argv) {
  const result = {
    cdpUrl: "http://127.0.0.1:9333",
    extensionId: null,
    launch: false,
    userDataDir: path.join(PACKAGE_ROOT, ".chrome-extension-profile"),
    executablePath: null,
    shopUrl: null,
    maxPages: 1,
    maxProducts: 20,
    maxImages: 40,
    waitMs: 3500,
    timeoutMs: 1800000,
    manualWait: false,
    out: path.join(PACKAGE_ROOT, "data", "extension", "latest.json"),
    resume: false,
    help: false
  };
  const valueOptions = new Map([
    ["--cdp-url", "cdpUrl"],
    ["--extension-id", "extensionId"],
    ["--user-data-dir", "userDataDir"],
    ["--executable-path", "executablePath"],
    ["--shop-url", "shopUrl"],
    ["--max-pages", "maxPages"],
    ["--max-products", "maxProducts"],
    ["--max-images", "maxImages"],
    ["--wait-ms", "waitMs"],
    ["--timeout-ms", "timeoutMs"],
    ["--out", "out"]
  ]);
  const numeric = new Set(["maxPages", "maxProducts", "maxImages", "waitMs", "timeoutMs"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    else if (token === "--launch") result.launch = true;
    else if (token === "--manual-wait") result.manualWait = true;
    else if (token === "--resume") result.resume = true;
    else if (token === "--help" || token === "-h") result.help = true;
    else if (valueOptions.has(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      const key = valueOptions.get(token);
      result[key] = numeric.has(key) ? Number(value) : value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${token}`);
    }
  }
  result.userDataDir = path.resolve(result.userDataDir);
  result.out = path.resolve(result.out);
  if (result.executablePath) result.executablePath = path.resolve(result.executablePath);
  return result;
}

function validateArgs(args) {
  if (!args.resume && !args.shopUrl) throw new Error("--shop-url is required unless --resume is used");
  if (args.shopUrl) {
    const url = new URL(args.shopUrl);
    if (url.protocol !== "https:" || !/(^|\.)(?:taobao|tmall)\.com$/i.test(url.hostname)) {
      throw new Error("--shop-url must be an HTTPS Taobao or Tmall store/product URL");
    }
  }
  for (const [name, value, minimum, maximum] of [
    ["--max-pages", args.maxPages, 1, 20],
    ["--max-products", args.maxProducts, 1, 200],
    ["--max-images", args.maxImages, 1, 200],
    ["--wait-ms", args.waitMs, 1000, 60000],
    ["--timeout-ms", args.timeoutMs, 10000, 86400000]
  ]) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
  }
}

async function findControlPage(context, extensionId) {
  const controlPages = context.pages().filter((page) => /^chrome-extension:\/\/[^/]+\/control\.html/.test(page.url()));
  if (controlPages.length > 0) {
    await controlPages[0].reload();
    return controlPages[0];
  }

  let resolvedId = extensionId;
  if (!resolvedId) {
    const deadline = Date.now() + 15000;
    while (!resolvedId && Date.now() < deadline) {
      for (const worker of context.serviceWorkers()) {
        try {
          const name = await worker.evaluate(() => chrome.runtime.getManifest().name);
          if (name === EXTENSION_NAME) {
            resolvedId = new URL(worker.url()).host;
            break;
          }
        } catch {
          // Ignore unrelated or already stopped service workers.
        }
      }
      if (!resolvedId) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!resolvedId) {
    throw new Error("Cannot discover the extension id. Open the extension once or pass --extension-id.");
  }
  const page = await context.newPage();
  await page.goto(`chrome-extension://${resolvedId}/control.html`);
  return page;
}

async function connect(args) {
  if (!args.launch) {
    const browser = await chromium.connectOverCDP(args.cdpUrl);
    const context = browser.contexts()[0];
    if (!context) throw new Error("The CDP browser has no default context");
    return { browser, context, externallyOwned: true };
  }

  const launchOptions = {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`
    ]
  };
  if (args.executablePath) launchOptions.executablePath = args.executablePath;
  else launchOptions.channel = "chromium";
  const context = await chromium.launchPersistentContext(args.userDataDir, launchOptions);
  return { browser: null, context, externallyOwned: false };
}

async function startOrResume(page, args) {
  await page.waitForSelector("#status-code");
  const initialStatus = await page.locator("#status-code").textContent();
  if (args.resume) {
    if (initialStatus === "needs_user" || initialStatus === "paused") {
      await page.locator("#continue-button").click();
      return;
    }
    if (initialStatus === "running") return;
    throw new Error(`Stored task cannot be resumed from status: ${initialStatus}`);
  }
  if (["running", "needs_user", "paused"].includes(initialStatus)) {
    throw new Error(`Extension already has an unfinished task (${initialStatus}); use --resume or finish it first`);
  }
  await page.locator("#shop-url").fill(args.shopUrl);
  await page.locator("#max-pages").fill(String(args.maxPages));
  await page.locator("#max-products").fill(String(args.maxProducts));
  await page.locator("#max-images").fill(String(args.maxImages));
  await page.locator("#wait-ms").fill(String(args.waitMs));
  await page.locator("#start-button").click();
  await page.locator("#status-code").waitForFunction(
    (element, previousStatus) => element.textContent !== previousStatus,
    initialStatus,
    { timeout: 10000 }
  );
}

async function waitForCompletion(page, args) {
  const deadline = Date.now() + args.timeoutMs;
  let lastSummary = "";
  while (Date.now() < deadline) {
    const [status, message] = await Promise.all([
      page.locator("#status-code").textContent(),
      page.locator("#status-message").textContent()
    ]);
    const summary = `${status}: ${message}`;
    if (summary !== lastSummary) {
      console.log(summary);
      lastSummary = summary;
    }
    if (status === "completed") return;
    if (status === "failed" || status === "stopped") throw new Error(summary);
    if (status === "needs_user") {
      if (!args.manualWait) {
        const error = new Error("Login or verification is required in the collection tab. Re-run with --resume after completing it.");
        error.exitCode = 3;
        throw error;
      }
      const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        await prompt.question("请在采集页完成登录或安全验证，然后按 Enter 继续：");
      } finally {
        prompt.close();
      }
      await page.locator("#continue-button").click();
    }
    await page.waitForTimeout(750);
  }
  throw new Error(`Collection timed out after ${args.timeoutMs}ms`);
}

async function saveExport(page, outPath) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-button").click();
  const download = await downloadPromise;
  await download.saveAs(outPath);
  console.log(`exported: ${outPath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  validateArgs(args);
  const connection = await connect(args);
  try {
    const page = await findControlPage(connection.context, args.extensionId);
    await page.bringToFront();
    await startOrResume(page, args);
    await waitForCompletion(page, args);
    await saveExport(page, args.out);
  } finally {
    if (connection.externallyOwned) await connection.browser.close();
    else await connection.context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = error.exitCode || 1;
});
