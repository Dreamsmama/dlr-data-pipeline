from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sqlite3
import sys
import time
import uuid
from collections import defaultdict, deque
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from PIL import Image, UnidentifiedImageError

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PYTHON_ROOT = PROJECT_ROOT / "python"
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

from collector import export_csv, image_extension, now_iso


RETRYABLE_STATUS_CODES = {420, 429, 500, 502, 503, 504}
SUCCESS_STATUSES = {"downloaded", "duplicate"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Retry failed Alibaba CDN product images")
    parser.add_argument("--out", type=Path, default=Path("data/extension/catalog"))
    parser.add_argument("--wait-ms", type=int, default=2000)
    parser.add_argument("--max-attempts", type=int, default=3)
    parser.add_argument("--timeout-seconds", type=int, default=30)
    return parser.parse_args([argument for argument in sys.argv[1:] if argument != "--"])


def validate_args(args: argparse.Namespace) -> None:
    if not 1000 <= args.wait_ms <= 60000:
        raise ValueError("--wait-ms must be between 1000 and 60000")
    if not 1 <= args.max_attempts <= 10:
        raise ValueError("--max-attempts must be between 1 and 10")
    if not 5 <= args.timeout_seconds <= 120:
        raise ValueError("--timeout-seconds must be between 5 and 120")


def validate_source_url(value: str) -> str:
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not (host == "alicdn.com" or host.endswith(".alicdn.com")):
        raise ValueError(f"Unsupported failed image URL: {value}")
    return value


def fetch_image(url: str, referer: str, timeout_seconds: int) -> tuple[bytes | None, str, int | None, str | None]:
    request = Request(
        url,
        headers={
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Referer": referer,
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
            ),
        },
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            content_type = response.headers.get("content-type", "")
            status = response.status
            body = response.read()
    except HTTPError as exc:
        content_type = exc.headers.get("content-type", "") if exc.headers else ""
        return None, content_type, exc.code, f"http_{exc.code}_{content_type or 'not_image'}"
    except (OSError, URLError) as exc:
        return None, "", None, str(exc)

    if status < 200 or status >= 300 or not content_type.lower().startswith("image/"):
        return None, content_type, status, f"http_{status}_{content_type or 'not_image'}"
    return body, content_type, status, None


def inspect_image(body: bytes) -> tuple[int, int]:
    try:
        with Image.open(io.BytesIO(body)) as image:
            image.load()
            return image.size
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError(f"invalid_image: {exc}") from exc


def update_product_json(connection: sqlite3.Connection, out_dir: Path, item_id: str) -> None:
    product_path = out_dir / "products" / item_id / "product.json"
    if not product_path.is_file():
        raise FileNotFoundError(f"Missing product JSON: {product_path}")
    product = json.loads(product_path.read_text(encoding="utf-8"))
    rows = connection.execute(
        """SELECT source_url, local_path, width, height, sha256, status, error
           FROM product_images WHERE item_id = ? ORDER BY id""",
        (item_id,),
    ).fetchall()
    records_by_url: dict[str, deque[sqlite3.Row]] = defaultdict(deque)
    for row in rows:
        records_by_url[row["source_url"]].append(row)
    for image in product.get("images", []):
        candidates = records_by_url.get(image.get("source_url", ""))
        if not candidates:
            continue
        row = candidates.popleft()
        for field in ("local_path", "width", "height", "sha256", "status", "error"):
            image[field] = row[field]
    product["image_count"] = sum(row["status"] in SUCCESS_STATUSES for row in rows)
    temporary_path = product_path.with_suffix(".json.tmp")
    temporary_path.write_text(json.dumps(product, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary_path.replace(product_path)


def retry_failed_images(args: argparse.Namespace) -> int:
    validate_args(args)
    out_dir = args.out.resolve()
    db_path = out_dir / "catalog.sqlite3"
    if not db_path.is_file():
        raise FileNotFoundError(f"Missing catalog database: {db_path}")

    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    failed_rows = connection.execute(
        """SELECT i.id, i.item_id, i.source_url, p.source_url AS product_url
           FROM product_images i JOIN products p ON p.item_id = i.item_id
           WHERE i.status = 'failed' ORDER BY i.source_url, i.id"""
    ).fetchall()
    if not failed_rows:
        print("No failed image records remain.")
        connection.close()
        return 0

    grouped: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for row in failed_rows:
        grouped[validate_source_url(row["source_url"])].append(row)

    run_id = f"image-retry-{uuid.uuid4().hex}"
    connection.execute(
        "INSERT INTO collection_runs (run_id, started_at, source, status) VALUES (?, ?, ?, ?)",
        (run_id, now_iso(), "retry_failed_images", "running"),
    )
    connection.commit()

    recovered_records = 0
    recovered_urls = 0
    affected_item_ids = {row["item_id"] for row in failed_rows}
    wait_seconds = args.wait_ms / 1000
    try:
        for index, (url, rows) in enumerate(grouped.items(), start=1):
            time.sleep(wait_seconds)
            body = None
            content_type = ""
            error = "retry_failed"
            status_code = None
            for attempt in range(1, args.max_attempts + 1):
                body, content_type, status_code, error = fetch_image(
                    url,
                    rows[0]["product_url"],
                    args.timeout_seconds,
                )
                if body is not None:
                    break
                if attempt == args.max_attempts or status_code not in RETRYABLE_STATUS_CODES:
                    break
                time.sleep(wait_seconds * (2 ** (attempt - 1)))

            if body is None:
                for row in rows:
                    connection.execute(
                        "UPDATE product_images SET error = ? WHERE id = ?",
                        (error, row["id"]),
                    )
                connection.commit()
                print(f"[{index}/{len(grouped)}] failed ({error}): {url}", file=sys.stderr, flush=True)
                continue

            width, height = inspect_image(body)
            digest = hashlib.sha256(body).hexdigest()
            extension = image_extension(content_type, url)
            for row in rows:
                existing = connection.execute(
                    """SELECT local_path FROM product_images
                       WHERE item_id = ? AND sha256 = ? AND local_path IS NOT NULL
                       AND status IN ('downloaded', 'duplicate') LIMIT 1""",
                    (row["item_id"], digest),
                ).fetchone()
                if existing and (out_dir / existing["local_path"]).is_file():
                    local_path = existing["local_path"]
                    image_status = "duplicate"
                else:
                    image_dir = out_dir / "products" / row["item_id"] / "images"
                    image_dir.mkdir(parents=True, exist_ok=True)
                    image_path = image_dir / f"retry_{row['id']:04d}_{digest[:12]}{extension}"
                    image_path.write_bytes(body)
                    local_path = image_path.relative_to(out_dir).as_posix()
                    image_status = "downloaded"
                connection.execute(
                    """UPDATE product_images
                       SET local_path = ?, width = ?, height = ?, sha256 = ?, status = ?, error = NULL
                       WHERE id = ?""",
                    (local_path, width, height, digest, image_status, row["id"]),
                )
                recovered_records += 1
            recovered_urls += 1
            connection.commit()
            print(
                f"[{index}/{len(grouped)}] recovered {len(rows)} record(s): {url}",
                flush=True,
            )

        for item_id in affected_item_ids:
            image_count = connection.execute(
                """SELECT COUNT(*) FROM product_images
                   WHERE item_id = ? AND status IN ('downloaded', 'duplicate')""",
                (item_id,),
            ).fetchone()[0]
            connection.execute("UPDATE products SET image_count = ? WHERE item_id = ?", (image_count, item_id))
            update_product_json(connection, out_dir, item_id)
        export_csv(connection, out_dir / "training_manifest.csv")
        remaining = connection.execute(
            "SELECT COUNT(*) FROM product_images WHERE status = 'failed'"
        ).fetchone()[0]
        run_status = "completed" if remaining == 0 else "partial"
        run_error = None if remaining == 0 else f"{remaining} failed image record(s) remain"
        connection.execute(
            "UPDATE collection_runs SET finished_at = ?, status = ?, error = ? WHERE run_id = ?",
            (now_iso(), run_status, run_error, run_id),
        )
        connection.commit()
    except Exception as exc:
        connection.execute(
            "UPDATE collection_runs SET finished_at = ?, status = ?, error = ? WHERE run_id = ?",
            (now_iso(), "failed", str(exc), run_id),
        )
        connection.commit()
        raise
    finally:
        connection.close()

    print(
        f"Recovered {recovered_records} record(s) from {recovered_urls} unique URL(s); "
        f"{remaining} failed record(s) remain.",
        flush=True,
    )
    return 0 if remaining == 0 else 2


def main() -> None:
    try:
        raise SystemExit(retry_failed_images(parse_args()))
    except Exception as exc:
        raise SystemExit(f"Image retry failed: {exc}") from exc


if __name__ == "__main__":
    main()
