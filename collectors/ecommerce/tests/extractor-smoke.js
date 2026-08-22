import assert from "node:assert/strict";
import { chromium } from "playwright";

import { extractPageInTab } from "../extension/extractor.js";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();

  await page.setContent(`
    <!doctype html>
    <html>
      <body>
        <article class="item-card">
          <a href="https://detail.tmall.com/item.htm?id=10001&spm=test">商品 A</a>
          <span>￥179 月销1.2万</span>
        </article>
        <a href="https://detail.tmall.com/item.htm?id=10001&from=duplicate">重复链接</a>
        <article class="item-card">
          <a href="https://item.taobao.com/item.htm?id=10002">商品 B</a>
        </article>
        <a aria-label="下一页" href="https://shop.example.tmall.com/category.htm?pageNo=2">下一页</a>
      </body>
    </html>
  `);
  const listing = await page.evaluate(extractPageInTab, { mode: "list" });
  assert.equal(listing.items.length, 2);
  assert.equal(listing.items[0].item_id, "10001");
  assert.equal(listing.items[0].url, "https://detail.tmall.com/item.htm?id=10001");
  assert.equal(listing.items[0].navigation_url, "https://detail.tmall.com/item.htm?id=10001&spm=test");
  assert.equal(listing.next_url, "https://shop.example.tmall.com/category.htm?pageNo=2");

  await page.setContent(`
    <!doctype html>
    <html>
      <head>
        <meta name="description" content="测试商品描述">
        <script>
          var b = {
            "loaderData": {
              "home": {
                "data": {
                  "res": {
                    "item": { "images": ["https://img.alicdn.com/test-main.jpg"] },
                    "seller": {
                      "shopName": "测试旗舰店",
                      "sellerNick": "测试旗舰店",
                      "pcShopUrl": "//shop.example.taobao.com",
                      "evaluates": [{ "title": "宝贝描述", "score": "4.9" }]
                    },
                    "skuBase": {
                      "props": [{ "name": "颜色", "values": [{ "name": "白色", "image": "https://img.alicdn.com/test-sku.jpg" }] }],
                      "skus": [{ "skuId": "sku-1" }]
                    },
                    "skuCore": { "sku2info": { "sku-1": { "quantity": 8 } } },
                    "componentsVO": {
                      "rateVO": { "totalCount": "321" },
                      "priceVO": { "price": { "priceTitle": "售价", "priceText": "179" } }
                    },
                    "plusViewVO": {
                      "industryParamVO": {
                        "basicParamList": [{ "propertyName": "品牌", "valueName": "测试品牌" }],
                        "enhanceParamList": []
                      }
                    }
                  }
                }
              }
            }
          };
        </script>
        <script>
          window.__ICE_APP_CONTEXT__ = {
            loaderData: {
              home: {
                data: {
                  res: {
                    item: {
                      title: "测试商品",
                      vagueSellCount: "1.2万"
                    }
                  }
                }
              }
            }
          };
        </script>
      </head>
      <body>
        <h1>备用标题</h1>
        <section class="sku-panel">白色 黑色</section>
        <section class="detail-description">图文详情内容</section>
        <div>总销量 1.2万 累计评价 321 收藏 45</div>
      </body>
    </html>
  `);
  const product = await page.evaluate(extractPageInTab, {
    mode: "product",
    maxImages: 10,
    scrollDelayMs: 100
  });
  assert.equal(product.title, "测试商品");
  assert.equal(product.shop.name, "测试旗舰店");
  assert.equal(product.market.price_observed, 179);
  assert.equal(product.market.sales_observed, 12000);
  assert.equal(product.market.review_count_observed, 321);
  assert.equal(product.attributes["品牌"], "测试品牌");
  assert.equal(product.image_candidates.length, 2);
  assert.equal(product.image_candidates[0].image_type, "main");
  assert.equal(product.image_candidates[1].image_type, "sku");
  assert.match(product.html, /detail-description/);

  await page.setContent("<html><body>请完成安全验证</body></html>");
  const blocked = await page.evaluate(extractPageInTab, { mode: "product" });
  assert.equal(blocked.error, "platform_verification_page");

  console.log("extractor-smoke: ok");
} finally {
  await browser.close();
}
