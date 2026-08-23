ALTER TABLE ecommerce_products
  ADD COLUMN IF NOT EXISTS brand TEXT,
  ADD COLUMN IF NOT EXISTS category TEXT;

CREATE INDEX IF NOT EXISTS idx_ecommerce_products_brand
  ON ecommerce_products(brand);
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_category
  ON ecommerce_products(category);

WITH latest_brand AS (
  SELECT DISTINCT ON (platform, item_id)
    platform,
    item_id,
    NULLIF(BTRIM(COALESCE(payload ->> 'brand', payload #>> '{attributes,品牌}')), '') AS brand
  FROM ecommerce_product_observations
  WHERE NULLIF(BTRIM(COALESCE(payload ->> 'brand', payload #>> '{attributes,品牌}')), '') IS NOT NULL
  ORDER BY platform, item_id, collected_at DESC
)
UPDATE ecommerce_products AS product
SET brand = latest_brand.brand
FROM latest_brand
WHERE product.platform = latest_brand.platform
  AND product.item_id = latest_brand.item_id
  AND product.brand IS NULL;

WITH latest_category AS (
  SELECT DISTINCT ON (platform, item_id)
    platform,
    item_id,
    NULLIF(BTRIM(COALESCE(
      payload ->> 'category',
      payload #>> '{attributes,商品分类}',
      payload #>> '{attributes,叶子类目}',
      payload #>> '{attributes,分类}',
      payload #>> '{attributes,遮瑕分类}'
    )), '') AS category
  FROM ecommerce_product_observations
  WHERE NULLIF(BTRIM(COALESCE(
    payload ->> 'category',
    payload #>> '{attributes,商品分类}',
    payload #>> '{attributes,叶子类目}',
    payload #>> '{attributes,分类}',
    payload #>> '{attributes,遮瑕分类}'
  )), '') IS NOT NULL
  ORDER BY platform, item_id, collected_at DESC
)
UPDATE ecommerce_products AS product
SET category = latest_category.category
FROM latest_category
WHERE product.platform = latest_category.platform
  AND product.item_id = latest_category.item_id
  AND product.category IS NULL;

WITH ranked_shop_brands AS (
  SELECT
    payload #>> '{shop,name}' AS shop_name,
    payload #>> '{attributes,品牌}' AS brand,
    ROW_NUMBER() OVER (
      PARTITION BY payload #>> '{shop,name}'
      ORDER BY COUNT(*) DESC, MAX(collected_at) DESC
    ) AS priority
  FROM ecommerce_product_observations
  WHERE NULLIF(BTRIM(payload #>> '{shop,name}'), '') IS NOT NULL
    AND NULLIF(BTRIM(payload #>> '{attributes,品牌}'), '') IS NOT NULL
  GROUP BY payload #>> '{shop,name}', payload #>> '{attributes,品牌}'
)
UPDATE ecommerce_products AS product
SET brand = ranked_shop_brands.brand
FROM ranked_shop_brands
WHERE ranked_shop_brands.priority = 1
  AND product.brand IS NULL
  AND EXISTS (
    SELECT 1
    FROM ecommerce_product_observations AS observation
    WHERE observation.platform = product.platform
      AND observation.item_id = product.item_id
      AND observation.payload #>> '{shop,name}' = ranked_shop_brands.shop_name
  );

UPDATE ecommerce_products
SET category = CASE
  WHEN title ILIKE '%素颜霜%' THEN '素颜霜'
  WHEN title ILIKE '%气垫%' THEN '气垫'
  WHEN title ILIKE '%散粉%' OR title ILIKE '%蜜粉%' THEN '散粉'
  WHEN title ILIKE '%粉底液%' THEN '粉底液'
  WHEN title ILIKE '%隔离%' THEN '隔离霜'
  WHEN title ILIKE '%遮瑕%' THEN '遮瑕'
  WHEN title ILIKE '%口红%' OR title ILIKE '%唇釉%' THEN '唇妆'
  WHEN title ILIKE '%眼影%' THEN '眼影'
  WHEN title ILIKE '%睫毛膏%' THEN '睫毛膏'
  ELSE category
END
WHERE category IS NULL;
