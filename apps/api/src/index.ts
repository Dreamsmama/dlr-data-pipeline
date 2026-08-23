import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabasePool, PostgresFeishuRepository, requireDatabaseUrl } from "@dlr/database";
import { AliyunOssStorage, requireOssConfig } from "@dlr/storage";

import { buildApp } from "./app.js";
import { FeishuExternalPersistence } from "./feishu/external-persistence.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDir, "../../..");
try {
  process.loadEnvFile(path.join(repositoryRoot, ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const port = Number(process.env.API_PORT ?? 3001);
const host = process.env.API_HOST ?? "0.0.0.0";
const dataRoot = process.env.FEISHU_DATA_DIR
  ? path.resolve(process.env.FEISHU_DATA_DIR)
  : path.join(repositoryRoot, "collectors/internal/run-data/feishu");
const pythonProject = path.join(repositoryRoot, "collectors/internal/python");
const allowedOrigins = (process.env.ALLOWED_WEB_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const persistenceMode = process.env.FEISHU_PERSISTENCE_MODE?.trim() || "local";
if (!["local", "postgres-oss"].includes(persistenceMode)) {
  throw new Error("FEISHU_PERSISTENCE_MODE 只能是 local 或 postgres-oss");
}
const persistenceRequested = persistenceMode === "postgres-oss";
let persistence: FeishuExternalPersistence | undefined;
if (persistenceRequested) {
  const repository = new PostgresFeishuRepository(createDatabasePool(requireDatabaseUrl()));
  const storage = new AliyunOssStorage(requireOssConfig());
  persistence = new FeishuExternalPersistence(repository, storage);
  await persistence.health();
}
const app = await buildApp({
  dataRoot,
  pythonProject,
  pythonScript: path.join(pythonProject, "feishu_bridge.py"),
  allowedOrigins,
  logger: true,
  persistence,
  history: persistence,
  persistenceMode: persistence ? "postgres-oss" : "local",
});

await app.listen({ port, host });
