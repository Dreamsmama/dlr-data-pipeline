import { extractPageInTab } from "./extractor.js";

const STATE_KEY = "collectorStateV1";
const RAW_PAGE_PREFIX = "rawPage:";
const CONTROL_URL = chrome.runtime.getURL("control.html");
const STATUS_LABELS = {
  idle: "空闲",
  running: "采集中",
  needs_user: "等待验证",
  stopped: "已停止",
  completed: "已完成",
  failed: "失败",
  paused: "已暂停"
};

const elements = {
  body: document.body,
  form: document.querySelector("#collector-form"),
  shopUrl: document.querySelector("#shop-url"),
  maxPages: document.querySelector("#max-pages"),
  maxProducts: document.querySelector("#max-products"),
  maxImages: document.querySelector("#max-images"),
  waitMs: document.querySelector("#wait-ms"),
  start: document.querySelector("#start-button"),
  stop: document.querySelector("#stop-button"),
  continue: document.querySelector("#continue-button"),
  focus: document.querySelector("#focus-button"),
  export: document.querySelector("#export-button"),
  reset: document.querySelector("#reset-button"),
  statusBadge: document.querySelector("#status-badge"),
  statusCode: document.querySelector("#status-code"),
  phase: document.querySelector("#phase-label"),
  progress: document.querySelector("#progress"),
  currentUrl: document.querySelector("#current-url"),
  message: document.querySelector("#status-message"),
  needsUser: document.querySelector("#needs-user"),
  metricPages: document.querySelector("#metric-pages"),
  metricDiscovered: document.querySelector("#metric-discovered"),
  metricProducts: document.querySelector("#metric-products"),
  metricFailures: document.querySelector("#metric-failures"),
  results: document.querySelector("#results-body"),
  runId: document.querySelector("#run-id"),
  logs: document.querySelector("#log-list")
};

let state = createIdleState();
let loopActive = false;

function createIdleState() {
  return {
    schema_version: 1,
    run_id: null,
    status: "idle",
    phase: "listing",
    started_at: null,
    finished_at: null,
    config: null,
    list_page_index: 0,
    current_list_url: null,
    visited_list_urls: [],
    discovered: {},
    product_queue: [],
    product_index: 0,
    products: [],
    failures: [],
    work_tab_id: null,
    current_kind: null,
    current_url: null,
    message: "尚未开始",
    logs: []
  };
}

function nowIso() {
  return new Date().toISOString();
}

function createRunId() {
  return `run-${nowIso().replace(/[:.]/g, "-")}`;
}

function rawPageKey(runId, itemId) {
  return `${RAW_PAGE_PREFIX}${runId}:${itemId}`;
}

async function removeRawPages() {
  const stored = await chrome.storage.local.get(null);
  const keys = Object.keys(stored).filter((key) => key.startsWith(RAW_PAGE_PREFIX));
  if (keys.length > 0) await chrome.storage.local.remove(keys);
}

function isAllowedPageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && /(^|\.)(?:taobao|tmall)\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function productFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const itemId = url.searchParams.get("id");
    if (!itemId || !/(?:item\.taobao\.com|detail\.tmall\.com)\/item\.htm$/i.test(`${url.hostname}${url.pathname}`)) {
      return null;
    }
    const canonical = new URL(url);
    canonical.search = `?id=${encodeURIComponent(itemId)}`;
    canonical.hash = "";
    return {
      item_id: itemId,
      url: canonical.href,
      navigation_url: url.href,
      anchor_text: "",
      listing_text: ""
    };
  } catch {
    return null;
  }
}

function boundedInteger(input, minimum, maximum) {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${input.previousElementSibling?.textContent || input.name}超出范围`);
  }
  return value;
}

function readConfig() {
  const shopUrl = elements.shopUrl.value.trim();
  if (!isAllowedPageUrl(shopUrl)) {
    throw new Error("采集 URL 必须是 HTTPS 淘宝或天猫页面");
  }
  return {
    shop_url: shopUrl,
    max_pages: boundedInteger(elements.maxPages, 1, 20),
    max_products: boundedInteger(elements.maxProducts, 1, 200),
    max_images: boundedInteger(elements.maxImages, 1, 200),
    wait_ms: boundedInteger(elements.waitMs, 1000, 60000)
  };
}

async function persistState() {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

async function loadState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  const value = stored[STATE_KEY];
  if (!value || value.schema_version !== 1) return createIdleState();
  return { ...createIdleState(), ...value };
}

function addLog(message) {
  state.message = message;
  state.logs.push({ at: nowIso(), message });
  state.logs = state.logs.slice(-100);
}

async function checkpoint(message) {
  if (message) addLog(message);
  await persistState();
  render();
}

function setFormFromState() {
  if (!state.config) return;
  elements.shopUrl.value = state.config.shop_url || "";
  elements.maxPages.value = state.config.max_pages;
  elements.maxProducts.value = state.config.max_products;
  elements.maxImages.value = state.config.max_images;
  elements.waitMs.value = state.config.wait_ms;
}

function renderResults() {
  elements.results.replaceChildren();
  const products = state.products.slice(-20).reverse();
  if (products.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.className = "empty-row";
    cell.textContent = "暂无结果";
    row.append(cell);
    elements.results.append(row);
    return;
  }
  for (const product of products) {
    const row = document.createElement("tr");
    for (const value of [product.item_id, product.title || "未读取到标题", String(product.image_count || 0)]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      cell.title = value;
      row.append(cell);
    }
    elements.results.append(row);
  }
}

function renderLogs() {
  elements.logs.replaceChildren();
  for (const entry of state.logs.slice().reverse()) {
    const item = document.createElement("li");
    item.textContent = `${new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })}  ${entry.message}`;
    elements.logs.append(item);
  }
}

function render() {
  const status = STATUS_LABELS[state.status] ? state.status : "idle";
  elements.body.dataset.status = status;
  elements.statusBadge.textContent = STATUS_LABELS[status];
  elements.statusCode.textContent = status;
  elements.phase.textContent = state.phase === "products" ? "商品详情" : (state.status === "idle" ? "等待开始" : "店铺列表");
  elements.currentUrl.textContent = state.current_url || "-";
  elements.currentUrl.title = state.current_url || "";
  elements.message.textContent = state.message || "-";
  elements.runId.textContent = state.run_id || "-";
  elements.metricPages.textContent = String(state.list_page_index || 0);
  elements.metricDiscovered.textContent = String(Object.keys(state.discovered || {}).length);
  elements.metricProducts.textContent = String(state.products.length);
  elements.metricFailures.textContent = String(state.failures.length);
  const progressMax = state.phase === "products"
    ? Math.max(1, state.product_queue.length)
    : Math.max(1, state.config?.max_pages || 1);
  const progressValue = state.phase === "products" ? state.product_index : state.list_page_index;
  elements.progress.max = progressMax;
  elements.progress.value = Math.min(progressMax, progressValue);
  elements.needsUser.hidden = status !== "needs_user";
  elements.continue.hidden = !["needs_user", "paused"].includes(status);
  elements.continue.textContent = status === "paused" ? "继续任务" : "验证后继续";
  elements.start.disabled = ["running", "needs_user", "paused"].includes(status);
  elements.stop.disabled = status !== "running";
  elements.focus.disabled = state.work_tab_id == null;
  elements.export.disabled = state.products.length === 0;
  for (const input of elements.form.querySelectorAll("input")) {
    input.disabled = ["running", "needs_user", "paused"].includes(status);
  }
  renderResults();
  renderLogs();
}

function waitForTabComplete(tabId, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, tab) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve(tab);
    };
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish(null, tab);
    };
    const timer = setTimeout(() => finish(new Error("page_load_timeout")), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function ensureWorkTab() {
  if (state.work_tab_id != null) {
    try {
      return await chrome.tabs.get(state.work_tab_id);
    } catch {
      state.work_tab_id = null;
    }
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  state.work_tab_id = tab.id;
  await persistState();
  return tab;
}

async function navigateWorkTab(url) {
  const tab = await ensureWorkTab();
  const completed = waitForTabComplete(tab.id);
  await chrome.tabs.update(tab.id, { url });
  return completed;
}

async function executeExtraction(mode) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: state.work_tab_id },
    world: "MAIN",
    func: extractPageInTab,
    args: [{
      mode,
      maxImages: state.config.max_images,
      scrollDelayMs: Math.min(1200, Math.max(300, Math.floor(state.config.wait_ms / 3)))
    }]
  });
  if (!result) throw new Error("empty_extraction_result");
  return result;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function loadAndExtract(url, mode, reuseLoadedPage = false) {
  if (!isAllowedPageUrl(url)) throw new Error(`unsupported_page_url: ${url}`);
  state.current_kind = mode;
  state.current_url = url;
  await checkpoint(`${mode === "list" ? "读取列表页" : "读取商品"}：${url}`);
  if (!reuseLoadedPage) {
    await navigateWorkTab(url);
    await wait(state.config.wait_ms);
  } else {
    const tab = await ensureWorkTab();
    if (!isAllowedPageUrl(tab.url)) throw new Error("验证后的页面不在淘宝或天猫域名下");
    await wait(Math.min(1500, state.config.wait_ms));
  }
  const result = await executeExtraction(mode);
  if (result.error === "login_required" || result.error === "platform_verification_page") {
    state.status = "needs_user";
    state.current_url = result.fetched_url || url;
    await checkpoint(result.error === "login_required" ? "采集页需要登录" : "采集页需要安全验证");
    return null;
  }
  if (result.error) throw new Error(result.error);
  return result;
}

function parseObservedNumber(rawValue) {
  let value = String(rawValue || "").replace(/[,+]/g, "").trim();
  if (!value) return null;
  const units = { "亿": 100000000, "万": 10000, "千": 1000, "百": 100 };
  const suffix = value.slice(-1);
  const multiplier = units[suffix] || 1;
  if (units[suffix]) value = value.slice(0, -1);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed * multiplier : null;
}

function listingMarket(text) {
  const price = String(text || "").match(/(?:￥|¥)\s*([0-9]+(?:\.[0-9]+)?)/)?.[1] || "";
  const sales = String(text || "").match(/(?:已售|销量|月销|总销量)\s*[:：]?\s*([0-9.万千百亿+]+)/)?.[1]
    || String(text || "").match(/([0-9.万千百亿+]+)\s*(?:人付款|件已售|人已买)/)?.[1]
    || "";
  return {
    listing_text: text || "",
    price_text: price,
    sales_text: sales,
    price_observed: price ? Number(price) : null,
    sales_observed: parseObservedNumber(sales),
    raw_source: "publicly_displayed_shop_listing"
  };
}

function prepareProductPhase() {
  state.phase = "products";
  state.product_queue = Object.values(state.discovered).slice(0, state.config.max_products);
  state.product_index = Math.min(state.product_index, state.product_queue.length);
}

async function runListingStep(reuseLoadedPage) {
  if (state.list_page_index >= state.config.max_pages || !state.current_list_url) {
    prepareProductPhase();
    await checkpoint(`列表读取完成，发现 ${state.product_queue.length} 个商品`);
    return true;
  }
  const result = await loadAndExtract(state.current_list_url, "list", reuseLoadedPage);
  if (!result) return false;
  state.visited_list_urls.push(result.fetched_url || state.current_list_url);
  for (const item of result.items || []) {
    if (Object.keys(state.discovered).length >= state.config.max_products) break;
    if (!state.discovered[item.item_id]) state.discovered[item.item_id] = item;
  }
  state.list_page_index += 1;
  const reachedLimit = Object.keys(state.discovered).length >= state.config.max_products
    || state.list_page_index >= state.config.max_pages;
  const nextUrl = result.next_url;
  if (reachedLimit || !nextUrl || state.visited_list_urls.includes(nextUrl)) {
    prepareProductPhase();
    await checkpoint(`列表读取完成，发现 ${state.product_queue.length} 个商品`);
  } else {
    state.current_list_url = nextUrl;
    await checkpoint(`列表页 ${state.list_page_index} 完成`);
  }
  return true;
}

async function recordProduct(item, extracted) {
  const listing = listingMarket(item.listing_text);
  const market = { ...(extracted.market || {}) };
  for (const key of ["price_text", "sales_text", "price_observed", "sales_observed"]) {
    if ((market[key] == null || market[key] === "") && listing[key] != null && listing[key] !== "") {
      market[key] = listing[key];
    }
  }
  market.listing_observation = listing;
  market.sources = [
    "publicly_displayed_item_detail",
    ...(item.listing_text ? ["publicly_displayed_shop_listing"] : [])
  ];
  const collectedAt = nowIso();
  const htmlKey = rawPageKey(state.run_id, item.item_id);
  await chrome.storage.local.set({ [htmlKey]: extracted.html || "" });
  const images = (extracted.image_candidates || []).map((image) => ({
    source_url: image.url,
    type: image.image_type,
    needs_review: true,
    alt: image.alt || "",
    width: image.width || null,
    height: image.height || null,
    local_path: null,
    sha256: null,
    status: "remote_only",
    error: null
  }));
  state.products.push({
    item_id: item.item_id,
    source_url: item.url,
    collected_at: collectedAt,
    title: extracted.title || "",
    description: extracted.description || "",
    detail_text: extracted.detail_text || "",
    sku_text: extracted.sku_text || "",
    sku: extracted.sku || {},
    attributes_text: extracted.attributes_text || "",
    attributes: extracted.attributes || {},
    market,
    shop: extracted.shop || {},
    image_count: images.length,
    images,
    raw: {
      json_ld: extracted.json_ld || [],
      image_candidates: extracted.image_candidates || [],
      html_key: htmlKey
    },
    training: {
      caption_status: "pending_manual_review",
      image_review_status: "pending_manual_review",
      rights_status: "unknown"
    },
    provenance: {
      response_status: extracted.response_status,
      fetched_url: extracted.fetched_url,
      collection_scope: "publicly_visible_page",
      collector: "chrome_extension"
    }
  });
}

async function runProductStep(reuseLoadedPage) {
  if (state.product_index >= state.product_queue.length) {
    state.status = "completed";
    state.finished_at = nowIso();
    await checkpoint(`采集完成：成功 ${state.products.length}，失败 ${state.failures.length}`);
    return false;
  }
  const item = state.product_queue[state.product_index];
  try {
    const result = await loadAndExtract(item.navigation_url || item.url, "product", reuseLoadedPage);
    if (!result) return false;
    await recordProduct(item, result);
    state.product_index += 1;
    await checkpoint(`商品 ${item.item_id} 采集完成`);
  } catch (error) {
    state.failures.push({
      item_id: item.item_id,
      source_url: item.url,
      collected_at: nowIso(),
      error: error.message
    });
    state.product_index += 1;
    await checkpoint(`商品 ${item.item_id} 失败：${error.message}`);
  }
  return true;
}

async function runLoop({ reuseLoadedPage = false } = {}) {
  if (loopActive) return;
  loopActive = true;
  try {
    let reuse = reuseLoadedPage;
    while (state.status === "running") {
      const shouldContinue = state.phase === "listing"
        ? await runListingStep(reuse)
        : await runProductStep(reuse);
      reuse = false;
      if (!shouldContinue) break;
    }
  } catch (error) {
    state.status = "failed";
    state.finished_at = nowIso();
    await checkpoint(`采集失败：${error.message}`);
  } finally {
    loopActive = false;
  }
}

async function startRun(event) {
  event.preventDefault();
  try {
    const config = readConfig();
    await removeRawPages();
    const directProduct = productFromUrl(config.shop_url);
    state = {
      ...createIdleState(),
      run_id: createRunId(),
      status: "running",
      phase: directProduct ? "products" : "listing",
      started_at: nowIso(),
      config,
      current_list_url: directProduct ? null : config.shop_url,
      discovered: directProduct ? { [directProduct.item_id]: directProduct } : {},
      product_queue: directProduct ? [directProduct] : [],
      message: "准备开始"
    };
    addLog(directProduct ? `创建单商品采集任务：${directProduct.item_id}` : "创建店铺采集任务");
    await persistState();
    render();
    void runLoop();
  } catch (error) {
    state.status = "failed";
    state.message = error.message;
    render();
  }
}

async function stopRun() {
  if (state.status !== "running") return;
  state.status = "stopped";
  state.finished_at = nowIso();
  await checkpoint("用户停止采集");
}

async function continueRun() {
  if (!["needs_user", "paused"].includes(state.status)) return;
  const reuseLoadedPage = state.status === "needs_user";
  state.status = "running";
  await checkpoint(reuseLoadedPage ? "继续读取验证后的页面" : "继续采集任务");
  void runLoop({ reuseLoadedPage });
}

async function focusWorkTab() {
  if (state.work_tab_id == null) return;
  try {
    const tab = await chrome.tabs.update(state.work_tab_id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    state.work_tab_id = null;
    await checkpoint("采集页已关闭");
  }
}

async function exportResults() {
  const products = structuredClone(state.products);
  const htmlKeys = products.map((product) => product.raw?.html_key).filter(Boolean);
  const storedHtml = htmlKeys.length > 0 ? await chrome.storage.local.get(htmlKeys) : {};
  const missingKeys = htmlKeys.filter((key) => typeof storedHtml[key] !== "string");
  if (missingKeys.length > 0) {
    throw new Error(`原始页面数据缺失：${missingKeys.length} 个商品`);
  }
  for (const product of products) {
    const htmlKey = product.raw?.html_key;
    product.raw = { ...(product.raw || {}), html: htmlKey ? storedHtml[htmlKey] : "" };
    delete product.raw.html_key;
  }
  const payload = {
    schema_version: 1,
    generated_at: nowIso(),
    run: {
      run_id: state.run_id,
      status: state.status,
      started_at: state.started_at,
      finished_at: state.finished_at,
      config: state.config,
      list_pages_collected: state.list_page_index,
      products_discovered: Object.keys(state.discovered).length
    },
    products,
    failures: state.failures
  };
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${state.run_id || "taobao-collection"}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function resetRun() {
  if (!confirm("确认清除当前采集状态和未导出的结果？")) return;
  if (state.work_tab_id != null) {
    try {
      await chrome.tabs.remove(state.work_tab_id);
    } catch {
      // The work tab may already be closed.
    }
  }
  state = createIdleState();
  await removeRawPages();
  await chrome.storage.local.remove(STATE_KEY);
  render();
}

elements.form.addEventListener("submit", startRun);
elements.stop.addEventListener("click", () => void stopRun());
elements.continue.addEventListener("click", () => void continueRun());
elements.focus.addEventListener("click", () => void focusWorkTab());
elements.export.addEventListener("click", () => {
  void exportResults().catch((error) => {
    state.message = `导出失败：${error.message}`;
    render();
  });
});
elements.reset.addEventListener("click", () => void resetRun());

state = await loadState();
if (state.status === "running") {
  state.status = "paused";
  addLog("控制台重新打开，任务已暂停");
  await persistState();
}
setFormFromState();
render();

window.addEventListener("beforeunload", () => {
  if (state.status === "running") {
    state.status = "paused";
    state.message = "控制台已关闭，任务暂停";
    chrome.storage.local.set({ [STATE_KEY]: state });
  }
});

window.__TAOBAO_COLLECTOR_CONTROL__ = {
  getState: () => structuredClone(state),
  controlUrl: CONTROL_URL
};
