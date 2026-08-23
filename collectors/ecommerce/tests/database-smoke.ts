import assert from "node:assert/strict";
import {
  createDatabasePool,
  getEcommerceProduct,
  importEcommerceBatch,
  listEcommerceProducts,
  requireDatabaseUrl,
  runMigrations,
} from "@dlr/database";
import { loadDataset } from "../src/platforms/tmall/catalog.js";
import { buildImportPlan } from "../src/platforms/tmall/plan.js";

const SAMPLE_ITEM_IDS = ["1000395107293", "1041927628929", "1002524899686"];

async function main(): Promise<void> {
  if (process.env.DLR_ALLOW_DATABASE_SMOKE !== "1") {
    throw new Error("DLR_ALLOW_DATABASE_SMOKE=1 is required");
  }
  const databaseUrl = requireDatabaseUrl();
  if (!/test/i.test(new URL(databaseUrl).pathname)) {
    throw new Error("Database smoke test requires a database name containing 'test'");
  }
  const [fullDir, extensionDir] = process.argv.slice(2);
  if (!fullDir || !extensionDir) throw new Error("Expected full and extension dataset directories");
  const datasets = [
    await loadDataset("diluowei_full", fullDir),
    await loadDataset("chrome_extension", extensionDir),
  ];
  const plan = await buildImportPlan(datasets, SAMPLE_ITEM_IDS);
  const pool = createDatabasePool(databaseUrl);
  try {
    await runMigrations(pool);
    await importEcommerceBatch(pool, plan.batch);
    await importEcommerceBatch(pool, plan.batch);
    const expected: Record<string, number> = {
      ecommerce_import_batches: 1,
      ecommerce_products: 3,
      ecommerce_product_observations: 4,
      ecommerce_assets: 77,
      ecommerce_product_assets: 78,
      ecommerce_image_observations: 78,
      ecommerce_raw_objects: 14,
    };
    for (const [table, count] of Object.entries(expected)) {
      const result = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}`);
      assert.equal(Number(result.rows[0]?.count), count, table);
    }
    const catalog = await listEcommerceProducts(pool, {
      search: "",
      review: "all",
      brand: "all",
      category: "all",
      limit: 20,
      offset: 0,
    });
    assert.deepEqual(new Set(catalog.brands), new Set(["蒂洛薇"]));
    assert.deepEqual(new Set(catalog.categories), new Set(["散粉", "气垫", "素颜霜"]));
    assert.equal(catalog.items.every((item) => item.brand === "蒂洛薇"), true);

    const detailedProduct = await getEcommerceProduct(pool, "1000395107293");
    assert.ok(detailedProduct);
    assert.equal(Object.keys(detailedProduct.payload.attributes as Record<string, unknown>).length, 14);
    assert.equal(detailedProduct.images.filter((image) => image.imageType === "detail").length, 45);
    console.log(JSON.stringify({ databaseSmoke: "ok", ...expected }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
