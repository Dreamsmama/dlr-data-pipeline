import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabasePool, PostgresFeishuRepository, requireDatabaseUrl } from "@dlr/database";
import { AliyunOssStorage, requireOssConfig } from "@dlr/storage";

import { backfillFeishuHistory } from "./backfill.js";
import { FeishuExternalPersistence } from "./external-persistence.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, "../../../..");
try {
  process.loadEnvFile(path.join(repositoryRoot, ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const argumentsList = process.argv.slice(2);
const apply = argumentsList.includes("--apply");
const excludedChatIds = argumentsList
  .filter((argument) => argument.startsWith("--exclude-chat="))
  .map((argument) => argument.slice("--exclude-chat=".length))
  .filter(Boolean);
const dataRoot = process.env.FEISHU_DATA_DIR
  ? path.resolve(process.env.FEISHU_DATA_DIR)
  : path.join(repositoryRoot, "collectors/internal/run-data/feishu");

let persistence: FeishuExternalPersistence | undefined;
try {
  if (apply) {
    if (process.env.FEISHU_PERSISTENCE_MODE !== "postgres-oss") {
      throw new Error("--apply 只允许在 FEISHU_PERSISTENCE_MODE=postgres-oss 时执行");
    }
    persistence = new FeishuExternalPersistence(
      new PostgresFeishuRepository(createDatabasePool(requireDatabaseUrl())),
      new AliyunOssStorage(requireOssConfig()),
    );
    await persistence.health();
  }
  const result = await backfillFeishuHistory({ dataRoot, persistence, apply, excludedChatIds });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await persistence?.close();
}
