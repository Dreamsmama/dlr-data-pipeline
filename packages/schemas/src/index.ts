export type CollectionStatus = "pending" | "collecting" | "collected" | "failed";

const ECOMMERCE_CATEGORY_RULES: Array<[RegExp, string]> = [
  [/素颜霜/, "素颜霜"],
  [/气垫/, "气垫"],
  [/(?:散粉|蜜粉)/, "散粉"],
  [/粉底液/, "粉底液"],
  [/隔离/, "隔离霜"],
  [/遮瑕/, "遮瑕"],
  [/(?:口红|唇釉)/, "唇妆"],
  [/眼影/, "眼影"],
  [/睫毛膏/, "睫毛膏"],
];

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export interface EcommerceClassification {
  brand?: string;
  category?: string;
  shop?: string;
}

export function deriveEcommerceClassification(product: Record<string, unknown>): EcommerceClassification {
  const attributes = objectValue(product.attributes);
  const shop = objectValue(product.shop);
  const title = nonEmptyText(product.title) ?? "";
  const explicitCategory = nonEmptyText(
    product.category,
    attributes["商品分类"],
    attributes["叶子类目"],
    attributes["分类"],
    attributes["遮瑕分类"],
  );
  return {
    brand: nonEmptyText(product.brand, attributes["品牌"]),
    category: explicitCategory ?? ECOMMERCE_CATEGORY_RULES.find(([pattern]) => pattern.test(title))?.[1],
    shop: nonEmptyText(shop.name, shop.seller_nick),
  };
}

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
  brand?: string;
  category?: string;
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
