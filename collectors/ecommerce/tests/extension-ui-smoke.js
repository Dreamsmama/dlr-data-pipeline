import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const packageRoot = path.resolve(import.meta.dirname, "..");
const extensionPath = path.join(packageRoot, "extension");
const outputDir = path.join(packageRoot, "output", "playwright");
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "taobao-extension-qa-"));
await fs.mkdir(outputDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`
  ]
});

try {
  const consoleErrors = [];
  let controlPage = null;
  const deadline = Date.now() + 15000;
  while (!controlPage && Date.now() < deadline) {
    controlPage = context.pages().find((page) => /chrome-extension:\/\/[^/]+\/control\.html/.test(page.url())) || null;
    if (!controlPage) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!controlPage) {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10000 });
    const extensionId = new URL(worker.url()).host;
    controlPage = await context.newPage();
    await controlPage.goto(`chrome-extension://${extensionId}/control.html`);
  }

  controlPage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  controlPage.on("pageerror", (error) => consoleErrors.push(error.message));
  await controlPage.waitForSelector("#status-code");

  assert.equal(await controlPage.locator("#status-code").textContent(), "idle");
  assert.equal(await controlPage.locator("input").count(), 5);
  assert.equal(await controlPage.locator("button").count(), 6);
  const unlabeledInputs = await controlPage.locator("input").evaluateAll((inputs) => (
    inputs.filter((input) => !input.closest("label") && !input.getAttribute("aria-label")).length
  ));
  assert.equal(unlabeledInputs, 0);

  await controlPage.locator("#shop-url").fill("https://example.com/");
  await controlPage.locator("#start-button").click();
  await controlPage.waitForFunction(() => document.body.dataset.status === "failed");
  assert.match(await controlPage.locator("#status-message").textContent(), /淘宝或天猫/);

  controlPage.once("dialog", (dialog) => dialog.accept());
  await controlPage.locator("#reset-button").click();
  await controlPage.waitForFunction(() => document.body.dataset.status === "idle");
  await controlPage.locator("#shop-url").fill("https://diluoweihzp.tmall.com/category.htm");

  for (const [name, width, height] of [
    ["desktop", 1440, 1000],
    ["tablet", 768, 900],
    ["mobile", 375, 812]
  ]) {
    await controlPage.setViewportSize({ width, height });
    const overflow = await controlPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${name} horizontal overflow: ${overflow}px`);
    await controlPage.screenshot({ path: path.join(outputDir, `extension-control-${name}.png`), fullPage: true });
  }

  assert.deepEqual(consoleErrors, []);
  console.log("extension-ui-smoke: ok");
} finally {
  await context.close();
  await fs.rm(profileDir, { recursive: true, force: true });
}
