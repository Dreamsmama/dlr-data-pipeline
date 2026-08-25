import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabasePool, requireDatabaseUrl, runMigrations } from "./index.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, "../../..");
try {
  process.loadEnvFile(path.join(repositoryRoot, ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const pool = createDatabasePool(requireDatabaseUrl());
try {
  const applied = await runMigrations(pool);
  process.stdout.write(JSON.stringify({ status: "ok", applied, appliedCount: applied.length }) + "\n");
} finally {
  await pool.end();
}
