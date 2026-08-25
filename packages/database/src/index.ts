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

export function requireDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
}

export function createDatabasePool(databaseUrl = requireDatabaseUrl()): DatabasePool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "dlr-data-pipeline",
  });
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
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS sha256 CHAR(64)");
    const names = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    for (const name of names) {
      const sql = await readFile(resolve(migrationsDirectory, name), "utf8");
      const sha256 = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ sha256: string | null }>(
        "SELECT sha256 FROM schema_migrations WHERE name = $1",
        [name],
      );
      if (existing.rowCount) {
        const recordedSha256 = existing.rows[0]?.sha256?.trim();
        if (!recordedSha256) {
          await client.query("UPDATE schema_migrations SET sha256 = $2 WHERE name = $1", [name, sha256]);
        } else if (recordedSha256 !== sha256) {
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
    const migrationsWithoutHash = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations WHERE sha256 IS NULL ORDER BY name",
    );
    if (migrationsWithoutHash.rowCount) {
      throw new Error(
        `Cannot verify applied migrations missing from this checkout: ${migrationsWithoutHash.rows.map(({ name }) => name).join(", ")}`,
      );
    }
    await client.query("ALTER TABLE schema_migrations ALTER COLUMN sha256 SET NOT NULL");
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

export type FeishuChatMode = "group" | "topic" | "p2p" | "unknown";
export type FeishuChatStatus = "normal" | "dissolved" | "dissolved_save" | "unknown";
export type FeishuChatCategory = "group" | "p2p";
export type FeishuCollectorType = "robot" | "cli";
export type FeishuCallerIdentity = "bot" | "user";

export interface FeishuChatRecord {
  chatId: string;
  chatName: string;
  description?: string;
  chatMode: FeishuChatMode;
  chatStatus: FeishuChatStatus;
  external?: boolean;
  ownerId?: string;
  p2pTargetType?: string;
  p2pTargetId?: string;
}

export interface FeishuJobRecord extends FeishuChatRecord {
  id: string;
  collectorType: FeishuCollectorType;
  callerIdentity: FeishuCallerIdentity;
  appNamespace: string;
  status: "queued" | "running" | "completed" | "partial" | "failed";
  pages: number;
  messageCount: number;
  attachmentCount: number;
  attachmentFailedCount: number;
  nextPageToken: string;
  hasMore: boolean;
  error: string;
  startTime?: string;
  endTimeExclusive?: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
}

export interface FeishuAttachmentRecord {
  type: "image" | "file";
  fileKey: string;
  name: string;
  status: string;
  relativePath: string;
  size: number;
  error: string;
  storageStatus?: string;
  ossBucket?: string;
  ossObjectKey?: string;
  ossEtag?: string;
  storageError?: string;
  uploadedAt?: string;
}

export interface FeishuMessageRecord {
  messageId: string;
  chatId: string;
  senderId: string;
  senderName: string;
  senderType: string;
  msgType: string;
  createTime: string;
  updateTime: string;
  text: string;
  rootId: string;
  parentId: string;
  deleted: boolean;
  updated: boolean;
  attachments: FeishuAttachmentRecord[];
}

export interface FeishuChatSummary {
  chatId: string;
  name: string;
  description: string;
  chatMode: FeishuChatMode;
  chatStatus: FeishuChatStatus;
  external?: boolean;
  ownerId: string;
  p2pTargetType: string;
  p2pTargetId: string;
  messageCount: number;
  firstMessageAt: string;
  lastMessageAt: string;
  lastCollectedAt: string;
}

export interface FeishuHistoryAttachmentRecord extends FeishuAttachmentRecord {
  messageId: string;
  lastJobId: string;
}

export interface FeishuAttachmentRangeQuery {
  chatId: string;
  from: string;
  to: string;
}

export interface FeishuHistoryMessageRecord extends Omit<FeishuMessageRecord, "attachments"> {
  attachments: FeishuHistoryAttachmentRecord[];
}

export interface FeishuHistoryQuery {
  chatId: string;
  page: number;
  pageSize: number;
  order: "asc" | "desc";
  snapshotAt: string;
  from?: string;
  to?: string;
}

export interface FeishuHistoryPage {
  items: FeishuHistoryMessageRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  snapshotAt: string;
}

function asIso(value: Date | string | null): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function upsertJob(client: DatabasePool | PoolClient, job: FeishuJobRecord): Promise<void> {
  await client.query(
    `INSERT INTO feishu_chats (
       chat_id, name, description, chat_mode, chat_status, external,
       owner_id, p2p_target_type, p2p_target_id, last_seen_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
     ON CONFLICT (chat_id) DO UPDATE SET
       name = EXCLUDED.name,
       description = CASE WHEN EXCLUDED.description <> '' THEN EXCLUDED.description ELSE feishu_chats.description END,
       chat_mode = CASE WHEN EXCLUDED.chat_mode <> 'unknown' THEN EXCLUDED.chat_mode ELSE feishu_chats.chat_mode END,
       chat_status = CASE WHEN EXCLUDED.chat_status <> 'unknown' THEN EXCLUDED.chat_status ELSE feishu_chats.chat_status END,
       external = COALESCE(EXCLUDED.external, feishu_chats.external),
       owner_id = CASE WHEN EXCLUDED.owner_id <> '' THEN EXCLUDED.owner_id ELSE feishu_chats.owner_id END,
       p2p_target_type = CASE WHEN EXCLUDED.p2p_target_type <> '' THEN EXCLUDED.p2p_target_type ELSE feishu_chats.p2p_target_type END,
       p2p_target_id = CASE WHEN EXCLUDED.p2p_target_id <> '' THEN EXCLUDED.p2p_target_id ELSE feishu_chats.p2p_target_id END,
       last_seen_at = now()`,
    [
      job.chatId,
      job.chatName,
      job.description ?? "",
      job.chatMode || "group",
      job.chatStatus || "unknown",
      job.external ?? null,
      job.ownerId ?? "",
      job.p2pTargetType ?? "",
      job.p2pTargetId ?? "",
    ],
  );
  await client.query(
    `INSERT INTO feishu_collection_jobs (
       id, chat_id, chat_name, collector_type, caller_identity, app_namespace,
       status, pages, message_count, attachment_count,
       attachment_failed_count, next_page_token, has_more, error, start_time, end_time_exclusive,
       created_at, updated_at, completed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (id) DO UPDATE SET
       chat_id = EXCLUDED.chat_id,
       chat_name = EXCLUDED.chat_name,
       collector_type = EXCLUDED.collector_type,
       caller_identity = EXCLUDED.caller_identity,
       app_namespace = EXCLUDED.app_namespace,
       status = EXCLUDED.status,
       pages = EXCLUDED.pages,
       message_count = EXCLUDED.message_count,
       attachment_count = EXCLUDED.attachment_count,
       attachment_failed_count = EXCLUDED.attachment_failed_count,
       next_page_token = EXCLUDED.next_page_token,
       has_more = EXCLUDED.has_more,
       error = EXCLUDED.error,
       start_time = EXCLUDED.start_time,
       end_time_exclusive = EXCLUDED.end_time_exclusive,
       updated_at = EXCLUDED.updated_at,
       completed_at = EXCLUDED.completed_at`,
    [
      job.id, job.chatId, job.chatName, job.collectorType, job.callerIdentity,
      job.appNamespace, job.status, job.pages, job.messageCount, job.attachmentCount,
      job.attachmentFailedCount, job.nextPageToken || null, job.hasMore, job.error,
      job.startTime || null, job.endTimeExclusive || null, job.createdAt, job.updatedAt,
      job.completedAt || null,
    ],
  );
}

export class PostgresFeishuRepository {
  constructor(readonly pool: DatabasePool) {}

  async health(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async saveJob(job: FeishuJobRecord): Promise<void> {
    await upsertJob(this.pool, job);
  }

  async savePage(job: FeishuJobRecord, messages: FeishuMessageRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await upsertJob(client, job);
      for (const message of messages) {
        await client.query(
          `INSERT INTO feishu_messages (
             message_id, chat_id, last_job_id, sender_id, sender_name, sender_type, msg_type,
             create_time, update_time, text, root_id, parent_id, deleted, updated, last_collected_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
           ON CONFLICT (message_id) DO UPDATE SET
             chat_id = EXCLUDED.chat_id,
             last_job_id = EXCLUDED.last_job_id,
             sender_id = EXCLUDED.sender_id,
             sender_name = EXCLUDED.sender_name,
             sender_type = EXCLUDED.sender_type,
             msg_type = EXCLUDED.msg_type,
             create_time = EXCLUDED.create_time,
             update_time = EXCLUDED.update_time,
             text = EXCLUDED.text,
             root_id = EXCLUDED.root_id,
             parent_id = EXCLUDED.parent_id,
             deleted = EXCLUDED.deleted,
             updated = EXCLUDED.updated,
             last_collected_at = now()
           WHERE (
             feishu_messages.chat_id,
             feishu_messages.sender_id,
             feishu_messages.sender_name,
             feishu_messages.sender_type,
             feishu_messages.msg_type,
             feishu_messages.create_time,
             feishu_messages.update_time,
             feishu_messages.text,
             feishu_messages.root_id,
             feishu_messages.parent_id,
             feishu_messages.deleted,
             feishu_messages.updated
           ) IS DISTINCT FROM (
             EXCLUDED.chat_id,
             EXCLUDED.sender_id,
             EXCLUDED.sender_name,
             EXCLUDED.sender_type,
             EXCLUDED.msg_type,
             EXCLUDED.create_time,
             EXCLUDED.update_time,
             EXCLUDED.text,
             EXCLUDED.root_id,
             EXCLUDED.parent_id,
             EXCLUDED.deleted,
             EXCLUDED.updated
           )`,
          [
            message.messageId, message.chatId, job.id, message.senderId, message.senderName,
            message.senderType, message.msgType, message.createTime || null, message.updateTime || null,
            message.text, message.rootId, message.parentId, message.deleted, message.updated,
          ],
        );
        for (const attachment of message.attachments) {
          await client.query(
            `INSERT INTO feishu_attachments (
               message_id, file_key, last_job_id, type, name, source_status, source_relative_path,
               size_bytes, source_error, storage_status, oss_bucket, oss_object_key, oss_etag,
               storage_error, uploaded_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
             ON CONFLICT (message_id, file_key) DO UPDATE SET
               last_job_id = EXCLUDED.last_job_id,
               type = EXCLUDED.type,
               name = EXCLUDED.name,
               source_status = EXCLUDED.source_status,
               source_relative_path = EXCLUDED.source_relative_path,
               size_bytes = EXCLUDED.size_bytes,
               source_error = EXCLUDED.source_error,
               storage_status = EXCLUDED.storage_status,
               oss_bucket = EXCLUDED.oss_bucket,
               oss_object_key = EXCLUDED.oss_object_key,
               oss_etag = EXCLUDED.oss_etag,
               storage_error = EXCLUDED.storage_error,
               uploaded_at = EXCLUDED.uploaded_at,
               updated_at = now()
             WHERE (
               feishu_attachments.type,
               feishu_attachments.name,
               feishu_attachments.source_status,
               feishu_attachments.source_relative_path,
               feishu_attachments.size_bytes,
               feishu_attachments.source_error,
               feishu_attachments.storage_status,
               feishu_attachments.oss_bucket,
               feishu_attachments.oss_object_key,
               feishu_attachments.oss_etag,
               feishu_attachments.storage_error,
               feishu_attachments.uploaded_at
             ) IS DISTINCT FROM (
               EXCLUDED.type,
               EXCLUDED.name,
               EXCLUDED.source_status,
               EXCLUDED.source_relative_path,
               EXCLUDED.size_bytes,
               EXCLUDED.source_error,
               EXCLUDED.storage_status,
               EXCLUDED.oss_bucket,
               EXCLUDED.oss_object_key,
               EXCLUDED.oss_etag,
               EXCLUDED.storage_error,
               EXCLUDED.uploaded_at
             )`,
            [
              message.messageId, attachment.fileKey, job.id, attachment.type, attachment.name,
              attachment.status, attachment.relativePath, attachment.size, attachment.error,
              attachment.storageStatus ?? "not_configured", attachment.ossBucket || null,
              attachment.ossObjectKey || null, attachment.ossEtag || null,
              attachment.storageError ?? "", attachment.uploadedAt || null,
            ],
          );
        }
      }
      await client.query(
        "UPDATE feishu_chats SET last_collected_at = now(), last_seen_at = now() WHERE chat_id = $1",
        [job.chatId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listChats(category?: FeishuChatCategory): Promise<FeishuChatSummary[]> {
    const categoryFilter = category === "p2p"
      ? "WHERE c.chat_mode = 'p2p'"
      : category === "group"
        ? "WHERE c.chat_mode IN ('group', 'topic', 'unknown')"
        : "";
    const result = await this.pool.query<{
      chatId: string;
      name: string;
      description: string;
      chatMode: FeishuChatMode;
      chatStatus: FeishuChatStatus;
      external: boolean | null;
      ownerId: string;
      p2pTargetType: string;
      p2pTargetId: string;
      messageCount: number;
      firstMessageAt: Date | null;
      lastMessageAt: Date | null;
      lastCollectedAt: Date | null;
    }>(
      `SELECT
         c.chat_id AS "chatId",
         c.name,
         c.description,
         c.chat_mode AS "chatMode",
         c.chat_status AS "chatStatus",
         c.external,
         c.owner_id AS "ownerId",
         c.p2p_target_type AS "p2pTargetType",
         c.p2p_target_id AS "p2pTargetId",
         COUNT(m.message_id)::integer AS "messageCount",
         MIN(m.create_time) AS "firstMessageAt",
         MAX(m.create_time) AS "lastMessageAt",
         c.last_collected_at AS "lastCollectedAt"
       FROM feishu_chats c
       LEFT JOIN feishu_messages m ON m.chat_id = c.chat_id
       ${categoryFilter}
       GROUP BY c.chat_id, c.name, c.description, c.chat_mode, c.chat_status,
                c.external, c.owner_id, c.p2p_target_type, c.p2p_target_id, c.last_collected_at
       ORDER BY MAX(m.create_time) DESC NULLS LAST,
                c.last_collected_at DESC NULLS LAST,
                c.name ASC,
                c.chat_id ASC`,
    );
    return result.rows.map((row) => ({
      ...row,
      external: row.external ?? undefined,
      messageCount: Number(row.messageCount),
      firstMessageAt: asIso(row.firstMessageAt),
      lastMessageAt: asIso(row.lastMessageAt),
      lastCollectedAt: asIso(row.lastCollectedAt),
    }));
  }

  async listAttachmentsForRange(
    query: FeishuAttachmentRangeQuery,
  ): Promise<FeishuHistoryAttachmentRecord[]> {
    const result = await this.pool.query<{
      messageId: string;
      fileKey: string;
      lastJobId: string | null;
      type: "image" | "file";
      name: string;
      status: string;
      relativePath: string;
      size: string | number;
      error: string;
      storageStatus: string;
      ossBucket: string | null;
      ossObjectKey: string | null;
      ossEtag: string | null;
      storageError: string;
      uploadedAt: Date | null;
    }>(
      `SELECT
         a.message_id AS "messageId",
         a.file_key AS "fileKey",
         a.last_job_id::text AS "lastJobId",
         a.type,
         a.name,
         a.source_status AS status,
         a.source_relative_path AS "relativePath",
         a.size_bytes AS size,
         a.source_error AS error,
         a.storage_status AS "storageStatus",
         a.oss_bucket AS "ossBucket",
         a.oss_object_key AS "ossObjectKey",
         a.oss_etag AS "ossEtag",
         a.storage_error AS "storageError",
         a.uploaded_at AS "uploadedAt"
       FROM feishu_attachments a
       JOIN feishu_messages m ON m.message_id = a.message_id
       WHERE m.chat_id = $1
         AND m.create_time >= $2::timestamptz
         AND m.create_time < $3::timestamptz`,
      [query.chatId, query.from, query.to],
    );
    return result.rows.map((attachment) => ({
      ...attachment,
      lastJobId: attachment.lastJobId ?? "",
      size: Number(attachment.size),
      ossBucket: attachment.ossBucket ?? "",
      ossObjectKey: attachment.ossObjectKey ?? "",
      ossEtag: attachment.ossEtag ?? "",
      uploadedAt: asIso(attachment.uploadedAt),
    }));
  }

  async listMessages(query: FeishuHistoryQuery): Promise<FeishuHistoryPage | null> {
    const chat = await this.pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM feishu_chats WHERE chat_id = $1) AS exists",
      [query.chatId],
    );
    if (!chat.rows[0]?.exists) return null;

    const values: unknown[] = [query.chatId, query.snapshotAt];
    const filters = ["m.chat_id = $1", "m.first_collected_at <= $2"];
    if (query.from) {
      values.push(query.from);
      filters.push(`m.create_time >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      filters.push(`m.create_time < $${values.length}`);
    }
    const where = filters.join(" AND ");
    const count = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM feishu_messages m WHERE ${where}`,
      values,
    );
    const total = Number(count.rows[0]?.total ?? 0);
    const totalPages = Math.ceil(total / query.pageSize);
    const page = totalPages ? Math.min(query.page, totalPages) : 1;
    const pageValues = [...values, query.pageSize, (page - 1) * query.pageSize];
    const messages = await this.pool.query<{
      messageId: string;
      chatId: string;
      senderId: string;
      senderName: string;
      senderType: string;
      msgType: string;
      createTime: Date | null;
      updateTime: Date | null;
      text: string;
      rootId: string;
      parentId: string;
      deleted: boolean;
      updated: boolean;
    }>(
      `SELECT
         m.message_id AS "messageId",
         m.chat_id AS "chatId",
         m.sender_id AS "senderId",
         m.sender_name AS "senderName",
         m.sender_type AS "senderType",
         m.msg_type AS "msgType",
         m.create_time AS "createTime",
         m.update_time AS "updateTime",
         m.text,
         m.root_id AS "rootId",
         m.parent_id AS "parentId",
         m.deleted,
         m.updated
       FROM feishu_messages m
       WHERE ${where}
       ORDER BY m.create_time DESC NULLS LAST, m.message_id DESC
       LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues,
    );

    const messageIds = messages.rows.map((message) => message.messageId);
    const attachments = messageIds.length
      ? await this.pool.query<{
          messageId: string;
          fileKey: string;
          lastJobId: string | null;
          type: "image" | "file";
          name: string;
          status: string;
          relativePath: string;
          size: string;
          error: string;
          storageStatus: string;
          ossBucket: string | null;
          ossObjectKey: string | null;
          ossEtag: string | null;
          storageError: string;
          uploadedAt: Date | null;
        }>(
          `SELECT
             a.message_id AS "messageId",
             a.file_key AS "fileKey",
             a.last_job_id::text AS "lastJobId",
             a.type,
             a.name,
             a.source_status AS status,
             a.source_relative_path AS "relativePath",
             a.size_bytes::text AS size,
             a.source_error AS error,
             a.storage_status AS "storageStatus",
             a.oss_bucket AS "ossBucket",
             a.oss_object_key AS "ossObjectKey",
             a.oss_etag AS "ossEtag",
             a.storage_error AS "storageError",
             a.uploaded_at AS "uploadedAt"
           FROM feishu_attachments a
           WHERE a.message_id = ANY($1::text[])
           ORDER BY a.message_id ASC, a.file_key ASC`,
          [messageIds],
        )
      : { rows: [] };
    const attachmentsByMessage = new Map<string, FeishuHistoryAttachmentRecord[]>();
    for (const attachment of attachments.rows) {
      const list = attachmentsByMessage.get(attachment.messageId) ?? [];
      list.push({
        ...attachment,
        lastJobId: attachment.lastJobId ?? "",
        size: Number(attachment.size),
        ossBucket: attachment.ossBucket ?? "",
        ossObjectKey: attachment.ossObjectKey ?? "",
        ossEtag: attachment.ossEtag ?? "",
        uploadedAt: asIso(attachment.uploadedAt),
      });
      attachmentsByMessage.set(attachment.messageId, list);
    }
    const items: FeishuHistoryMessageRecord[] = messages.rows.map((message) => ({
      ...message,
      createTime: asIso(message.createTime),
      updateTime: asIso(message.updateTime),
      attachments: attachmentsByMessage.get(message.messageId) ?? [],
    }));
    if (query.order === "asc") items.reverse();
    return { items, page, pageSize: query.pageSize, total, totalPages, snapshotAt: query.snapshotAt };
  }

  async getAttachment(messageId: string, fileKey: string): Promise<FeishuHistoryAttachmentRecord | null> {
    const result = await this.pool.query<{
      messageId: string;
      fileKey: string;
      lastJobId: string | null;
      type: "image" | "file";
      name: string;
      status: string;
      relativePath: string;
      size: string;
      error: string;
      storageStatus: string;
      ossBucket: string | null;
      ossObjectKey: string | null;
      ossEtag: string | null;
      storageError: string;
      uploadedAt: Date | null;
    }>(
      `SELECT
         a.message_id AS "messageId",
         a.file_key AS "fileKey",
         a.last_job_id::text AS "lastJobId",
         a.type,
         a.name,
         a.source_status AS status,
         a.source_relative_path AS "relativePath",
         a.size_bytes::text AS size,
         a.source_error AS error,
         a.storage_status AS "storageStatus",
         a.oss_bucket AS "ossBucket",
         a.oss_object_key AS "ossObjectKey",
         a.oss_etag AS "ossEtag",
         a.storage_error AS "storageError",
         a.uploaded_at AS "uploadedAt"
       FROM feishu_attachments a
       WHERE a.message_id = $1 AND a.file_key = $2`,
      [messageId, fileKey],
    );
    const attachment = result.rows[0];
    if (!attachment) return null;
    return {
      ...attachment,
      lastJobId: attachment.lastJobId ?? "",
      size: Number(attachment.size),
      ossBucket: attachment.ossBucket ?? "",
      ossObjectKey: attachment.ossObjectKey ?? "",
      ossEtag: attachment.ossEtag ?? "",
      uploadedAt: asIso(attachment.uploadedAt),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
