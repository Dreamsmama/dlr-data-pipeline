export type CollectionStatus = "pending" | "collecting" | "collected" | "failed";

export interface CollectedFile {
  source: "internal" | "ecommerce";
  category: string;
  fileName: string;
  objectKey: string;
  collectedBy: string;
  collectedAt: string;
  status: CollectionStatus;
  metadata?: Record<string, unknown>;
}

export interface EcommerceProductInput {
  platform: string;
  itemId: string;
  sourceUrl: string;
  title: string;
  latestCollectedAt: string;
}

export interface EcommerceObservationInput {
  observationId: string;
  platform: string;
  itemId: string;
  sourceDataset: string;
  collectedAt: string;
  payload: Record<string, unknown>;
  rawProductObjectKey?: string;
  rawJsonObjectKey?: string;
  rawHtmlObjectKey?: string;
}

export interface EcommerceAssetInput {
  sha256: string;
  objectKey: string;
  byteSize: number;
  contentType: string;
}

export interface EcommerceProductAssetInput {
  platform: string;
  itemId: string;
  sha256: string;
  sourceDatasets: string[];
  imageTypes: string[];
  sourceUrls: string[];
  firstCollectedAt: string;
  lastCollectedAt: string;
  needsReview: boolean;
}

export interface EcommerceImageObservationInput {
  observationId: string;
  position: number;
  sha256: string;
  sourceUrl: string;
  imageType: string;
  localPath: string;
  needsReview: boolean;
  alt: string;
  width?: number;
  height?: number;
  status: string;
}

export type EcommerceRawObjectKind = "product_json" | "raw_json" | "raw_html" | "snapshot";

export interface EcommerceRawObjectInput {
  sourceDataset: string;
  itemId: string;
  kind: EcommerceRawObjectKind;
  relativePath: string;
  sha256: string;
  objectKey: string;
  byteSize: number;
  contentType: string;
}

export interface EcommerceImportBatchInput {
  batchId: string;
  platform: string;
  sourceDatasets: string[];
  counts: Record<string, number>;
  products: EcommerceProductInput[];
  observations: EcommerceObservationInput[];
  assets: EcommerceAssetInput[];
  productAssets: EcommerceProductAssetInput[];
  imageObservations: EcommerceImageObservationInput[];
  rawObjects: EcommerceRawObjectInput[];
}

export interface EcommerceImportResult {
  batchId: string;
  counts: Record<string, number>;
}
