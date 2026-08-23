import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { loadDataset } from "./platforms/tmall/catalog.js";
import { parseArgs, printUsage } from "./platforms/tmall/cli.js";
import { executeImport } from "./platforms/tmall/importer.js";
import { buildImportPlan } from "./platforms/tmall/plan.js";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const datasets = [];
  if (options.fullDir) datasets.push(await loadDataset("diluowei_full", options.fullDir));
  if (options.extensionDir) datasets.push(await loadDataset("chrome_extension", options.extensionDir));
  const plan = await buildImportPlan(datasets, options.itemIds, options.limit);
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, batchId: plan.batch.batchId, ...plan.batch.counts }, null, 2));
    return;
  }
  try {
    loadEnvFile(resolve(import.meta.dirname, "../../../.env"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  await executeImport(plan, options.concurrency);
}

main().catch((error: unknown) => {
  printUsage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
