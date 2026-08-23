export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export interface Summary {
  configured: boolean;
  products: number;
  assets: number;
  rawFiles: number;
  imports: number;
  needsReview: number;
  error?: string;
}

export interface ProductListItem {
  platform: string;
  itemId: string;
  title: string;
  sourceUrl: string;
  latestCollectedAt: string;
  sourceDataset: string | null;
  thumbnailUrl: string | null;
  imageCount: number;
  needsReview: boolean;
  price: number | null;
  sales: number | null;
  brand: string | null;
  category: string | null;
}

export interface ProductDetail extends ProductListItem {
  payload: Record<string, unknown>;
  images: Array<{
    sha256: string;
    objectKey: string;
    sourceUrl: string;
    imageType: string;
    localPath: string;
    alt: string;
    width: number | null;
    height: number | null;
    needsReview: boolean;
  }>;
  rawFiles: Array<{
    sha256: string;
    objectKey: string;
    kind: string;
    relativePath: string;
    byteSize: number;
    contentType: string;
    sourceDataset: string;
  }>;
}

export interface FileItem {
  sha256: string;
  objectKey: string;
  kind: string;
  byteSize: number;
  contentType: string;
  itemId: string;
  productTitle: string;
  sourceDataset: string | null;
  sourceUrl: string | null;
  needsReview: boolean;
}

export interface ImportBatch {
  batchId: string;
  platform: string;
  sourceDatasets: string[];
  status: "running" | "completed" | "failed";
  counts: Record<string, number>;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ImportJob {
  jobId: string;
  status: "running" | "completed" | "failed";
  dryRun: boolean;
  sourceDirectories: string[];
  startedAt: string;
  finishedAt: string | null;
  output: string[];
  error: string | null;
}

export interface ImportOverview {
  allowedImportRoot: string;
  sources: Array<{ name: string; path: string; available: boolean; products: number }>;
  jobs: ImportJob[];
  batches: ImportBatch[];
}

export function formatNumber(value: number | null): string {
  if (value === null) return "--";
  return new Intl.NumberFormat("zh-CN", { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
