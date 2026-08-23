import { createDatabasePool, importEcommerceBatch, runMigrations } from "@dlr/database";
import { OssObjectStorage } from "@dlr/storage";
import type { ImportPlan } from "./types.js";

export interface UploadSummary {
  uploaded: number;
  reused: number;
}

async function uploadObjects(
  plan: ImportPlan,
  concurrency: number,
  storage: OssObjectStorage,
): Promise<UploadSummary> {
  const summary: UploadSummary = { uploaded: 0, reused: 0 };
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < plan.uploads.length) {
      const current = plan.uploads[cursor++];
      if (!current) return;
      const result = await storage.putFileIfAbsent(
        current.objectKey,
        current.localPath,
        current.contentType,
        current.sha256,
      );
      summary[result.status] += 1;
    }
  }
  const workers = Math.min(concurrency, plan.uploads.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return summary;
}

export async function executeImport(plan: ImportPlan, concurrency: number): Promise<void> {
  const pool = createDatabasePool();
  const storage = new OssObjectStorage();
  try {
    await pool.query("SELECT 1");
    const migrations = await runMigrations(pool);
    if (migrations.length) console.log(`Applied migrations: ${migrations.join(", ")}`);
    const uploadSummary = await uploadObjects(plan, concurrency, storage);
    plan.batch.counts.uploadedObjects = uploadSummary.uploaded;
    plan.batch.counts.reusedObjects = uploadSummary.reused;
    await importEcommerceBatch(pool, plan.batch);
  } finally {
    await pool.end();
  }
  console.log(JSON.stringify({ batchId: plan.batch.batchId, ...plan.batch.counts }, null, 2));
}
