from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
from contextlib import closing
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    payload = {
        "schema_version": 1,
        "generated_at": "2026-08-21T08:00:00Z",
        "run": {
            "run_id": "run-fixture",
            "status": "completed",
            "config": {"shop_url": "https://fixture.tmall.com/category.htm"},
        },
        "products": [
            {
                "item_id": "10001",
                "source_url": "https://detail.tmall.com/item.htm?id=10001",
                "collected_at": "2026-08-21T08:00:00Z",
                "title": "扩展导入测试商品",
                "description": "测试描述",
                "detail_text": "测试详情",
                "sku_text": "白色",
                "sku": {"properties": [], "combinations": [], "inventory_and_prices": {}},
                "attributes": {"品牌": "测试品牌"},
                "market": {"price_text": "179", "price_observed": 179},
                "shop": {"name": "测试旗舰店"},
                "images": [
                    {
                        "source_url": "https://img.alicdn.com/test-main.jpg",
                        "type": "main",
                        "alt": "product_main",
                        "width": 800,
                        "height": 800,
                    }
                ],
                "raw": {"json_ld": []},
                "provenance": {
                    "fetched_url": "https://detail.tmall.com/item.htm?id=10001",
                    "collector": "chrome_extension",
                },
            }
        ],
        "failures": [],
    }

    with tempfile.TemporaryDirectory(prefix="taobao-import-smoke-") as temp_dir:
        temp = Path(temp_dir)
        export_path = temp / "export.json"
        out_dir = temp / "output"
        export_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        subprocess.run(
            [
                sys.executable,
                str(PROJECT_ROOT / "scripts" / "import-extension-export.py"),
                str(export_path),
                "--out",
                str(out_dir),
                "--skip-images",
            ],
            cwd=PROJECT_ROOT,
            check=True,
        )

        product = json.loads((out_dir / "products" / "10001" / "product.json").read_text(encoding="utf-8"))
        assert product["title"] == "扩展导入测试商品"
        assert product["images"][0]["status"] == "remote_only"
        assert (out_dir / "training_manifest.csv").is_file()
        with closing(sqlite3.connect(out_dir / "catalog.sqlite3")) as connection:
            row = connection.execute("SELECT title, image_count FROM products WHERE item_id = ?", ("10001",)).fetchone()
        assert row == ("扩展导入测试商品", 0)

        payload["products"][0]["title"] = "不应覆盖已有商品"
        export_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        subprocess.run(
            [
                sys.executable,
                str(PROJECT_ROOT / "scripts" / "import-extension-export.py"),
                str(export_path),
                "--out",
                str(out_dir),
                "--skip-images",
                "--skip-existing-products",
            ],
            cwd=PROJECT_ROOT,
            check=True,
        )
        with closing(sqlite3.connect(out_dir / "catalog.sqlite3")) as connection:
            row = connection.execute("SELECT title FROM products WHERE item_id = ?", ("10001",)).fetchone()
            snapshot_count = connection.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]
        assert row == ("扩展导入测试商品",)
        assert snapshot_count == 1

    print("import-export-smoke: ok")


if __name__ == "__main__":
    main()
