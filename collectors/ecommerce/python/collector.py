"""Collect public Taobao/Tmall product pages for image-training dataset preparation.

The collector intentionally stops and records a blocked run when the platform
returns a verification or anti-automation page. It does not bypass access
controls, CAPTCHA, login restrictions, or rate limits.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import hashlib
import io
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urljoin, urlparse, urlunparse

from PIL import Image, UnidentifiedImageError
from playwright.async_api import BrowserContext, Error as PlaywrightError, Page, Response, async_playwright


DEFAULT_WAIT_MS = 2500
DEFAULT_MAX_PAGES = 3
DEFAULT_MAX_PRODUCTS = 200
DEFAULT_MAX_IMAGES = 80
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="采集淘宝/Tmall 公开商品训练资产")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--shop-url", help="店铺分类页或商品列表页 URL")
    source.add_argument("--items-file", type=Path, help="商品 URL 文件，每行一个 URL；支持 txt/csv/json")
    parser.add_argument("--out", type=Path, default=Path("data/python"), help="输出目录")
    parser.add_argument("--storage-state", type=Path, help="Playwright storage state JSON，用于已授权的浏览器会话")
    parser.add_argument("--browser-captures", type=Path, help="已验证浏览器导出的商品图片清单目录")
    parser.add_argument("--executable-path", type=Path, help="使用本机已有 Chromium/Chrome 可执行文件，避免重新下载浏览器")
    parser.add_argument("--headed", action="store_true", help="显示浏览器窗口")
    parser.add_argument("--manual-wait", action="store_true", help="导航到列表页后等待用户手动完成验证")
    parser.add_argument("--max-pages", type=int, default=DEFAULT_MAX_PAGES)
    parser.add_argument("--max-products", type=int, default=DEFAULT_MAX_PRODUCTS)
    parser.add_argument("--max-images", type=int, default=DEFAULT_MAX_IMAGES)
    parser.add_argument("--wait-ms", type=int, default=DEFAULT_WAIT_MS)
    parser.add_argument("--export-csv", type=Path, help="训练图像清单 CSV 路径，默认输出到 out/training_manifest.csv")
    return parser.parse_args()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, value: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalize_url(raw_url: str | None, base_url: str | None = None) -> str | None:
    if not raw_url:
        return None
    value = raw_url.strip()
    if not value or value.startswith(("data:", "blob:", "javascript:")):
        return None
    try:
        parsed = urlparse(urljoin(base_url or "", value))
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return urlunparse(parsed)


def canonical_item_url(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    query = parse_qs(parsed.query)
    item_id = query.get("id", [None])[0]
    if item_id:
        return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", f"id={item_id}", ""))
    return raw_url


def item_id_from_url(item_url: str) -> str:
    parsed = urlparse(item_url)
    item_id = parse_qs(parsed.query).get("id", [None])[0]
    if item_id:
        return item_id
    match = re.search(r"(?:item|detail)[^/]*\/(\d+)", parsed.path, re.IGNORECASE)
    if match:
        return match.group(1)
    return hashlib.sha1(item_url.encode("utf-8")).hexdigest()[:16]


def classify_image(candidate: dict[str, Any]) -> str:
    source_type = str(candidate.get("source_type", ""))
    if source_type in {"main", "sku", "detail", "review", "ui_asset"}:
        return source_type
    value = " ".join(str(candidate.get(key, "")) for key in ("alt", "className", "url")).lower()
    if re.search(r"sku|规格|颜色分类", value):
        return "sku"
    if re.search(r"product_main|headimage|主图", value):
        return "main"
    if re.search(r"review|评价|晒图", value):
        return "review"
    if re.search(r"detail|详情|图文", value):
        return "detail"
    return "unknown"


def is_likely_image(url: str | None) -> bool:
    if not url:
        return False
    return not re.search(
        r"sprite|icon|avatar|logo(?:-|_|\.|/)|loading|placeholder|sns_logo|/s\.gif|"
        r"600000000\d+-\d+-tps-|alicdn\.com/bao/uploaded/i\d?/tfscom/",
        url,
        re.IGNORECASE,
    )


def original_image_url(url: str) -> str:
    """Remove Alibaba CDN rendition suffixes while retaining the original asset path."""
    parsed = urlparse(url)
    if not re.search(r"(?:alicdn|tbcdn)\.com$", parsed.netloc, re.IGNORECASE):
        return url
    name = Path(parsed.path).name
    match = re.match(r"(.+?\.(?:jpe?g|png|gif|webp|avif))(?:_.*)?$", name, re.IGNORECASE)
    if not match:
        return url
    path = parsed.path[: -len(name)] + match.group(1)
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


def image_asset_key(url: str) -> str:
    original = original_image_url(url)
    name = Path(urlparse(original).path).name.lower()
    match = re.search(r"(o1cn.+?\.(?:jpe?g|png|gif|webp|avif))$", name, re.IGNORECASE)
    return match.group(1) if match else original.lower()


def extract_initial_app_context(html: str) -> dict[str, Any]:
    """Parse the page's initial JSON object without executing page scripts."""
    for match in re.finditer(r"\bvar\s+b\s*=\s*", html):
        try:
            value, _ = json.JSONDecoder().raw_decode(html[match.end():])
        except (json.JSONDecodeError, TypeError):
            continue
        if app_res(value if isinstance(value, dict) else {}):
            return value
    return {}


def app_res(app_context: dict[str, Any]) -> dict[str, Any]:
    value = (((app_context or {}).get("loaderData") or {}).get("home") or {}).get("data", {}).get("res", {})
    return value if isinstance(value, dict) else {}


def merge_missing(primary: Any, fallback: Any) -> Any:
    """Recursively fill only missing values so live page data remains authoritative."""
    if isinstance(primary, dict) and isinstance(fallback, dict):
        merged = dict(primary)
        for key, value in fallback.items():
            merged[key] = merge_missing(merged.get(key), value) if key in merged else value
        return merged
    if primary in (None, "", [], {}):
        return fallback
    return primary


def component_data(data: dict[str, Any], key: str) -> dict[str, Any]:
    direct = data.get(key)
    if isinstance(direct, dict) and direct:
        return direct
    nested = (data.get("componentsVO") or {}).get(key)
    return nested if isinstance(nested, dict) else {}


def structured_image_candidates(data: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    item = data.get("item", {}) or {}
    main_images = item.get("images", []) or component_data(data, "headImageVO").get("images", []) or []
    for image_url in main_images:
        result.append(
            {
                "url": image_url,
                "alt": "product_main",
                "className": "structured-product-image",
                "width": None,
                "height": None,
                "source_type": "main",
            }
        )
    for prop in (data.get("skuBase", {}) or {}).get("props", []) or []:
        for value in prop.get("values", []) or []:
            if value.get("image"):
                result.append(
                    {
                        "url": value["image"],
                        "alt": value.get("name", ""),
                        "className": "structured-sku-image",
                        "width": None,
                        "height": None,
                        "source_type": "sku",
                    }
                )
    return result


def extract_sku_data(data: dict[str, Any]) -> dict[str, Any]:
    sku_base = data.get("skuBase", {}) or {}
    sku_core = data.get("skuCore", {}) or {}
    return {
        "properties": sku_base.get("props", []) or [],
        "combinations": sku_base.get("skus", []) or [],
        "inventory_and_prices": sku_core.get("sku2info", {}) or {},
    }


def merge_browser_capture(
    candidates: list[dict[str, Any]], capture_path: Path, item_id: str, base_url: str, max_images: int
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    capture = json.loads(capture_path.read_text(encoding="utf-8"))
    if str(capture.get("item_id", "")) != item_id:
        raise ValueError(f"browser capture item_id mismatch: {capture_path}")
    result = list(candidates)
    seen = {image_asset_key(candidate["url"]) for candidate in result}
    for value in capture.get("images", []):
        source_type = value.get("source_type")
        image_url = normalize_url(value.get("url"), base_url)
        if source_type not in {"main", "sku", "detail"} or not image_url:
            continue
        image_url = original_image_url(image_url)
        asset_key = image_asset_key(image_url)
        if asset_key in seen or not is_likely_image(image_url):
            continue
        width = value.get("width")
        height = value.get("height")
        if source_type != "detail" and width and height and min(width, height) < 256:
            continue
        seen.add(asset_key)
        result.append(
            {
                "url": image_url,
                "alt": value.get("alt", ""),
                "className": "verified-browser-capture",
                "width": width,
                "height": height,
                "source_type": source_type,
                "image_type": source_type,
                "needs_review": True,
            }
        )
        if len(result) >= max_images:
            break
    provenance = {
        "capture_path": str(capture_path),
        "captured_at": capture.get("captured_at"),
        "source_url": capture.get("source_url"),
    }
    return result, provenance


def flatten_attributes(data: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    industry = data.get("plusViewVO", {}).get("industryParamVO", {})
    for entry in industry.get("basicParamList", []) + industry.get("enhanceParamList", []):
        name = entry.get("propertyName") or entry.get("title")
        if name:
            result[name] = entry.get("valueName", "")
    return result


def detect_blocked(response: Response | None, body_text: str, page_url: str) -> str | None:
    headers = response.headers if response else {}
    header_text = " ".join(f"{key}:{value}" for key, value in headers.items()).lower()
    body_sample = body_text[:20000].lower()
    url_text = page_url.lower()
    if "bxpunish" in header_text or "x5secdata" in header_text:
        return "platform_verification_header"
    if re.search(r"验证码|安全验证|滑块验证|访问受限|请完成验证|captcha|robot check", body_sample):
        return "platform_verification_page"
    if "login.taobao.com" in url_text or "login.tmall.com" in url_text:
        return "login_required"
    return None


def find_metric(text: str, patterns: list[str]) -> str:
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1).strip()
    return ""


def parse_observed_number(value: str) -> float | None:
    """Convert common Chinese display units while retaining the raw value separately."""
    if not value:
        return None
    normalized = value.replace(",", "").replace("+", "").strip()
    multiplier = 1
    for suffix, factor in (("亿", 100_000_000), ("万", 10_000), ("千", 1_000), ("百", 100)):
        if normalized.endswith(suffix):
            normalized = normalized[:-1]
            multiplier = factor
            break
    try:
        return float(normalized) * multiplier
    except ValueError:
        return None


def init_db(db_path: Path) -> sqlite3.Connection:
    ensure_dir(db_path.parent)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.executescript(
        """
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS collection_runs (
            run_id TEXT PRIMARY KEY,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            source TEXT NOT NULL,
            status TEXT NOT NULL,
            error TEXT
        );
        CREATE TABLE IF NOT EXISTS products (
            item_id TEXT PRIMARY KEY,
            source_url TEXT NOT NULL,
            fetched_url TEXT,
            collected_at TEXT NOT NULL,
            title TEXT,
            description TEXT,
            detail_text TEXT,
            sku_text TEXT,
            sku_json TEXT NOT NULL DEFAULT '{}',
            attributes_text TEXT,
            market_json TEXT NOT NULL DEFAULT '{}',
            shop_json TEXT NOT NULL DEFAULT '{}',
            attributes_json TEXT NOT NULL DEFAULT '{}',
            image_count INTEGER NOT NULL DEFAULT 0,
            caption_status TEXT NOT NULL,
            image_review_status TEXT NOT NULL,
            rights_status TEXT NOT NULL,
            raw_html_path TEXT,
            raw_json_path TEXT
        );
        CREATE TABLE IF NOT EXISTS product_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id TEXT NOT NULL REFERENCES products(item_id),
            collected_at TEXT NOT NULL,
            source_url TEXT NOT NULL,
            local_path TEXT,
            image_type TEXT NOT NULL,
            needs_review INTEGER NOT NULL,
            alt TEXT,
            width INTEGER,
            height INTEGER,
            sha256 TEXT,
            status TEXT NOT NULL,
            error TEXT
        );
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id TEXT NOT NULL REFERENCES products(item_id),
            collected_at TEXT NOT NULL,
            product_json_path TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_images_item_id ON product_images(item_id);
        CREATE INDEX IF NOT EXISTS idx_snapshots_item_id ON snapshots(item_id);
        """
    )
    columns = {row[1] for row in connection.execute("PRAGMA table_info(products)")}
    if "market_json" not in columns:
        connection.execute("ALTER TABLE products ADD COLUMN market_json TEXT NOT NULL DEFAULT '{}'" )
    if "shop_json" not in columns:
        connection.execute("ALTER TABLE products ADD COLUMN shop_json TEXT NOT NULL DEFAULT '{}'" )
    if "attributes_json" not in columns:
        connection.execute("ALTER TABLE products ADD COLUMN attributes_json TEXT NOT NULL DEFAULT '{}'" )
    if "sku_json" not in columns:
        connection.execute("ALTER TABLE products ADD COLUMN sku_json TEXT NOT NULL DEFAULT '{}'" )
    if "attributes_text" not in columns:
        connection.execute("ALTER TABLE products ADD COLUMN attributes_text TEXT" )
    connection.commit()
    return connection


async def first_text(page: Page, selectors: list[str]) -> str:
    for selector in selectors:
        locator = page.locator(selector).first
        if await locator.count() == 0:
            continue
        value = (await locator.text_content() or "").strip()
        if value:
            return value
    return ""


async def first_attribute(page: Page, selectors: list[str], attribute: str) -> str:
    for selector in selectors:
        locator = page.locator(selector).first
        if await locator.count() == 0:
            continue
        value = (await locator.get_attribute(attribute) or "").strip()
        if value:
            return value
    return ""


async def collect_item_links(page: Page) -> list[dict[str, str]]:
    anchors = await page.locator("a[href]").evaluate_all(
        """anchors => anchors.map(anchor => ({
          href: anchor.href,
          text: (anchor.textContent || '').trim(),
          cardText: (anchor.closest('[data-itemid], [data-id], [class*="item-card" i], [class*="itemCard"], li, article') || anchor.parentElement || anchor).textContent || ''
        }))"""
    )
    result: list[dict[str, str]] = []
    positions: dict[str, int] = {}
    for anchor in anchors:
        href = normalize_url(anchor.get("href"), page.url)
        if not href or not re.search(r"(?:item\.taobao\.com|detail\.tmall\.com)/item\.htm", href, re.IGNORECASE):
            continue
        navigation_url = href
        href = canonical_item_url(href)
        item = {
            "url": href,
            "navigation_url": navigation_url,
            "anchor_text": anchor.get("text", ""),
            "listing_text": re.sub(r"\s+", " ", anchor.get("cardText", "")).strip()[:2000],
        }
        if href not in positions:
            positions[href] = len(result)
            result.append(item)
            continue
        current = result[positions[href]]
        current_score = sum(bool(value) for value in listing_market(current["listing_text"]).values())
        item_score = sum(bool(value) for value in listing_market(item["listing_text"]).values())
        if item_score > current_score:
            result[positions[href]] = item
    return result


def listing_market(text: str) -> dict[str, Any]:
    """Extract only values visibly printed on a shop listing card."""
    price_text = find_metric(text, [r"(?:￥|¥)\s*([0-9]+(?:\.[0-9]+)?)", r"(?:价格|售价)\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)"])
    sales_text = find_metric(text, [r"(?:已售|销量|月销|总销量)\s*[:：]?\s*([0-9.万千百亿+]+)", r"([0-9.万千百亿+]+)\s*(?:人付款|件已售|人已买)"])
    return {
        "listing_text": text,
        "price_text": price_text,
        "sales_text": sales_text,
        "price_observed": parse_observed_number(price_text),
        "sales_observed": parse_observed_number(sales_text),
        "raw_source": "publicly_displayed_shop_listing",
    }


async def find_next_page(page: Page) -> str | None:
    anchors = await page.locator("a[href]").evaluate_all(
        """anchors => anchors.map(anchor => ({
          href: anchor.href,
          text: (anchor.textContent || '').replace(/\\s+/g, '').trim(),
          aria: anchor.getAttribute('aria-label') || ''
        }))"""
    )
    for anchor in anchors:
        if re.search(r"^(下一页|下一頁|next)$", anchor.get("text", ""), re.IGNORECASE) or re.search(
            r"下一页|下一頁|next", anchor.get("aria", ""), re.IGNORECASE
        ):
            return normalize_url(anchor.get("href"), page.url)
    return None


async def extract_item_page(page: Page, item_url: str, wait_ms: int, max_images: int) -> dict[str, Any]:
    response: Response | None = None
    try:
        response = await page.goto(item_url, wait_until="domcontentloaded", timeout=60000)
    except Exception as exc:  # noqa: BLE001 - error is persisted for each product
        return {"error": f"navigation_failed: {exc}", "item_url": item_url}
    await page.wait_for_timeout(wait_ms)
    body_text = await page.locator("body").inner_text(timeout=10000)
    blocked_reason = detect_blocked(response, body_text, page.url)
    if blocked_reason:
        return {"error": blocked_reason, "item_url": item_url, "fetched_url": page.url, "html": await page.content()}

    # The detail section is lazy-loaded. A few bounded scroll steps expose only
    # the page's own product media and keep the request low-frequency.
    detail_tabs = page.get_by_text("图文详情", exact=True)
    clicked_detail_tab = False
    for index in range(await detail_tabs.count()):
        detail_tab = detail_tabs.nth(index)
        if not await detail_tab.is_visible():
            continue
        try:
            await detail_tab.scroll_into_view_if_needed(timeout=3000)
            await detail_tab.click(timeout=3000)
            clicked_detail_tab = True
            await page.wait_for_timeout(wait_ms)
            break
        except PlaywrightError:  # Some layouts render the label as a non-clickable scroll marker.
            continue
    if not clicked_detail_tab:
        await page.evaluate("() => window.scrollTo(0, 0)")
    for _ in range(30):
        at_bottom = await page.evaluate(
            """() => {
              window.scrollBy(0, Math.max(600, window.innerHeight * 0.8));
              return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 10;
            }"""
        )
        await page.wait_for_timeout(250)
        if at_bottom:
            break
    html = await page.content()
    runtime_context = await page.evaluate("() => window.__ICE_APP_CONTEXT__ || null")
    initial_context = extract_initial_app_context(html)
    runtime_res = app_res(runtime_context or {})
    initial_res = app_res(initial_context)
    res = merge_missing(runtime_res, initial_res)
    item_data = res.get("item", {}) or {}
    seller_data = res.get("seller", {}) or {}
    title = item_data.get("title", "")
    title = title or await first_attribute(page, ['meta[property="og:title"]', 'meta[name="twitter:title"]'], "content")
    title = title or await first_text(page, ["h1", '[class*="title" i]', '[class*="Title"]'])
    description = await first_attribute(page, ['meta[property="og:description"]', 'meta[name="description"]'], "content")
    detail_text = await first_text(
        page,
        [
            "#description",
            "#J_DivItemDesc",
            '[class*="descV8" i]',
            '[class*="description-content" i]',
            '[class*="detail-content" i]',
        ],
    )
    sku_text = await first_text(page, ["#J_SKU", '[class*="sku" i]', '[class*="Sku"]'])
    attributes_text = await first_text(
        page,
        ['[class*="parameter" i]', '[class*="attribute" i]', '[class*="property" i]', '[class*="params" i]'],
    )
    dom_price_text = await first_text(page, ['[class*="price" i]', '[class*="Price"]'])
    price_data = component_data(res, "priceVO")
    extra_price = price_data.get("extraPrice", {}) or {}
    main_price = price_data.get("price", {}) or {}
    structured_price_text = " ".join(
        part for part in (
            f"{extra_price.get('priceTitle', '')}￥{extra_price.get('priceText', '')}" if extra_price.get("priceText") else "",
            f"{main_price.get('priceTitle', '')}￥{main_price.get('priceText', '')}" if main_price.get("priceText") else "",
        ) if part
    )
    price_text = structured_price_text or dom_price_text
    rate_data = component_data(res, "rateVO")
    seller_evaluates = seller_data.get("evaluates", []) or []
    market = {
        "price_text": price_text,
        "sales_text": find_metric(body_text, [r"(?:总销量|已售|月销|销量)\s*[:：]?\s*([0-9.万千百亿+]+)\s*(?:件|笔)?"]),
        "review_count_text": find_metric(body_text, [r"(?:累计评价|评价)\s*[:：]?\s*([0-9.万千百亿+]+)"]),
        "rating_text": find_metric(body_text, [r"(?:描述相符|服务态度|物流服务)\s*[:：]?\s*([0-9.]+)"]),
        "favorite_text": find_metric(body_text, [r"(?:收藏人数|收藏)\s*[:：]?\s*([0-9.万千百亿+]+)"]),
        "price_options": {
            "extra_price": extra_price,
            "main_price": main_price,
            "dom_text": dom_price_text,
        },
        "raw_source": "publicly_displayed_text",
    }
    market["sales_text"] = item_data.get("vagueSellCount") or market["sales_text"]
    market["review_count_text"] = rate_data.get("totalCount", "") or market["review_count_text"]
    market["rating_text"] = ", ".join(
        f"{entry.get('title', '')}:{entry.get('score', '')}" for entry in seller_evaluates if entry.get("score")
    ) or market["rating_text"]
    observed_price_text = str(extra_price.get("priceText") or main_price.get("priceText") or price_text)
    price_match = re.search(r"\d+(?:\.\d+)?", observed_price_text)
    market["price_observed"] = float(price_match.group(0)) if price_match else None
    market["sales_observed"] = parse_observed_number(market["sales_text"])
    market["review_count_observed"] = parse_observed_number(market["review_count_text"])
    market["favorite_observed"] = parse_observed_number(market["favorite_text"])
    rating_values = [float(entry["score"]) for entry in seller_evaluates if str(entry.get("score", "")).strip().replace(".", "", 1).isdigit()]
    market["rating_observed"] = round(sum(rating_values) / len(rating_values), 3) if rating_values else parse_observed_number(market["rating_text"])
    market["rating_scope"] = "shop_service_average" if rating_values else "page_displayed_rating"
    images = await page.locator("img").evaluate_all(
        """elements => elements.map(element => {
          const ancestry = [];
          let node = element;
          for (let depth = 0; node && depth < 16; depth += 1, node = node.parentElement) {
            ancestry.push(`${node.id || ''} ${typeof node.className === 'string' ? node.className : ''}`);
          }
          const context = ancestry.join(' ');
          const sourceType = /review|comment|rate|feed/i.test(context) ? 'review' :
            (/detail|description|desc|aplus/i.test(context) ? 'detail' : 'unknown');
          return {
            url: element.getAttribute('data-ks-lazyload') || element.getAttribute('data-lazyload') ||
              element.getAttribute('data-original') || element.getAttribute('data-src') ||
              element.getAttribute('data-lazy-src') || element.currentSrc || element.src || '',
            alt: element.alt || '',
            className: typeof element.className === 'string' ? element.className : '',
            width: element.naturalWidth || null,
            height: element.naturalHeight || null,
            source_type: sourceType
          };
        })"""
    )
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    structured_images = structured_image_candidates(res)
    for candidate in structured_images + images:
        image_url = normalize_url(candidate.get("url"), page.url)
        if not image_url:
            continue
        image_url = original_image_url(image_url)
        asset_key = image_asset_key(image_url)
        if not is_likely_image(image_url) or asset_key in seen:
            continue
        if candidate.get("width") and candidate.get("height") and min(candidate["width"], candidate["height"]) < 256:
            continue
        seen.add(asset_key)
        candidate["url"] = image_url
        candidate["image_type"] = classify_image(candidate)
        if candidate["image_type"] not in {"main", "sku", "detail"}:
            continue
        candidate["needs_review"] = True
        candidates.append(candidate)
        if len(candidates) >= max_images:
            break
    json_ld: list[Any] = []
    for value in await page.locator('script[type="application/ld+json"]').all_text_contents():
        try:
            json_ld.append(json.loads(value))
        except json.JSONDecodeError:
            json_ld.append({"_raw": value})
    return {
        "response_status": response.status if response else None,
        "fetched_url": page.url,
        "title": title,
        "description": description,
        "detail_text": detail_text,
        "sku_text": sku_text,
        "sku": extract_sku_data(res),
        "attributes_text": attributes_text,
        "market": market,
        "shop": {
            "name": seller_data.get("shopName", ""),
            "shop_url": seller_data.get("pcShopUrl", ""),
            "seller_nick": seller_data.get("sellerNick", ""),
            "evaluates": seller_evaluates,
        },
        "attributes": flatten_attributes(res),
        "image_candidates": candidates,
        "json_ld": json_ld,
        "html": html,
    }


def image_extension(content_type: str, source_url: str) -> str:
    content_type = content_type.lower()
    for name, extension in (("png", ".png"), ("webp", ".webp"), ("gif", ".gif"), ("avif", ".avif"), ("jpeg", ".jpg"), ("jpg", ".jpg")):
        if name in content_type:
            return extension
    extension = Path(urlparse(source_url).path).suffix.lower()
    return extension if extension in IMAGE_EXTENSIONS else ".jpg"


async def download_images(
    context: BrowserContext,
    candidates: list[dict[str, Any]],
    item_id: str,
    out_dir: Path,
    source_url: str,
    collected_at: str,
) -> list[dict[str, Any]]:
    image_dir = out_dir / "products" / item_id / "images"
    ensure_dir(image_dir)
    result: list[dict[str, Any]] = []
    hashes: dict[str, str] = {}
    for index, candidate in enumerate(candidates, start=1):
        record: dict[str, Any] = {
            "source_url": candidate["url"],
            "type": candidate["image_type"],
            "needs_review": True,
            "alt": candidate.get("alt", ""),
            "width": candidate.get("width"),
            "height": candidate.get("height"),
            "local_path": None,
            "sha256": None,
            "status": "failed",
            "error": None,
        }
        try:
            response = await context.request.get(
                candidate["url"],
                timeout=30000,
                fail_on_status_code=False,
                headers={"referer": source_url},
            )
            body = await response.body()
            content_type = response.headers.get("content-type", "")
            if not response.ok or not content_type.lower().startswith("image/"):
                record["error"] = f"http_{response.status}_{content_type or 'not_image'}"
                result.append(record)
                continue
            try:
                with Image.open(io.BytesIO(body)) as source_image:
                    record["width"], record["height"] = source_image.size
            except (UnidentifiedImageError, OSError) as exc:
                record["error"] = f"invalid_image: {exc}"
                result.append(record)
                continue
            if min(record["width"], record["height"]) < 256:
                record["status"] = "filtered_small_image"
                result.append(record)
                continue
            digest = hashlib.sha256(body).hexdigest()
            record["sha256"] = digest
            if digest in hashes:
                record["local_path"] = hashes[digest]
                record["status"] = "duplicate"
                result.append(record)
                continue
            file_name = f"{index:03d}_{digest[:12]}{image_extension(content_type, candidate['url'])}"
            local_path = image_dir / file_name
            local_path.write_bytes(body)
            relative_path = local_path.relative_to(out_dir).as_posix()
            hashes[digest] = relative_path
            record["local_path"] = relative_path
            record["status"] = "downloaded"
        except Exception as exc:  # noqa: BLE001 - error is persisted per image
            record["error"] = str(exc)
        result.append(record)
    return result


def load_item_urls(path: Path) -> list[dict[str, str]]:
    raw = path.read_text(encoding="utf-8-sig")
    if path.suffix.lower() == ".json":
        value = json.loads(raw)
        values = value if isinstance(value, list) else value.get("items", [])
        candidates = [item.get("url", "") if isinstance(item, dict) else str(item) for item in values]
    elif path.suffix.lower() == ".csv":
        candidates = [row.get("url", "") for row in csv.DictReader(raw.splitlines())]
    else:
        candidates = raw.splitlines()
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for value in candidates:
        url = normalize_url(value)
        if not url:
            continue
        url = canonical_item_url(url)
        if url not in seen:
            seen.add(url)
            result.append({"url": url, "navigation_url": normalize_url(value) or url, "anchor_text": "items_file"})
    return result


def save_product(
    connection: sqlite3.Connection,
    out_dir: Path,
    item_id: str,
    item_url: str,
    collected_at: str,
    extracted: dict[str, Any],
    images: list[dict[str, Any]],
) -> dict[str, Any]:
    product_dir = out_dir / "products" / item_id
    ensure_dir(product_dir)
    raw_html_path = product_dir / "raw.html"
    raw_json_path = product_dir / "raw.json"
    raw_html_path.write_text(extracted.get("html", ""), encoding="utf-8")
    write_json(
        raw_json_path,
        {
            "item_id": item_id,
            "source_url": item_url,
            "collected_at": collected_at,
            "json_ld": extracted.get("json_ld", []),
            "detail_text": extracted.get("detail_text", ""),
            "sku_text": extracted.get("sku_text", ""),
            "sku": extracted.get("sku", {}),
            "attributes_text": extracted.get("attributes_text", ""),
            "market": extracted.get("market", {}),
            "shop": extracted.get("shop", {}),
            "attributes": extracted.get("attributes", {}),
            "image_candidates": extracted.get("image_candidates", []),
            "browser_capture": extracted.get("browser_capture"),
        },
    )
    product = {
        "item_id": item_id,
        "source_url": item_url,
        "collected_at": collected_at,
        "title": extracted.get("title", ""),
        "description": extracted.get("description", ""),
        "detail_text": extracted.get("detail_text", ""),
        "sku_text": extracted.get("sku_text", ""),
        "sku": extracted.get("sku", {}),
        "attributes_text": extracted.get("attributes_text", ""),
        "market": extracted.get("market", {}),
        "shop": extracted.get("shop", {}),
        "attributes": extracted.get("attributes", {}),
        "image_count": sum(image["status"] in {"downloaded", "duplicate"} for image in images),
        "images": images,
        "training": {
            "caption_status": "pending_manual_review",
            "image_review_status": "pending_manual_review",
            "rights_status": "unknown",
        },
        "provenance": {
            "response_status": extracted.get("response_status"),
            "fetched_url": extracted.get("fetched_url"),
            "collection_scope": "publicly_visible_page",
            "browser_capture": extracted.get("browser_capture"),
        },
    }
    product_json_path = product_dir / "product.json"
    write_json(product_json_path, product)
    snapshot_path = out_dir / "snapshots" / f"{item_id}_{collected_at.replace(':', '-').replace('+', '_')}.json"
    write_json(snapshot_path, product)
    connection.execute(
        """INSERT INTO products
        (item_id, source_url, fetched_url, collected_at, title, description, detail_text, sku_text, sku_json, attributes_text,
         market_json, shop_json, attributes_json, image_count, caption_status, image_review_status, rights_status, raw_html_path, raw_json_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          source_url=excluded.source_url, fetched_url=excluded.fetched_url, collected_at=excluded.collected_at,
          title=excluded.title, description=excluded.description, detail_text=excluded.detail_text,
          sku_text=excluded.sku_text, sku_json=excluded.sku_json, attributes_text=excluded.attributes_text,
          market_json=excluded.market_json, shop_json=excluded.shop_json, attributes_json=excluded.attributes_json, image_count=excluded.image_count, caption_status=excluded.caption_status,
          image_review_status=excluded.image_review_status, rights_status=excluded.rights_status,
          raw_html_path=excluded.raw_html_path, raw_json_path=excluded.raw_json_path""",
        (
            item_id,
            item_url,
            extracted.get("fetched_url"),
            collected_at,
            product["title"],
            product["description"],
            product["detail_text"],
            product["sku_text"],
            json.dumps(product["sku"], ensure_ascii=False),
            product["attributes_text"],
            json.dumps(product["market"], ensure_ascii=False),
            json.dumps(product["shop"], ensure_ascii=False),
            json.dumps(product["attributes"], ensure_ascii=False),
            product["image_count"],
            "pending_manual_review",
            "pending_manual_review",
            "unknown",
            raw_html_path.relative_to(out_dir).as_posix(),
            raw_json_path.relative_to(out_dir).as_posix(),
        ),
    )
    connection.execute("DELETE FROM product_images WHERE item_id = ?", (item_id,))
    for image in images:
        connection.execute(
            """INSERT INTO product_images
            (item_id, collected_at, source_url, local_path, image_type, needs_review, alt, width, height, sha256, status, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                item_id,
                collected_at,
                image["source_url"],
                image["local_path"],
                image["type"],
                int(image["needs_review"]),
                image.get("alt", ""),
                image.get("width"),
                image.get("height"),
                image.get("sha256"),
                image["status"],
                image.get("error"),
            ),
        )
    connection.execute(
        "INSERT INTO snapshots (item_id, collected_at, product_json_path) VALUES (?, ?, ?)",
        (item_id, collected_at, snapshot_path.relative_to(out_dir).as_posix()),
    )
    connection.commit()
    return product


def save_failed_product(connection: sqlite3.Connection, out_dir: Path, item_id: str, item_url: str, collected_at: str, extracted: dict[str, Any]) -> None:
    product_dir = out_dir / "products" / item_id
    ensure_dir(product_dir)
    raw_html_path = product_dir / "raw.html"
    raw_html_path.write_text(extracted.get("html", ""), encoding="utf-8")
    failure = {
        "item_id": item_id,
        "source_url": item_url,
        "collected_at": collected_at,
        "error": extracted.get("error", "unknown"),
        "fetched_url": extracted.get("fetched_url"),
    }
    write_json(product_dir / "product.json", failure)
    connection.execute(
        "INSERT INTO products (item_id, source_url, fetched_url, collected_at, title, description, detail_text, sku_text, market_json, shop_json, attributes_json, image_count, caption_status, image_review_status, rights_status, raw_html_path, raw_json_path) VALUES (?, ?, ?, ?, '', '', '', '', '{}', '{}', '{}', 0, 'blocked', 'blocked', 'unknown', ?, NULL) ON CONFLICT(item_id) DO UPDATE SET collected_at=excluded.collected_at, raw_html_path=excluded.raw_html_path",
        (item_id, item_url, extracted.get("fetched_url"), collected_at, raw_html_path.relative_to(out_dir).as_posix()),
    )
    connection.commit()


def export_csv(connection: sqlite3.Connection, path: Path) -> None:
    ensure_dir(path.parent)
    rows = connection.execute(
        """SELECT p.item_id, p.title, p.description, p.market_json, p.collected_at, p.caption_status,
                  p.image_review_status, p.rights_status, i.local_path, i.image_type,
                  i.needs_review, i.width, i.height, i.sha256, i.status, i.source_url
           FROM products p LEFT JOIN product_images i ON i.item_id = p.item_id
           ORDER BY p.item_id, i.id"""
    ).fetchall()
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(rows[0].keys() if rows else ["item_id", "title", "description", "market_json", "collected_at", "caption_status", "image_review_status", "rights_status", "local_path", "image_type", "needs_review", "width", "height", "sha256", "status", "source_url"])
        writer.writerows([tuple(row) for row in rows])


async def collect(args: argparse.Namespace) -> int:
    if args.max_pages < 1 or args.max_products < 1 or args.max_images < 1 or args.wait_ms < 0:
        raise ValueError("max-pages/max-products/max-images must be positive and wait-ms cannot be negative")
    out_dir = args.out.resolve()
    ensure_dir(out_dir / "products")
    ensure_dir(out_dir / "snapshots")
    db = init_db(out_dir / "catalog.sqlite3")
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    started_at = now_iso()
    source = args.shop_url or str(args.items_file)
    db.execute("INSERT INTO collection_runs (run_id, started_at, source, status) VALUES (?, ?, ?, ?)", (run_id, started_at, source, "running"))
    db.commit()
    discovered: dict[str, dict[str, str]] = {}
    status = "completed"
    error_message = None

    async with async_playwright() as playwright:
        launch_kwargs: dict[str, Any] = {"headless": not args.headed}
        if args.executable_path:
            launch_kwargs["executable_path"] = str(args.executable_path)
        browser = await playwright.chromium.launch(**launch_kwargs)
        context_kwargs: dict[str, Any] = {"locale": "zh-CN", "viewport": {"width": 1440, "height": 1000}}
        if args.storage_state:
            context_kwargs["storage_state"] = str(args.storage_state)
        context = await browser.new_context(**context_kwargs)
        list_page = await context.new_page()
        item_page = await context.new_page()
        try:
            if args.items_file:
                for item in load_item_urls(args.items_file):
                    if len(discovered) >= args.max_products:
                        break
                    discovered[item_id_from_url(item["url"])] = item
                if args.manual_wait and discovered:
                    first_item = next(iter(discovered.values()))
                    await item_page.goto(first_item.get("navigation_url", first_item["url"]), wait_until="domcontentloaded", timeout=60000)
                    await item_page.wait_for_timeout(args.wait_ms)
                    await asyncio.to_thread(input, "请在浏览器中完成验证后按 Enter 继续：")
                    await item_page.reload(wait_until="domcontentloaded", timeout=60000)
                    await item_page.wait_for_timeout(args.wait_ms)
                    await context.storage_state(path=str(out_dir / "storage-state.json"))
            else:
                current_url = args.shop_url
                visited: set[str] = set()
                for page_number in range(args.max_pages):
                    if not current_url or current_url in visited or len(discovered) >= args.max_products:
                        break
                    visited.add(current_url)
                    print(f"[list {page_number + 1}/{args.max_pages}] {current_url}", flush=True)
                    response = None
                    try:
                        response = await list_page.goto(current_url, wait_until="domcontentloaded", timeout=60000)
                        await list_page.wait_for_timeout(args.wait_ms)
                        if args.manual_wait:
                            await asyncio.to_thread(input, "请在浏览器中完成验证后按 Enter 继续：")
                            # The first response can carry the challenge header even after
                            # the user completes verification. Reload and inspect the new
                            # response instead of trusting the pre-verification response.
                            response = await list_page.reload(wait_until="domcontentloaded", timeout=60000)
                            await list_page.wait_for_timeout(args.wait_ms)
                            await context.storage_state(path=str(out_dir / "storage-state.json"))
                    except Exception as exc:  # noqa: BLE001
                        status = "failed"
                        error_message = f"list_navigation_failed: {exc}"
                        break
                    body = await list_page.locator("body").inner_text(timeout=10000)
                    blocked = detect_blocked(response, body, list_page.url)
                    if blocked:
                        status = "blocked"
                        error_message = blocked
                        (out_dir / "list-blocked.html").write_text(await list_page.content(), encoding="utf-8")
                        print(f"list blocked: {blocked}", file=sys.stderr, flush=True)
                        break
                    for item in await collect_item_links(list_page):
                        discovered.setdefault(item_id_from_url(item["url"]), item)
                        if len(discovered) >= args.max_products:
                            break
                    next_url = await find_next_page(list_page)
                    if not next_url:
                        break
                    current_url = next_url

            print(f"Discovered {len(discovered)} product link(s).", flush=True)
            # A challenge page or an external browser action can close the detail
            # tab while leaving the list tab usable. Recreate only that tab.
            if item_page.is_closed():
                item_page = await context.new_page()
            for index, (item_id, item) in enumerate(discovered.items(), start=1):
                if item_page.is_closed():
                    item_page = await context.new_page()
                collected_at = now_iso()
                print(f"[item {index}/{len(discovered)}] {item_id}", flush=True)
                navigation_url = item.get("navigation_url", item["url"])
                extracted = await extract_item_page(item_page, navigation_url, args.wait_ms, args.max_images)
                if extracted.get("error"):
                    save_failed_product(db, out_dir, item_id, item["url"], collected_at, extracted)
                    print(f"  failed: {extracted['error']}", file=sys.stderr, flush=True)
                    continue
                if args.browser_captures:
                    capture_path = args.browser_captures / f"{item_id}.json"
                    if capture_path.is_file():
                        extracted["image_candidates"], extracted["browser_capture"] = merge_browser_capture(
                            extracted["image_candidates"], capture_path, item_id, navigation_url, args.max_images
                        )
                listing = listing_market(item.get("listing_text", ""))
                market = extracted["market"]
                market["detail_observation"] = {
                    key: market.get(key) for key in ("price_text", "sales_text", "price_observed", "sales_observed")
                }
                for key in ("price_text", "price_observed"):
                    if market.get(key) in (None, "") and listing.get(key) not in (None, ""):
                        market[key] = listing[key]
                for key in ("sales_text", "sales_observed"):
                    if listing.get(key) not in (None, ""):
                        market[key] = listing[key]
                market["listing_observation"] = listing
                market["sources"] = [
                    "publicly_displayed_item_detail",
                    *( ["publicly_displayed_shop_listing"] if item.get("listing_text") else [] ),
                ]
                images = await download_images(context, extracted["image_candidates"], item_id, out_dir, navigation_url, collected_at)
                save_product(db, out_dir, item_id, item["url"], collected_at, extracted, images)
            export_csv(db, args.export_csv or out_dir / "training_manifest.csv")
        finally:
            await context.close()
            await browser.close()
    if status == "completed" and not discovered:
        status = "no_product_links"
        error_message = error_message or "no_product_links_found"
    db.execute("UPDATE collection_runs SET finished_at=?, status=?, error=? WHERE run_id=?", (now_iso(), status, error_message, run_id))
    db.commit()
    db.close()
    return 3 if status == "blocked" else 0


def main() -> None:
    args = parse_args()
    try:
        code = asyncio.run(collect(args))
    except Exception as exc:  # noqa: BLE001 - CLI prints a clear failure and exits nonzero
        print(f"采集失败: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    raise SystemExit(code)


if __name__ == "__main__":
    main()
