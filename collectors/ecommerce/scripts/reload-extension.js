import { chromium } from "playwright";

const cdpUrl = process.argv[2] || "http://127.0.0.1:9333";
const browser = await chromium.connectOverCDP(cdpUrl);
try {
  console.log(JSON.stringify(browser.contexts().map((context) => context.pages().map((page) => page.url()))));
  const context = browser.contexts()[0];
  const controlPage = context?.pages().find(
    (page) => page.url().startsWith("chrome-extension://") && page.url().endsWith("/control.html"),
  );
  if (!controlPage) {
    const versionPage = context?.pages().find((page) => page.url().startsWith("chrome://version"));
    if (versionPage) console.log((await versionPage.locator("body").innerText()).slice(0, 12000));
    throw new Error("control page not found");
  }
  await controlPage.evaluate(() => chrome.runtime.reload());
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("extension-reloaded");
} finally {
  await browser.close();
}
