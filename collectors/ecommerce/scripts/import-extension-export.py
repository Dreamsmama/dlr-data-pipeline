"""Import a Chrome extension export into the collector's existing data layout."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import uuid
from pathlib import Path
from typing import Any

from playwright.async_api import APIRequestContext, async_playwright

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PYTHON_ROOT = PROJECT_ROOT / "python"
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

from collector import download_images, export_csv, init_db, now_iso, save_product


class RequestContextAdapter:
    def __init__(self, request: APIRequestContext) -> None:
        self.request = request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="导入 Chrome 扩展采集结果")
    parser.add_argument("export", type=Path, help="扩展导出的 JSON 文件")
    parser.add_argument("--out", type=Path, default=Path("data/extension/catalog"), help="标准化输出目录")
    parser.add_argument("--skip-images", action="store_true", help="只导入结构化数据，不下载图片")
    parser.add_argument("--max-images", type=int, default=80, help="每个商品最多下载的图片数")
    parser.add_argument(
        "--skip-existing-products",
        action="store_true",
        help="Skip products that already exist in the output database",
    )
    return parser.parse_args([argument for argument in sys.argv[1:] if argument != "--"])


def load_export(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise ValueError("不支持的扩展导出格式")
    if not isinstance(payload.get("products"), list):
        raise ValueError("扩展导出缺少 products 数组")
    return payload


def validate_product(product: Any) -> dict[str, Any]:
    if not isinstance(product, dict):
        raise ValueError("products 中存在非对象条目")
    item_id = str(product.get("item_id", ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", item_id):
        raise ValueError(f"非法 item_id: {item_id!r}")
    source_url = str(product.get("source_url", ""))
    if not re.match(r"^https://[^/]+\.(?:taobao|tmall)\.com/", source_url, re.IGNORECASE):
        raise ValueError(f"非法商品 URL: {source_url!r}")
    if not product.get("collected_at"):
        raise ValueError(f"商品 {item_id} 缺少 collected_at")
    return product


def to_extracted(product: dict[str, Any], max_images: int) -> dict[str, Any]:
    raw = product.get("raw") if isinstance(product.get("raw"), dict) else {}
    images = product.get("images") if isinstance(product.get("images"), list) else []
    candidates = []
    for image in images[:max_images]:
        if not isinstance(image, dict) or not image.get("source_url"):
            continue
        candidates.append(
            {
                "url": image["source_url"],
                "image_type": image.get("type", "unknown"),
                "needs_review": True,
                "alt": image.get("alt", ""),
                "width": image.get("width"),
                "height": image.get("height"),
            }
        )
    return {
        "response_status": (product.get("provenance") or {}).get("response_status"),
        "fetched_url": (product.get("provenance") or {}).get("fetched_url"),
        "title": product.get("title", ""),
        "description": product.get("description", ""),
        "detail_text": product.get("detail_text", ""),
        "sku_text": product.get("sku_text", ""),
        "sku": product.get("sku", {}),
        "attributes_text": product.get("attributes_text", ""),
        "market": product.get("market", {}),
        "shop": product.get("shop", {}),
        "attributes": product.get("attributes", {}),
        "image_candidates": candidates,
        "json_ld": raw.get("json_ld", []),
        "html": raw.get("html", ""),
    }


def remote_only_images(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "source_url": candidate["url"],
            "type": candidate.get("image_type", "unknown"),
            "needs_review": True,
            "alt": candidate.get("alt", ""),
            "width": candidate.get("width"),
            "height": candidate.get("height"),
            "local_path": None,
            "sha256": None,
            "status": "remote_only",
            "error": None,
        }
        for candidate in candidates
    ]


async def import_export(args: argparse.Namespace) -> None:
    if args.max_images < 1 or args.max_images > 200:
        raise ValueError("--max-images 必须在 1 到 200 之间")
    payload = load_export(args.export)
    products = [validate_product(product) for product in payload["products"]]
    out_dir = args.out.resolve()
    db = init_db(out_dir / "catalog.sqlite3")
    if args.skip_existing_products:
        existing_item_ids = {row[0] for row in db.execute("SELECT item_id FROM products")}
        original_count = len(products)
        products = [product for product in products if product["item_id"] not in existing_item_ids]
        print(
            f"Skipping {original_count - len(products)} existing product(s); "
            f"importing {len(products)} new product(s).",
            flush=True,
        )
    run = payload.get("run") if isinstance(payload.get("run"), dict) else {}
    run_id = f"extension-import-{uuid.uuid4().hex}"
    source = str((run.get("config") or {}).get("shop_url") or args.export.resolve())
    db.execute(
        "INSERT INTO collection_runs (run_id, started_at, source, status) VALUES (?, ?, ?, ?)",
        (run_id, now_iso(), source, "running"),
    )
    db.commit()

    try:
        if args.skip_images:
            for product in products:
                extracted = to_extracted(product, args.max_images)
                images = remote_only_images(extracted["image_candidates"])
                save_product(db, out_dir, product["item_id"], product["source_url"], product["collected_at"], extracted, images)
        else:
            async with async_playwright() as playwright:
                request = await playwright.request.new_context(extra_http_headers={"Accept-Language": "zh-CN,zh;q=0.9"})
                adapter = RequestContextAdapter(request)
                try:
                    for product in products:
                        extracted = to_extracted(product, args.max_images)
                        images = await download_images(
                            adapter,
                            extracted["image_candidates"],
                            product["item_id"],
                            out_dir,
                            product["source_url"],
                            product["collected_at"],
                        )
                        save_product(db, out_dir, product["item_id"], product["source_url"], product["collected_at"], extracted, images)
                finally:
                    await request.dispose()
        export_csv(db, out_dir / "training_manifest.csv")
        db.execute(
            "UPDATE collection_runs SET finished_at=?, status=? WHERE run_id=?",
            (now_iso(), "completed", run_id),
        )
        db.commit()
    except Exception as exc:
        db.execute(
            "UPDATE collection_runs SET finished_at=?, status=?, error=? WHERE run_id=?",
            (now_iso(), "failed", str(exc), run_id),
        )
        db.commit()
        raise
    finally:
        db.close()


def main() -> None:
    args = parse_args()
    try:
        asyncio.run(import_export(args))
    except Exception as exc:
        raise SystemExit(f"导入失败: {exc}") from exc


if __name__ == "__main__":
    main()
