import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { loadEnvFile } from "node:process";
import cors from "@fastify/cors";
import Fastify from "fastify";
import {
  createDatabasePool,
  getEcommerceProduct,
  getEcommerceSummary,
  listEcommerceFiles,
  listEcommerceImports,
  listEcommerceProducts,
  type DatabasePool,
} from "@dlr/database";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
try {
  loadEnvFile(resolve(repositoryRoot, ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const app = Fastify({ logger: true });
const port = Number(process.env.API_PORT ?? 3001);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const allowedImportRoot = resolve(process.env.ECOMMERCE_IMPORT_ALLOWED_ROOT ?? resolve(repositoryRoot, ".."));
let pool: DatabasePool | undefined;

interface ImportJob {
  jobId: string;
  status: "running" | "completed" | "failed";
  dryRun: boolean;
  sourceDirectories: string[];
  startedAt: string;
  finishedAt: string | null;
  output: string[];
  error: string | null;
}

const importJobs = new Map<string, ImportJob>();

function database(): DatabasePool {
  pool ??= createDatabasePool();
  return pool;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("DATABASE_URL")) return "数据库尚未配置，请先设置 DATABASE_URL";
  return message;
}

function allowedImageDownloadUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const allowedDomains = ["alicdn.com", "alicdn.net", "tbcdn.cn", "taobaocdn.com"];
    const allowedHost = allowedDomains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
    return url.protocol === "https:" && allowedHost ? url : null;
  } catch {
    return null;
  }
}

function imageExtension(contentType: string): string {
  const extensions: Record<string, string> = {
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  return extensions[contentType] ?? "img";
}

function assertAllowedDirectory(input: string): string {
  if (!input.trim() || input.length > 500) throw new Error("数据目录不能为空或过长");
  const directory = resolve(input);
  const pathFromRoot = relative(allowedImportRoot, directory);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`数据目录必须位于 ${allowedImportRoot} 内`);
  }
  return directory;
}

async function inspectSource(name: string, path: string): Promise<{
  name: string;
  path: string;
  available: boolean;
  products: number;
}> {
  try {
    const productsDirectory = resolve(path, "products");
    const metadata = await stat(productsDirectory);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(productsDirectory, { withFileTypes: true });
    return { name, path, available: true, products: entries.filter((entry) => entry.isDirectory()).length };
  } catch {
    return { name, path, available: false, products: 0 };
  }
}

function appendOutput(job: ImportJob, chunk: unknown): void {
  const lines = String(chunk).split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  job.output.push(...lines);
  if (job.output.length > 120) job.output.splice(0, job.output.length - 120);
}

function startImport(options: {
  fullDir?: string;
  extensionDir?: string;
  limit?: number;
  dryRun: boolean;
}): ImportJob {
  const pnpmEntry = process.env.npm_execpath;
  if (!pnpmEntry) throw new Error("无法定位 pnpm 运行入口");
  const sourceDirectories = [options.fullDir, options.extensionDir].filter((value): value is string => Boolean(value));
  const job: ImportJob = {
    jobId: randomUUID(),
    status: "running",
    dryRun: options.dryRun,
    sourceDirectories,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    output: [],
    error: null,
  };
  importJobs.set(job.jobId, job);

  const args = ["--filter", "@dlr/ecommerce-collector", "exec", "tsx", "src/index.ts", "--"];
  if (options.fullDir) args.push("--full-dir", options.fullDir);
  if (options.extensionDir) args.push("--extension-dir", options.extensionDir);
  if (options.limit) args.push("--limit", String(options.limit));
  if (options.dryRun) args.push("--dry-run");
  const child = spawn(process.execPath, [pnpmEntry, ...args], {
    cwd: repositoryRoot,
    env: process.env,
    shell: false,
  });
  child.stdout.on("data", (chunk) => appendOutput(job, chunk));
  child.stderr.on("data", (chunk) => appendOutput(job, chunk));
  child.on("error", (error) => {
    job.status = "failed";
    job.error = safeMessage(error);
    job.finishedAt = new Date().toISOString();
  });
  child.on("close", (code) => {
    if (job.finishedAt) return;
    job.status = code === 0 ? "completed" : "failed";
    job.error = code === 0 ? null : job.output.at(-1) ?? `导入进程退出码 ${code}`;
    job.finishedAt = new Date().toISOString();
  });
  return job;
}

await app.register(cors, { origin: webOrigin });

app.get("/health", async () => ({ status: "ok", service: "dlr-api" }));

app.get("/api/summary", async (_request, reply) => {
  try {
    return { configured: true, ...(await getEcommerceSummary(database())) };
  } catch (error) {
    reply.code(503);
    return { configured: false, products: 0, assets: 0, rawFiles: 0, imports: 0, needsReview: 0, error: safeMessage(error) };
  }
});

app.get<{ Querystring: { q?: string; review?: string; brand?: string; category?: string; page?: string; pageSize?: string } }>(
  "/api/ecommerce/products",
  async (request, reply) => {
    try {
      const page = integer(request.query.page, 1, 1, 100000);
      const pageSize = integer(request.query.pageSize, 24, 1, 100);
      const review = request.query.review === "pending" ? "pending" : "all";
      return await listEcommerceProducts(database(), {
        search: String(request.query.q ?? "").slice(0, 100),
        review,
        brand: String(request.query.brand ?? "all").slice(0, 100),
        category: String(request.query.category ?? "all").slice(0, 100),
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
    } catch (error) {
      reply.code(503);
      return { items: [], total: 0, brands: [], categories: [], error: safeMessage(error) };
    }
  },
);

app.get<{ Params: { itemId: string } }>("/api/ecommerce/products/:itemId", async (request, reply) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.params.itemId)) return reply.code(400).send({ error: "无效的商品 ID" });
  try {
    const product = await getEcommerceProduct(database(), request.params.itemId);
    return product ?? reply.code(404).send({ error: "未找到商品" });
  } catch (error) {
    return reply.code(503).send({ error: safeMessage(error) });
  }
});

app.get<{ Params: { itemId: string; sha256: string } }>("/api/ecommerce/products/:itemId/images/:sha256/download", async (request, reply) => {
  const { itemId, sha256 } = request.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(itemId) || !/^[a-f0-9]{64}$/i.test(sha256)) {
    return reply.code(400).send({ error: "无效的图片下载参数" });
  }

  let product: Awaited<ReturnType<typeof getEcommerceProduct>>;
  try {
    product = await getEcommerceProduct(database(), itemId);
  } catch (error) {
    return reply.code(503).send({ error: safeMessage(error) });
  }
  if (!product) return reply.code(404).send({ error: "未找到商品" });

  const image = product.images.find((candidate) => candidate.sha256 === sha256);
  if (!image) return reply.code(404).send({ error: "未找到商品图片" });
  const sourceUrl = allowedImageDownloadUrl(image.sourceUrl);
  if (!sourceUrl) return reply.code(400).send({ error: "该图片来源不支持下载" });

  try {
    const upstream = await fetch(sourceUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { referer: product.sourceUrl, "user-agent": "Mozilla/5.0 DLR-Data-Pipeline/0.1" },
    });
    if (!upstream.ok) return reply.code(502).send({ error: `图片源站返回 ${upstream.status}` });

    const contentType = upstream.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    if (!contentType.startsWith("image/")) return reply.code(502).send({ error: "图片源站返回了非图片内容" });
    const declaredLength = Number(upstream.headers.get("content-length") ?? 0);
    const maximumBytes = 20 * 1024 * 1024;
    if (declaredLength > maximumBytes) return reply.code(413).send({ error: "图片超过 20 MB 下载限制" });

    const content = Buffer.from(await upstream.arrayBuffer());
    if (content.byteLength > maximumBytes) return reply.code(413).send({ error: "图片超过 20 MB 下载限制" });
    const extension = imageExtension(contentType);
    const fallbackName = `${image.imageType}-${itemId}-${sha256.slice(0, 12)}.${extension}`;
    const displayName = `${image.alt || image.imageType}-${itemId}.${extension}`;
    return reply
      .header("content-type", contentType)
      .header("content-length", content.byteLength)
      .header("content-disposition", `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(displayName)}`)
      .send(content);
  } catch (error) {
    return reply.code(502).send({ error: `图片下载失败：${safeMessage(error)}` });
  }
});

app.get<{ Querystring: { q?: string; kind?: string; page?: string; pageSize?: string } }>(
  "/api/ecommerce/files",
  async (request, reply) => {
    try {
      const page = integer(request.query.page, 1, 1, 100000);
      const pageSize = integer(request.query.pageSize, 30, 1, 100);
      const allowedKinds = new Set(["all", "main", "detail", "sku", "product_json", "raw_json", "raw_html", "snapshot"]);
      const kind = allowedKinds.has(request.query.kind ?? "all") ? request.query.kind ?? "all" : "all";
      return await listEcommerceFiles(database(), {
        search: String(request.query.q ?? "").slice(0, 100),
        kind,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
    } catch (error) {
      reply.code(503);
      return { items: [], total: 0, error: safeMessage(error) };
    }
  },
);

app.get("/api/ecommerce/imports", async () => {
  const defaultFull = resolve(allowedImportRoot, "data-diluowei-full");
  const defaultExtension = resolve(allowedImportRoot, "data-extension", "catalog");
  const [sources, batches] = await Promise.all([
    Promise.all([
      inspectSource("完整采集", process.env.ECOMMERCE_FULL_DATA_DIR ?? defaultFull),
      inspectSource("扩展采集", process.env.ECOMMERCE_EXTENSION_DATA_DIR ?? defaultExtension),
    ]),
    listEcommerceImports(database()).catch(() => []),
  ]);
  return { allowedImportRoot, sources, jobs: [...importJobs.values()].reverse(), batches };
});

app.post<{
  Body: { fullDir?: string; extensionDir?: string; limit?: number; dryRun?: boolean };
}>("/api/ecommerce/imports", {
  schema: {
    body: {
      type: "object",
      additionalProperties: false,
      properties: {
        fullDir: { type: "string", maxLength: 500 },
        extensionDir: { type: "string", maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 10000 },
        dryRun: { type: "boolean" },
      },
    },
  },
}, async (request, reply) => {
  if ([...importJobs.values()].some((job) => job.status === "running")) {
    return reply.code(409).send({ error: "已有导入任务正在运行" });
  }
  try {
    const fullDir = request.body.fullDir ? assertAllowedDirectory(request.body.fullDir) : undefined;
    const extensionDir = request.body.extensionDir ? assertAllowedDirectory(request.body.extensionDir) : undefined;
    if (!fullDir && !extensionDir) return reply.code(400).send({ error: "至少选择一个数据源" });
    await Promise.all([fullDir, extensionDir].filter((value): value is string => Boolean(value)).map(async (directory) => {
      const metadata = await stat(resolve(directory, "products"));
      if (!metadata.isDirectory()) throw new Error(`${directory} 缺少 products 目录`);
    }));
    const job = startImport({ fullDir, extensionDir, limit: request.body.limit, dryRun: request.body.dryRun ?? false });
    return reply.code(202).send(job);
  } catch (error) {
    return reply.code(400).send({ error: safeMessage(error) });
  }
});

app.addHook("onClose", async () => {
  await pool?.end();
});

await app.listen({ port, host: "0.0.0.0" });
