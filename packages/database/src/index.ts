import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type Pool as PoolType, type PoolClient } from "pg";
import { deriveEcommerceClassification } from "@dlr/schemas";
import type { EcommerceClassification, EcommerceImportBatchInput, EcommerceImportResult } from "@dlr/schemas";

const { Pool } = pg;
const MIGRATION_LOCK = "dlr-data-pipeline-migrations";

export type DatabasePool = PoolType;

export function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
}

export function createDatabasePool(databaseUrl = requireDatabaseUrl()): DatabasePool {
  return new Pool({ connectionString: databaseUrl });
}

export async function runMigrations(
  pool: DatabasePool,
  migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url)),
): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      sha256 CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const names = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    for (const name of names) {
      const sql = await readFile(resolve(migrationsDirectory, name), "utf8");
      const sha256 = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ sha256: string }>(
        "SELECT sha256 FROM schema_migrations WHERE name = $1",
        [name],
      );
      if (existing.rowCount) {
        if (existing.rows[0]?.sha256 !== sha256) {
          throw new Error(`Applied migration ${name} has changed`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [name, sha256]);
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
  return applied;
}

async function writeBatch(client: PoolClient, input: EcommerceImportBatchInput): Promise<void> {
  await client.query(
    `INSERT INTO ecommerce_import_batches
      (batch_id, platform, source_datasets, status, counts)
     VALUES ($1, $2, $3, 'running', $4::jsonb)
     ON CONFLICT (batch_id) DO UPDATE SET
       source_datasets = EXCLUDED.source_datasets,
       status = 'running', counts = EXCLUDED.counts, error = NULL,
       started_at = NOW(), finished_at = NULL`,
    [input.batchId, input.platform, input.sourceDatasets, JSON.stringify(input.counts)],
  );

  const classificationByProduct = new Map<string, EcommerceClassification & { collectedAt: string }>();
  const brandsByShop = new Map<string, string>();
  for (const observation of input.observations) {
    const classification = deriveEcommerceClassification(observation.payload);
    if (classification.shop && classification.brand) brandsByShop.set(classification.shop, classification.brand);
    const key = `${observation.platform}\0${observation.itemId}`;
    const current = classificationByProduct.get(key);
    if (!current || Date.parse(observation.collectedAt) >= Date.parse(current.collectedAt)) {
      classificationByProduct.set(key, {
        brand: classification.brand ?? current?.brand,
        category: classification.category ?? current?.category,
        shop: classification.shop ?? current?.shop,
        collectedAt: observation.collectedAt,
      });
    } else {
      current.brand ??= classification.brand;
      current.category ??= classification.category;
      current.shop ??= classification.shop;
    }
  }

  for (const product of input.products) {
    const classification = classificationByProduct.get(`${product.platform}\0${product.itemId}`);
    const brand = product.brand ?? classification?.brand
      ?? (classification?.shop ? brandsByShop.get(classification.shop) : undefined);
    const category = product.category ?? classification?.category;
    await client.query(
      `INSERT INTO ecommerce_products
        (platform, item_id, source_url, title, latest_collected_at, brand, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (platform, item_id) DO UPDATE SET
         source_url = CASE WHEN EXCLUDED.latest_collected_at >= ecommerce_products.latest_collected_at
           THEN EXCLUDED.source_url ELSE ecommerce_products.source_url END,
         title = CASE WHEN EXCLUDED.latest_collected_at >= ecommerce_products.latest_collected_at
           AND EXCLUDED.title <> '' THEN EXCLUDED.title ELSE ecommerce_products.title END,
         brand = COALESCE(NULLIF(EXCLUDED.brand, ''), ecommerce_products.brand),
         category = COALESCE(NULLIF(EXCLUDED.category, ''), ecommerce_products.category),
         latest_collected_at = GREATEST(ecommerce_products.latest_collected_at, EXCLUDED.latest_collected_at),
         updated_at = NOW()`,
      [
        product.platform,
        product.itemId,
        product.sourceUrl,
        product.title,
        product.latestCollectedAt,
        brand ?? null,
        category ?? null,
      ],
    );
  }

  for (const observation of input.observations) {
    await client.query(
      `INSERT INTO ecommerce_product_observations
        (observation_id, platform, item_id, source_dataset, collected_at, payload,
         raw_product_object_key, raw_json_object_key, raw_html_object_key,
         first_imported_batch_id, last_imported_batch_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $10)
       ON CONFLICT (observation_id) DO UPDATE SET
         payload = EXCLUDED.payload,
         raw_product_object_key = EXCLUDED.raw_product_object_key,
         raw_json_object_key = EXCLUDED.raw_json_object_key,
         raw_html_object_key = EXCLUDED.raw_html_object_key,
         last_imported_batch_id = EXCLUDED.last_imported_batch_id`,
      [
        observation.observationId,
        observation.platform,
        observation.itemId,
        observation.sourceDataset,
        observation.collectedAt,
        JSON.stringify(observation.payload),
        observation.rawProductObjectKey ?? null,
        observation.rawJsonObjectKey ?? null,
        observation.rawHtmlObjectKey ?? null,
        input.batchId,
      ],
    );
  }

  for (const asset of input.assets) {
    await client.query(
      `INSERT INTO ecommerce_assets (sha256, object_key, byte_size, content_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (sha256) DO UPDATE SET
         object_key = EXCLUDED.object_key,
         byte_size = EXCLUDED.byte_size,
         content_type = EXCLUDED.content_type`,
      [asset.sha256, asset.objectKey, asset.byteSize, asset.contentType],
    );
  }

  for (const relation of input.productAssets) {
    await client.query(
      `INSERT INTO ecommerce_product_assets
        (platform, item_id, asset_sha256, source_datasets, image_types, source_urls,
         first_collected_at, last_collected_at, needs_review, last_imported_batch_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
       ON CONFLICT (platform, item_id, asset_sha256) DO UPDATE SET
         source_datasets = ARRAY(
           SELECT DISTINCT unnest(ecommerce_product_assets.source_datasets || EXCLUDED.source_datasets)
         ),
         image_types = ARRAY(
           SELECT DISTINCT unnest(ecommerce_product_assets.image_types || EXCLUDED.image_types)
         ),
         source_urls = (
           SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
           FROM jsonb_array_elements(ecommerce_product_assets.source_urls || EXCLUDED.source_urls) AS urls(value)
         ),
         first_collected_at = LEAST(ecommerce_product_assets.first_collected_at, EXCLUDED.first_collected_at),
         last_collected_at = GREATEST(ecommerce_product_assets.last_collected_at, EXCLUDED.last_collected_at),
         needs_review = ecommerce_product_assets.needs_review OR EXCLUDED.needs_review,
         last_imported_batch_id = EXCLUDED.last_imported_batch_id`,
      [
        relation.platform,
        relation.itemId,
        relation.sha256,
        relation.sourceDatasets,
        relation.imageTypes,
        JSON.stringify(relation.sourceUrls),
        relation.firstCollectedAt,
        relation.lastCollectedAt,
        relation.needsReview,
        input.batchId,
      ],
    );
  }

  for (const image of input.imageObservations) {
    await client.query(
      `INSERT INTO ecommerce_image_observations
        (observation_id, position, asset_sha256, source_url, image_type, local_path,
         needs_review, alt, width, height, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (observation_id, position) DO UPDATE SET
         asset_sha256 = EXCLUDED.asset_sha256,
         source_url = EXCLUDED.source_url,
         image_type = EXCLUDED.image_type,
         local_path = EXCLUDED.local_path,
         needs_review = EXCLUDED.needs_review,
         alt = EXCLUDED.alt,
         width = EXCLUDED.width,
         height = EXCLUDED.height,
         status = EXCLUDED.status`,
      [
        image.observationId,
        image.position,
        image.sha256,
        image.sourceUrl,
        image.imageType,
        image.localPath,
        image.needsReview,
        image.alt,
        image.width ?? null,
        image.height ?? null,
        image.status,
      ],
    );
  }

  for (const raw of input.rawObjects) {
    await client.query(
      `INSERT INTO ecommerce_raw_objects
        (source_dataset, item_id, kind, relative_path, sha256, object_key, byte_size,
         content_type, first_imported_batch_id, last_imported_batch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT (source_dataset, relative_path, sha256) DO UPDATE SET
         object_key = EXCLUDED.object_key,
         byte_size = EXCLUDED.byte_size,
         content_type = EXCLUDED.content_type,
         last_imported_batch_id = EXCLUDED.last_imported_batch_id`,
      [
        raw.sourceDataset,
        raw.itemId,
        raw.kind,
        raw.relativePath,
        raw.sha256,
        raw.objectKey,
        raw.byteSize,
        raw.contentType,
        input.batchId,
      ],
    );
  }

  await client.query(
    `UPDATE ecommerce_import_batches
     SET status = 'completed', counts = $2::jsonb, finished_at = NOW()
     WHERE batch_id = $1`,
    [input.batchId, JSON.stringify(input.counts)],
  );
}

export async function importEcommerceBatch(
  pool: DatabasePool,
  input: EcommerceImportBatchInput,
): Promise<EcommerceImportResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await writeBatch(client, input);
    await client.query("COMMIT");
    return { batchId: input.batchId, counts: input.counts };
  } catch (error) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `INSERT INTO ecommerce_import_batches
        (batch_id, platform, source_datasets, status, counts, error, finished_at)
       VALUES ($1, $2, $3, 'failed', $4::jsonb, $5, NOW())
       ON CONFLICT (batch_id) DO UPDATE SET
         status = 'failed', counts = EXCLUDED.counts, error = EXCLUDED.error, finished_at = NOW()`,
      [input.batchId, input.platform, input.sourceDatasets, JSON.stringify(input.counts), message],
    ).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface EcommerceSummary {
  products: number;
  assets: number;
  rawFiles: number;
  imports: number;
  needsReview: number;
}

export interface EcommerceProductListItem {
  platform: string;
  itemId: string;
  title: string;
  sourceUrl: string;
  latestCollectedAt: string;
  sourceDataset: string | null;
  thumbnailUrl: string | null;
  imageCount: number;
  needsReview: boolean;
  price: number | null;
  sales: number | null;
  brand: string | null;
  category: string | null;
}

export interface EcommerceProductList {
  items: EcommerceProductListItem[];
  total: number;
  brands: string[];
  categories: string[];
}

export interface EcommerceProductDetail extends EcommerceProductListItem {
  payload: Record<string, unknown>;
  images: Array<{
    sha256: string;
    objectKey: string;
    sourceUrl: string;
    imageType: string;
    localPath: string;
    alt: string;
    width: number | null;
    height: number | null;
    needsReview: boolean;
  }>;
  rawFiles: Array<{
    sha256: string;
    objectKey: string;
    kind: string;
    relativePath: string;
    byteSize: number;
    contentType: string;
    sourceDataset: string;
  }>;
}

export interface EcommerceFileItem {
  sha256: string;
  objectKey: string;
  kind: string;
  byteSize: number;
  contentType: string;
  itemId: string;
  productTitle: string;
  sourceDataset: string | null;
  sourceUrl: string | null;
  needsReview: boolean;
}

export interface EcommerceFileList {
  items: EcommerceFileItem[];
  total: number;
}

export interface EcommerceImportBatch {
  batchId: string;
  platform: string;
  sourceDatasets: string[];
  status: "running" | "completed" | "failed";
  counts: Record<string, number>;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export async function getEcommerceSummary(pool: DatabasePool): Promise<EcommerceSummary> {
  const result = await pool.query<{
    products: number;
    assets: number;
    raw_files: number;
    imports: number;
    needs_review: number;
  }>(`SELECT
    (SELECT COUNT(*)::int FROM ecommerce_products) AS products,
    (SELECT COUNT(*)::int FROM ecommerce_assets) AS assets,
    (SELECT COUNT(*)::int FROM ecommerce_raw_objects) AS raw_files,
    (SELECT COUNT(*)::int FROM ecommerce_import_batches) AS imports,
    (SELECT COUNT(*)::int FROM ecommerce_product_assets WHERE needs_review) AS needs_review`);
  const row = result.rows[0];
  if (!row) throw new Error("Failed to load ecommerce summary");
  return {
    products: row.products,
    assets: row.assets,
    rawFiles: row.raw_files,
    imports: row.imports,
    needsReview: row.needs_review,
  };
}

export async function listEcommerceProducts(
  pool: DatabasePool,
  options: {
    search: string;
    review: "all" | "pending";
    brand: string;
    category: string;
    limit: number;
    offset: number;
  },
): Promise<EcommerceProductList> {
  const [result, facetsResult] = await Promise.all([
    pool.query<EcommerceProductListItem & { total: number }>(`SELECT
      p.platform,
      p.item_id AS "itemId",
      p.title,
      p.brand,
      p.category,
      p.source_url AS "sourceUrl",
      p.latest_collected_at::text AS "latestCollectedAt",
      latest.source_dataset AS "sourceDataset",
      preview.source_url AS "thumbnailUrl",
      COALESCE(asset_stats.image_count, 0)::int AS "imageCount",
      COALESCE(asset_stats.needs_review, false) AS "needsReview",
      NULLIF(latest.payload #>> '{market,price_observed}', '')::double precision AS price,
      NULLIF(latest.payload #>> '{market,sales_observed}', '')::double precision AS sales,
      COUNT(*) OVER()::int AS total
    FROM ecommerce_products p
    LEFT JOIN LATERAL (
      SELECT o.observation_id, o.source_dataset, o.payload
      FROM ecommerce_product_observations o
      WHERE o.platform = p.platform AND o.item_id = p.item_id
      ORDER BY o.collected_at DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT io.source_url
      FROM ecommerce_image_observations io
      WHERE io.observation_id = latest.observation_id
      ORDER BY (io.image_type = 'main') DESC, io.position
      LIMIT 1
    ) preview ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT io.source_url) AS image_count, BOOL_OR(io.needs_review) AS needs_review
      FROM ecommerce_image_observations io
      JOIN ecommerce_product_observations observation ON observation.observation_id = io.observation_id
      WHERE observation.platform = p.platform AND observation.item_id = p.item_id
    ) asset_stats ON true
    WHERE ($1 = '' OR p.title ILIKE '%' || $1 || '%' OR p.item_id ILIKE '%' || $1 || '%'
      OR COALESCE(p.brand, '') ILIKE '%' || $1 || '%' OR COALESCE(p.category, '') ILIKE '%' || $1 || '%')
      AND ($2 = 'all' OR COALESCE(asset_stats.needs_review, false))
      AND ($3 = 'all' OR ($3 = '__uncategorized__' AND p.brand IS NULL) OR p.brand = $3)
      AND ($4 = 'all' OR ($4 = '__uncategorized__' AND p.category IS NULL) OR p.category = $4)
    ORDER BY p.latest_collected_at DESC, p.item_id
    LIMIT $5 OFFSET $6`, [
      options.search,
      options.review,
      options.brand,
      options.category,
      options.limit,
      options.offset,
    ]),
    pool.query<{ brands: string[]; categories: string[] }>(`SELECT
      COALESCE(ARRAY_AGG(DISTINCT brand ORDER BY brand) FILTER (WHERE brand IS NOT NULL), ARRAY[]::text[]) AS brands,
      COALESCE(ARRAY_AGG(DISTINCT category ORDER BY category) FILTER (WHERE category IS NOT NULL), ARRAY[]::text[]) AS categories
    FROM ecommerce_products`),
  ]);
  const facets = facetsResult.rows[0] ?? { brands: [], categories: [] };
  return {
    items: result.rows.map(({ total: _total, ...item }) => item),
    total: result.rows[0]?.total ?? 0,
    brands: facets.brands,
    categories: facets.categories,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeObservedPayloads(payloads: Array<Record<string, unknown>>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const payload of payloads) {
    for (const [key, value] of Object.entries(payload)) {
      if (isRecord(value)) {
        const existing = isRecord(merged[key]) ? merged[key] : {};
        merged[key] = mergeObservedPayloads([existing, value]);
      } else if (Array.isArray(value)) {
        if (value.length) merged[key] = value;
      } else if (value !== null && value !== undefined && value !== "") {
        merged[key] = value;
      }
    }
  }
  return merged;
}

export async function getEcommerceProduct(
  pool: DatabasePool,
  itemId: string,
): Promise<EcommerceProductDetail | null> {
  const productResult = await pool.query<EcommerceProductListItem & {
    observationId: string | null;
    payload: Record<string, unknown> | null;
  }>(
    `SELECT
      p.platform,
      p.item_id AS "itemId",
      p.title,
      p.brand,
      p.category,
      p.source_url AS "sourceUrl",
      p.latest_collected_at::text AS "latestCollectedAt",
      latest.observation_id AS "observationId",
      latest.source_dataset AS "sourceDataset",
      latest.payload,
      preview.source_url AS "thumbnailUrl",
      COALESCE(asset_stats.image_count, 0)::int AS "imageCount",
      COALESCE(asset_stats.needs_review, false) AS "needsReview",
      NULLIF(latest.payload #>> '{market,price_observed}', '')::double precision AS price,
      NULLIF(latest.payload #>> '{market,sales_observed}', '')::double precision AS sales
    FROM ecommerce_products p
    LEFT JOIN LATERAL (
      SELECT o.observation_id, o.source_dataset, o.payload
      FROM ecommerce_product_observations o
      WHERE o.platform = p.platform AND o.item_id = p.item_id
      ORDER BY o.collected_at DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT io.source_url
      FROM ecommerce_image_observations io
      WHERE io.observation_id = latest.observation_id
      ORDER BY (io.image_type = 'main') DESC, io.position
      LIMIT 1
    ) preview ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT io.source_url) AS image_count, BOOL_OR(io.needs_review) AS needs_review
      FROM ecommerce_image_observations io
      JOIN ecommerce_product_observations observation ON observation.observation_id = io.observation_id
      WHERE observation.platform = p.platform AND observation.item_id = p.item_id
    ) asset_stats ON true
    WHERE p.item_id = $1
    LIMIT 1`,
    [itemId],
  );
  const product = productResult.rows[0];
  if (!product) return null;

  const [payloadsResult, imagesResult, rawFilesResult] = await Promise.all([
    pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload
       FROM ecommerce_product_observations
       WHERE platform = $1 AND item_id = $2
       ORDER BY collected_at ASC`,
      [product.platform, itemId],
    ),
    pool.query<EcommerceProductDetail["images"][number]>(
      `SELECT
        image.sha256,
        image."objectKey",
        image."sourceUrl",
        image."imageType",
        image."localPath",
        image.alt,
        image.width,
        image.height,
        image."needsReview"
      FROM (
        SELECT DISTINCT ON (io.source_url)
          io.asset_sha256 AS sha256,
          a.object_key AS "objectKey",
          io.source_url AS "sourceUrl",
          io.image_type AS "imageType",
          io.local_path AS "localPath",
          io.alt,
          io.width,
          io.height,
          io.needs_review AS "needsReview",
          CASE io.image_type WHEN 'main' THEN 0 WHEN 'sku' THEN 1 WHEN 'detail' THEN 2 ELSE 3 END AS type_order,
          io.position,
          observation.collected_at
        FROM ecommerce_image_observations io
        JOIN ecommerce_product_observations observation ON observation.observation_id = io.observation_id
        JOIN ecommerce_assets a ON a.sha256 = io.asset_sha256
        WHERE observation.platform = $1 AND observation.item_id = $2
        ORDER BY io.source_url,
          observation.collected_at DESC,
          io.position
      ) AS image
      ORDER BY image.type_order, image.position, image.collected_at DESC`,
      [product.platform, itemId],
    ),
    pool.query<EcommerceProductDetail["rawFiles"][number]>(
      `SELECT
        r.sha256,
        r.object_key AS "objectKey",
        r.kind,
        r.relative_path AS "relativePath",
        r.byte_size::int AS "byteSize",
        r.content_type AS "contentType",
        r.source_dataset AS "sourceDataset"
      FROM ecommerce_raw_objects r
      WHERE r.item_id = $1
      ORDER BY r.source_dataset, r.kind`,
      [itemId],
    ),
  ]);
  const { observationId: _observationId, payload: _latestPayload, ...summary } = product;
  return {
    ...summary,
    payload: mergeObservedPayloads(payloadsResult.rows.map((row) => row.payload)),
    images: imagesResult.rows,
    rawFiles: rawFilesResult.rows,
  };
}

export async function listEcommerceFiles(
  pool: DatabasePool,
  options: { search: string; kind: string; limit: number; offset: number },
): Promise<EcommerceFileList> {
  const result = await pool.query<EcommerceFileItem & { total: number }>(
    `WITH files AS (
      SELECT
        a.sha256::text AS sha256,
        a.object_key AS "objectKey",
        COALESCE(pa.image_types[1], 'image') AS kind,
        a.byte_size::int AS "byteSize",
        a.content_type AS "contentType",
        pa.item_id AS "itemId",
        p.title AS "productTitle",
        pa.source_datasets[1] AS "sourceDataset",
        pa.source_urls ->> 0 AS "sourceUrl",
        pa.needs_review AS "needsReview"
      FROM ecommerce_assets a
      JOIN ecommerce_product_assets pa ON pa.asset_sha256 = a.sha256
      JOIN ecommerce_products p ON p.platform = pa.platform AND p.item_id = pa.item_id
      UNION ALL
      SELECT
        r.sha256::text,
        r.object_key,
        r.kind,
        r.byte_size::int,
        r.content_type,
        r.item_id,
        p.title,
        r.source_dataset,
        NULL::text,
        false
      FROM ecommerce_raw_objects r
      JOIN ecommerce_products p ON p.item_id = r.item_id
    )
    SELECT files.*, COUNT(*) OVER()::int AS total
    FROM files
    WHERE ($1 = '' OR "productTitle" ILIKE '%' || $1 || '%' OR "itemId" ILIKE '%' || $1 || '%' OR "objectKey" ILIKE '%' || $1 || '%')
      AND ($2 = 'all' OR kind = $2)
    ORDER BY "itemId", kind, "objectKey"
    LIMIT $3 OFFSET $4`,
    [options.search, options.kind, options.limit, options.offset],
  );
  return {
    items: result.rows.map(({ total: _total, ...item }) => item),
    total: result.rows[0]?.total ?? 0,
  };
}

export async function listEcommerceImports(
  pool: DatabasePool,
  limit = 20,
): Promise<EcommerceImportBatch[]> {
  const result = await pool.query<EcommerceImportBatch>(
    `SELECT
      batch_id::text AS "batchId",
      platform,
      source_datasets AS "sourceDatasets",
      status,
      counts,
      error,
      started_at::text AS "startedAt",
      finished_at::text AS "finishedAt"
    FROM ecommerce_import_batches
    ORDER BY started_at DESC
    LIMIT $1`,
    [limit],
  );
  return result.rows;
}
