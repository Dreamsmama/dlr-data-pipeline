import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { CatalogProduct, DatasetInput } from "./types.js";

const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function assertItemId(itemId: string): void {
  if (!ITEM_ID_PATTERN.test(itemId)) throw new Error(`Invalid item_id: ${itemId}`);
}

export function assertSha256(sha256: string): void {
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`Invalid SHA256: ${sha256}`);
}

export function resolveInside(root: string, relativePath: string): string {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, relativePath.replaceAll("/", sep));
  if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Path escapes dataset root: ${relativePath}`);
  }
  return absolutePath;
}

function validateProduct(value: unknown, path: string): CatalogProduct {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Product JSON must be an object: ${path}`);
  }
  const product = value as Partial<CatalogProduct>;
  assertItemId(String(product.item_id ?? ""));
  if (typeof product.source_url !== "string" || !/^https:\/\/[^/]+\.tmall\.com\//i.test(product.source_url)) {
    throw new Error(`Invalid Tmall source_url in ${path}`);
  }
  if (typeof product.collected_at !== "string" || Number.isNaN(Date.parse(product.collected_at))) {
    throw new Error(`Invalid collected_at in ${path}`);
  }
  if (typeof product.title !== "string" || !product.title.trim()) {
    throw new Error(`Missing title in ${path}`);
  }
  if (!Array.isArray(product.images)) throw new Error(`Missing images array in ${path}`);
  return product as CatalogProduct;
}

export async function loadDataset(name: string, root: string): Promise<DatasetInput> {
  const absoluteRoot = resolve(root);
  const productsDirectory = resolveInside(absoluteRoot, "products");
  const entries = await readdir(productsDirectory, { withFileTypes: true });
  const products = new Map<string, CatalogProduct>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    assertItemId(entry.name);
    const productPath = resolveInside(absoluteRoot, `products/${entry.name}/product.json`);
    const product = validateProduct(JSON.parse(await readFile(productPath, "utf8")), productPath);
    if (product.item_id !== entry.name) throw new Error(`Directory/item_id mismatch: ${productPath}`);
    products.set(entry.name, product);
  }
  return { name, root: absoluteRoot, products };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function fileMetadata(path: string): Promise<{ sha256: string; byteSize: number }> {
  const [sha256, metadata] = await Promise.all([sha256File(path), stat(path)]);
  if (!metadata.isFile()) throw new Error(`Not a file: ${path}`);
  return { sha256, byteSize: metadata.size };
}

export function relativePosix(root: string, path: string): string {
  return relative(resolve(root), resolve(path)).split(sep).join("/");
}

export function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".json": return "application/json";
    case ".html": return "text/html; charset=utf-8";
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".avif": return "image/avif";
    default: return "image/jpeg";
  }
}
