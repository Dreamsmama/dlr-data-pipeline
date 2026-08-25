import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import OSS from "ali-oss";

export type StorageArea = "internal" | "ecommerce";

export interface OssConfig {
  region: string;
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
}

export interface StoredObject {
  bucket: string;
  objectKey: string;
  etag: string;
}

export interface StoredObjectStream {
  stream: Readable;
  statusCode: number;
  contentType: string;
  contentLength: string;
  contentRange: string;
  acceptRanges: string;
  etag: string;
  lastModified: string;
}

export interface ObjectStorage {
  readonly bucket: string;
  uploadFile(objectKey: string, filePath: string): Promise<StoredObject>;
  createSignedDownloadUrl?(
    objectKey: string,
    fileName: string,
    download?: boolean,
    expiresSeconds?: number,
  ): string;
  getObjectStream?(objectKey: string, range?: string): Promise<StoredObjectStream>;
  verifyConnection(): Promise<void>;
}

function cleanSegment(value: string): string {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/^\/+|\/+$/g, "");
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

export function objectKey(area: StorageArea, category: string, fileName: string): string {
  const categoryPath = cleanSegment(category);
  const cleanFileName = cleanSegment(fileName) || "unnamed";
  if (!categoryPath) throw new Error("OSS 对象分类不能为空");
  return ["dlr", area, categoryPath, cleanFileName].join("/");
}

export function requireOssConfig(environment: NodeJS.ProcessEnv = process.env): OssConfig {
  const values = {
    region: environment.ALIYUN_OSS_REGION?.trim() ?? "",
    endpoint: environment.ALIYUN_OSS_ENDPOINT?.trim() ?? "",
    accessKeyId: environment.ALIYUN_OSS_ACCESS_KEY_ID?.trim() ?? "",
    accessKeySecret: environment.ALIYUN_OSS_ACCESS_KEY_SECRET ?? "",
    bucket: environment.ALIYUN_OSS_BUCKET_NAME?.trim() ?? "",
  };
  const missing = Object.entries(values).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`OSS 配置不完整：${missing.join(", ")}`);
  const endpoint = values.endpoint.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!/^[a-z0-9][a-z0-9.-]+$/i.test(endpoint)) throw new Error("ALIYUN_OSS_ENDPOINT 格式不合法");
  return { ...values, endpoint };
}

export class AliyunOssStorage implements ObjectStorage {
  readonly bucket: string;
  readonly #client: OSS;

  constructor(readonly config: OssConfig) {
    this.bucket = config.bucket;
    this.#client = new OSS({
      region: config.region,
      endpoint: config.endpoint,
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      bucket: config.bucket,
      secure: true,
      timeout: 120_000,
    });
  }

  async uploadFile(key: string, filePath: string): Promise<StoredObject> {
    const normalizedKey = cleanSegment(key);
    if (!normalizedKey || normalizedKey !== key.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")) {
      throw new Error("OSS Object Key 不合法");
    }
    const result = await this.#client.put(normalizedKey, filePath);
    const headers = result.res.headers as Record<string, string | string[] | undefined>;
    const rawEtag = String(headers.etag ?? headers.ETag ?? "");
    return { bucket: this.bucket, objectKey: normalizedKey, etag: rawEtag.replace(/^\"|\"$/g, "") };
  }

  createSignedDownloadUrl(
    key: string,
    fileName: string,
    download = false,
    expiresSeconds = 300,
  ): string {
    const normalizedKey = cleanSegment(key);
    if (!normalizedKey || normalizedKey !== key.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")) {
      throw new Error("OSS Object Key 不合法");
    }
    const expires = Math.min(900, Math.max(30, Math.trunc(expiresSeconds)));
    const disposition = download ? "attachment" : "inline";
    return this.#client.signatureUrl(normalizedKey, {
      expires,
      response: {
        "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName || "download")}`,
      },
    });
  }

  async getObjectStream(key: string, range?: string): Promise<StoredObjectStream> {
    const normalizedKey = cleanSegment(key);
    if (!normalizedKey || normalizedKey !== key.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")) {
      throw new Error("OSS Object Key 不合法");
    }
    const result = await this.#client.getStream(normalizedKey, {
      timeout: 120_000,
      ...(range ? { headers: { Range: range } } : {}),
    });
    if (!result.stream) throw new Error("OSS 对象内容不可用");
    const headers = result.res.headers as Record<string, string | string[] | undefined>;
    return {
      stream: result.stream as Readable,
      statusCode: result.res.status,
      contentType: headerValue(headers, "content-type"),
      contentLength: headerValue(headers, "content-length"),
      contentRange: headerValue(headers, "content-range"),
      acceptRanges: headerValue(headers, "accept-ranges"),
      etag: headerValue(headers, "etag"),
      lastModified: headerValue(headers, "last-modified"),
    };
  }

  async verifyConnection(): Promise<void> {
    const key = objectKey("internal", "_healthchecks", `${randomUUID()}.txt`);
    await this.#client.put(key, Buffer.from("dlr-oss-healthcheck", "utf8"));
    try {
      await this.#client.head(key);
    } finally {
      await this.#client.delete(key).catch(() => undefined);
    }
  }
}

export interface OssStorageConfig {
  region: string;
  endpoint?: string;
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
}

export interface PutFileResult {
  objectKey: string;
  status: "uploaded" | "reused";
}

interface OssError extends Error {
  status?: number;
  code?: string;
}

export function ecommerceAssetObjectKey(platform: string, sha256: string): string {
  return objectKey("ecommerce", `${platform}/assets/sha256/${sha256.slice(0, 2)}`, sha256);
}

export function ecommerceRawObjectKey(platform: string, sha256: string): string {
  return objectKey("ecommerce", `${platform}/raw/sha256/${sha256.slice(0, 2)}`, sha256);
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function ossConfigFromEnvironment(): OssStorageConfig {
  return {
    region: requireEnvironment("ALIYUN_OSS_REGION"),
    endpoint: process.env.ALIYUN_OSS_ENDPOINT || undefined,
    accessKeyId: requireEnvironment("ALIYUN_OSS_ACCESS_KEY_ID"),
    accessKeySecret: requireEnvironment("ALIYUN_OSS_ACCESS_KEY_SECRET"),
    bucket: requireEnvironment("ALIYUN_OSS_BUCKET_NAME"),
  };
}

export class OssObjectStorage {
  private readonly client: OSS;

  constructor(config = ossConfigFromEnvironment()) {
    this.client = new OSS({
      region: config.region,
      endpoint: config.endpoint,
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      bucket: config.bucket,
      secure: true,
    });
  }

  private async assertExistingObject(objectName: string, sha256: string): Promise<void> {
    const result = await this.client.head(objectName);
    const metadata = result.meta as unknown as Record<string, string | undefined>;
    if (metadata.sha256 !== sha256) {
      throw new Error(`OSS object ${objectName} has missing or conflicting SHA256 metadata`);
    }
  }

  async putFileIfAbsent(
    objectName: string,
    localPath: string,
    contentType: string,
    sha256: string,
  ): Promise<PutFileResult> {
    try {
      await this.assertExistingObject(objectName, sha256);
      return { objectKey: objectName, status: "reused" };
    } catch (error) {
      const ossError = error as OssError;
      if (ossError.status !== 404 && ossError.code !== "NoSuchKey") throw error;
    }

    try {
      await this.client.put(objectName, localPath, {
        mime: contentType,
        headers: {
          "x-oss-forbid-overwrite": "true",
          "x-oss-meta-sha256": sha256,
        },
      });
      return { objectKey: objectName, status: "uploaded" };
    } catch (error) {
      const ossError = error as OssError;
      if (ossError.status === 412 || ossError.code === "PreconditionFailed") {
        await this.assertExistingObject(objectName, sha256);
        return { objectKey: objectName, status: "reused" };
      }
      throw error;
    }
  }
}
