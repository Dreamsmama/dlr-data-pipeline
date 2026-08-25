import path from "node:path";
import { fileURLToPath } from "node:url";

import { AliyunOssStorage, requireOssConfig } from "./index.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, "../../..");
try {
  process.loadEnvFile(path.join(repositoryRoot, ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const config = requireOssConfig();
const storage = new AliyunOssStorage(config);
await storage.verifyConnection();
process.stdout.write(JSON.stringify({ status: "ok", bucket: config.bucket, endpoint: config.endpoint }) + "\n");
