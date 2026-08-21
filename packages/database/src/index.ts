import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type Pool as PoolType, type PoolClient } from "pg";
import type { EcommerceImportBatchInput, EcommerceImportResult } from "@dlr/schemas";

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

  for (const product of input.products) {
    await client.query(
      `INSERT INTO ecommerce_products
        (platform, item_id, source_url, title, latest_collected_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (platform, item_id) DO UPDATE SET
         source_url = CASE WHEN EXCLUDED.latest_collected_at >= ecommerce_products.latest_collected_at
           THEN EXCLUDED.source_url ELSE ecommerce_products.source_url END,
         title = CASE WHEN EXCLUDED.latest_collected_at >= ecommerce_products.latest_collected_at
           AND EXCLUDED.title <> '' THEN EXCLUDED.title ELSE ecommerce_products.title END,
         latest_collected_at = GREATEST(ecommerce_products.latest_collected_at, EXCLUDED.latest_collected_at),
         updated_at = NOW()`,
      [product.platform, product.itemId, product.sourceUrl, product.title, product.latestCollectedAt],
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
