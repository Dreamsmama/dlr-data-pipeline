export async function extractPageInTab(options) {
  const mode = options?.mode === "list" ? "list" : "product";
  const maxImages = Math.max(1, Math.min(Number(options?.maxImages) || 80, 200));
  const scrollDelayMs = Math.max(100, Math.min(Number(options?.scrollDelayMs) || 800, 3000));

  const cleanText = (value, limit = 100000) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);

  const normalizeUrl = (rawUrl, baseUrl = location.href) => {
    if (!rawUrl || /^(?:data|blob|javascript):/i.test(rawUrl)) return null;
    try {
      const url = new URL(rawUrl, baseUrl);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };

  const canonicalItemUrl = (rawUrl) => {
    const url = new URL(rawUrl);
    const itemId = url.searchParams.get("id");
    if (!itemId) return url.href;
    url.search = `?id=${encodeURIComponent(itemId)}`;
    url.hash = "";
    return url.href;
  };

  const itemIdFromUrl = (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      return url.searchParams.get("id") || url.pathname.match(/(?:item|detail)[^/]*\/(\d+)/i)?.[1] || "";
    } catch {
      return "";
    }
  };

  const detectBlocked = (bodyText, pageUrl) => {
    const text = bodyText.slice(0, 30000).toLowerCase();
    const url = pageUrl.toLowerCase();
    if (/login\.(?:taobao|tmall)\.com/.test(url)) return "login_required";
    if (/bxpunish|x5sec/.test(url)) return "platform_verification_page";
    if (/验证码|安全验证|滑块验证|访问受限|请完成验证|captcha|robot check/i.test(text)) {
      return "platform_verification_page";
    }
    return null;
  };

  const findMetric = (text, patterns) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return cleanText(match[1], 200);
    }
    return "";
  };

  const parseObservedNumber = (rawValue) => {
    let value = String(rawValue || "").replace(/[,+]/g, "").trim();
    if (!value) return null;
    const units = { "亿": 100000000, "万": 10000, "千": 1000, "百": 100 };
    let multiplier = 1;
    const suffix = value.slice(-1);
    if (units[suffix]) {
      value = value.slice(0, -1);
      multiplier = units[suffix];
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed * multiplier : null;
  };

  const blockedReason = detectBlocked(document.body?.innerText || "", location.href);
  if (blockedReason) {
    return {
      mode,
      error: blockedReason,
      fetched_url: location.href,
      page_title: document.title
    };
  }

  if (mode === "list") {
    const links = [];
    const seen = new Set();
    for (const anchor of document.querySelectorAll("a[href]")) {
      const normalized = normalizeUrl(anchor.href);
      if (!normalized || !/(?:item\.taobao\.com|detail\.tmall\.com)\/item\.htm/i.test(normalized)) continue;
      const canonical = canonicalItemUrl(normalized);
      const itemId = itemIdFromUrl(canonical);
      if (!itemId || seen.has(itemId)) continue;
      seen.add(itemId);
      const card = anchor.closest('[class*="item" i], [class*="card" i], li, article') || anchor.parentElement || anchor;
      links.push({
        item_id: itemId,
        url: canonical,
        anchor_text: cleanText(anchor.textContent, 1000),
        listing_text: cleanText(card.textContent, 3000)
      });
    }

    let nextUrl = null;
    for (const anchor of document.querySelectorAll("a[href]")) {
      const text = cleanText(anchor.textContent, 100).replace(/\s+/g, "");
      const aria = anchor.getAttribute("aria-label") || "";
      if (/^(?:下一页|下一頁|next)$/i.test(text) || /下一页|下一頁|next/i.test(aria)) {
        nextUrl = normalizeUrl(anchor.href);
        if (nextUrl) break;
      }
    }

    return {
      mode,
      fetched_url: location.href,
      page_title: document.title,
      items: links,
      next_url: nextUrl
    };
  }

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  for (const fraction of [0.35, 0.7, 1]) {
    window.scrollTo(0, Math.max(0, document.body.scrollHeight * fraction));
    await wait(scrollDelayMs);
  }

  const firstText = (selectors, limit = 100000) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = cleanText(element?.textContent, limit);
      if (value) return value;
    }
    return "";
  };

  const firstAttribute = (selectors, attribute) => {
    for (const selector of selectors) {
      const value = cleanText(document.querySelector(selector)?.getAttribute(attribute), 10000);
      if (value) return value;
    }
    return "";
  };

  const extractAssignedObject = () => {
    const html = document.documentElement.outerHTML;
    const assignment = /\bvar\s+b\s*=\s*/g.exec(html);
    if (!assignment) return {};
    const start = html.indexOf("{", assignment.index + assignment[0].length);
    if (start < 0) return {};
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let index = start; index < html.length; index += 1) {
      const character = html[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, index + 1));
          } catch {
            return {};
          }
        }
      }
    }
    return {};
  };

  const appRes = (context) => context?.loaderData?.home?.data?.res || {};
  const runtimeRes = appRes(window.__ICE_APP_CONTEXT__ || {});
  const initialRes = appRes(extractAssignedObject());
  const mergeMissing = (primary, fallback) => {
    if (primary && fallback && typeof primary === "object" && typeof fallback === "object"
      && !Array.isArray(primary) && !Array.isArray(fallback)) {
      const merged = { ...primary };
      for (const [key, value] of Object.entries(fallback)) {
        merged[key] = key in merged ? mergeMissing(merged[key], value) : value;
      }
      return merged;
    }
    if (primary == null || primary === "" || (Array.isArray(primary) && primary.length === 0)) return fallback;
    return primary;
  };
  const res = mergeMissing(runtimeRes, initialRes);
  const componentData = (key) => res?.[key] || res?.componentsVO?.[key] || {};
  const item = res?.item || {};
  const seller = res?.seller || {};
  const rate = componentData("rateVO");
  const price = componentData("priceVO");
  const sellerEvaluates = Array.isArray(seller.evaluates) ? seller.evaluates : [];
  const bodyText = cleanText(document.body?.innerText, 500000);

  let title = cleanText(item.title, 10000);
  title ||= firstAttribute(['meta[property="og:title"]', 'meta[name="twitter:title"]'], "content");
  title ||= firstText(["h1", '[class*="title" i]'], 10000);
  const description = firstAttribute(['meta[property="og:description"]', 'meta[name="description"]'], "content");
  const detailText = firstText(["#description", "#J_DivItemDesc", '[id*="description" i]', '[class*="detail" i]', '[class*="desc" i]']);
  const skuText = firstText(["#J_SKU", '[class*="sku" i]']);
  const attributesText = firstText(['[class*="parameter" i]', '[class*="attribute" i]', '[class*="property" i]', '[class*="params" i]']);
  let priceText = firstText(['[class*="price" i]'], 5000);
  const priceParts = [price.extraPrice, price.price]
    .filter((entry) => entry?.priceText)
    .map((entry) => `${entry.priceTitle || ""}￥${entry.priceText}`);
  priceText ||= priceParts.join(" ");

  const market = {
    price_text: priceText,
    sales_text: cleanText(item.vagueSellCount, 200) || findMetric(bodyText, [/(?:总销量|已售|月销|销量)\s*[:：]?\s*([0-9.万千百亿+]+)\s*(?:件|笔)?/i]),
    review_count_text: cleanText(rate.totalCount, 200) || findMetric(bodyText, [/(?:累计评价|评价)\s*[:：]?\s*([0-9.万千百亿+]+)/i]),
    rating_text: sellerEvaluates.filter((entry) => entry?.score).map((entry) => `${entry.title || ""}:${entry.score}`).join(", "),
    favorite_text: findMetric(bodyText, [/(?:收藏人数|收藏)\s*[:：]?\s*([0-9.万千百亿+]+)/i]),
    raw_source: "publicly_displayed_page"
  };
  const priceMatch = market.price_text.match(/\d+(?:\.\d+)?/);
  market.price_observed = priceMatch ? Number(priceMatch[0]) : null;
  market.sales_observed = parseObservedNumber(market.sales_text);
  market.review_count_observed = parseObservedNumber(market.review_count_text);
  market.favorite_observed = parseObservedNumber(market.favorite_text);

  const attributes = {};
  const industry = res?.plusViewVO?.industryParamVO || {};
  for (const entry of [...(industry.basicParamList || []), ...(industry.enhanceParamList || [])]) {
    const name = entry?.propertyName || entry?.title;
    if (name) attributes[name] = entry.valueName || "";
  }

  const candidates = [];
  const seenImages = new Set();
  const classifyImage = (candidate) => {
    if (["main", "sku", "detail", "review"].includes(candidate.source_type)) return candidate.source_type;
    const text = `${candidate.alt || ""} ${candidate.className || ""} ${candidate.url || ""}`.toLowerCase();
    if (/sku|规格|颜色分类/.test(text)) return "sku";
    if (/product_main|headimage|主图/.test(text)) return "main";
    if (/review|评价|晒图/.test(text)) return "review";
    if (/detail|详情|图文/.test(text)) return "detail";
    return "unknown";
  };
  const addImage = (candidate) => {
    const url = normalizeUrl(candidate.url);
    if (!url || seenImages.has(url) || /sprite|icon|avatar|logo|loading|placeholder|\/s\.gif/i.test(url)) return;
    if (candidate.width && candidate.height && Math.min(candidate.width, candidate.height) < 256) return;
    const imageType = classifyImage({ ...candidate, url });
    if (!["main", "sku", "detail"].includes(imageType)) return;
    seenImages.add(url);
    candidates.push({
      url,
      alt: cleanText(candidate.alt, 1000),
      class_name: cleanText(candidate.className, 1000),
      width: candidate.width || null,
      height: candidate.height || null,
      image_type: imageType,
      needs_review: true
    });
  };

  const mainImages = item.images || componentData("headImageVO").images || [];
  for (const url of mainImages) addImage({ url, alt: "product_main", source_type: "main" });
  for (const property of res?.skuBase?.props || []) {
    for (const value of property?.values || []) {
      if (value?.image) addImage({ url: value.image, alt: value.name, source_type: "sku" });
    }
  }
  for (const image of document.images) {
    const ancestry = [];
    let node = image;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      ancestry.push(`${node.id || ""} ${typeof node.className === "string" ? node.className : ""}`);
    }
    const context = ancestry.join(" ");
    const sourceType = /review|comment|rate|feed/i.test(context)
      ? "review"
      : (/detail|description|desc|aplus/i.test(context) ? "detail" : "unknown");
    addImage({
      url: image.currentSrc || image.src || image.dataset.src || image.dataset.lazySrc,
      alt: image.alt,
      className: typeof image.className === "string" ? image.className : "",
      width: image.naturalWidth || null,
      height: image.naturalHeight || null,
      source_type: sourceType
    });
    if (candidates.length >= maxImages) break;
  }

  const jsonLd = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      jsonLd.push(JSON.parse(script.textContent || "null"));
    } catch {
      jsonLd.push({ _raw: cleanText(script.textContent, 50000) });
    }
  }

  const safeValue = (value, fallback) => {
    try {
      return JSON.parse(JSON.stringify(value ?? fallback));
    } catch {
      return fallback;
    }
  };

  return {
    mode,
    response_status: null,
    fetched_url: location.href,
    page_title: document.title,
    title,
    description,
    detail_text: detailText,
    sku_text: skuText,
    sku: {
      properties: safeValue(res?.skuBase?.props, []),
      combinations: safeValue(res?.skuBase?.skus, []),
      inventory_and_prices: safeValue(res?.skuCore?.sku2info, {})
    },
    attributes_text: attributesText,
    attributes,
    market,
    shop: {
      name: cleanText(seller.shopName, 1000),
      shop_url: cleanText(seller.pcShopUrl, 5000),
      seller_nick: cleanText(seller.sellerNick, 1000),
      evaluates: safeValue(sellerEvaluates, [])
    },
    image_candidates: candidates.slice(0, maxImages),
    json_ld: jsonLd
  };
}
