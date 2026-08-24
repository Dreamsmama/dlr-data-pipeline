import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { createDatabasePool, runMigrations } from "../packages/database/dist/index.js";

try {
  loadEnvFile(resolve(import.meta.dirname, "../.env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const pool = createDatabasePool();
try {
  const applied = await runMigrations(pool);
  console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database schema is current.");
} finally {
  await pool.end();
}
