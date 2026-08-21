import OSS from "ali-oss";

export type StorageArea = "internal" | "ecommerce";

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

export function objectKey(area: StorageArea, category: string, fileName: string): string {
  const clean = (part: string) => part.replace(/^\/+|\/+$/g, "");
  return ["dlr", area, clean(category), clean(fileName)].join("/");
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
