import unittest
import json
import sys
import tempfile
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PACKAGE_ROOT / "python"))

import collector


SAMPLE_HTML = PACKAGE_ROOT / "tests" / "fixtures" / "tmall-product.html"


class CollectorParsingTests(unittest.TestCase):
    def test_initial_context_recovers_nested_detail_data(self) -> None:
        context = collector.extract_initial_app_context(SAMPLE_HTML.read_text(encoding="utf-8"))
        data = collector.app_res(context)

        self.assertEqual(data["item"]["itemId"], "844862758814")
        self.assertEqual(collector.component_data(data, "priceVO")["price"]["priceText"], "179")
        self.assertEqual(collector.component_data(data, "rateVO")["totalCount"], "9000+")

    def test_structured_images_have_stable_source_types(self) -> None:
        context = collector.extract_initial_app_context(SAMPLE_HTML.read_text(encoding="utf-8"))
        images = collector.structured_image_candidates(collector.app_res(context))

        self.assertGreaterEqual(sum(image["source_type"] == "main" for image in images), 3)
        self.assertGreaterEqual(sum(image["source_type"] == "sku" for image in images), 10)

    def test_listing_market_keeps_raw_and_normalized_sales(self) -> None:
        market = collector.listing_market("超值气垫 ￥139 总销量 10万+")

        self.assertEqual(market["price_text"], "139")
        self.assertEqual(market["sales_text"], "10万+")
        self.assertEqual(market["sales_observed"], 100_000)

    def test_alicdn_renditions_share_one_asset_key(self) -> None:
        original = "https://gw.alicdn.com/bao/uploaded/i2/O1CNabc_!!123.jpg"
        rendition = "https://gw.alicdn.com/bao/uploaded/i2/O1CNabc_!!123.jpg_q50.jpg_.webp"

        self.assertEqual(collector.original_image_url(rendition), original)
        self.assertEqual(collector.image_asset_key(rendition), collector.image_asset_key(original))

    def test_browser_capture_adds_detail_and_filters_small_ui_asset(self) -> None:
        capture = {
            "item_id": "123",
            "images": [
                {"url": "//img.alicdn.com/imgextra/detail.jpg", "source_type": "detail", "width": 1, "height": 1},
                {"url": "//img.alicdn.com/imgextra/icon.png", "source_type": "main", "width": 56, "height": 56},
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "123.json"
            path.write_text(json.dumps(capture), encoding="utf-8")
            images, _ = collector.merge_browser_capture([], path, "123", "https://detail.tmall.com/item.htm?id=123", 80)

        self.assertEqual(len(images), 1)
        self.assertEqual(images[0]["source_type"], "detail")

    def test_item_file_preserves_navigation_parameters(self) -> None:
        full_url = "https://detail.tmall.com/item.htm?id=123&mi_id=public-page-token&rn=abc"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "items.txt"
            path.write_text(full_url, encoding="utf-8")
            item = collector.load_item_urls(path)[0]

        self.assertEqual(item["url"], "https://detail.tmall.com/item.htm?id=123")
        self.assertEqual(item["navigation_url"], full_url)


if __name__ == "__main__":
    unittest.main()
