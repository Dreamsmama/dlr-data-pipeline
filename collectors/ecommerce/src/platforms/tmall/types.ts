import type { EcommerceImportBatchInput } from "@dlr/schemas";

export interface CatalogImage {
  source_url: string;
  type: string;
  needs_review: boolean;
  alt?: string;
  width?: number;
  height?: number;
  local_path: string;
  sha256: string;
  status: string;
  error?: string | null;
}

export interface CatalogProduct extends Record<string, unknown> {
  item_id: string;
  source_url: string;
  collected_at: string;
  title: string;
  images: CatalogImage[];
}

export interface DatasetInput {
  name: string;
  root: string;
  products: Map<string, CatalogProduct>;
}

export interface PlannedUpload {
  objectKey: string;
  localPath: string;
  contentType: string;
  sha256: string;
  byteSize: number;
  kind: "asset" | "raw";
}

export interface ImportPlan {
  batch: EcommerceImportBatchInput;
  uploads: PlannedUpload[];
}

export interface CliOptions {
  fullDir?: string;
  extensionDir?: string;
  itemIds: string[];
  limit?: number;
  concurrency: number;
  dryRun: boolean;
}
