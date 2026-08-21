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
