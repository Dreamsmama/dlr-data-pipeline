import { createHash, randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { deriveEcommerceClassification } from "@dlr/schemas";
import type {
  EcommerceClassification,
  EcommerceAssetInput,
  EcommerceImageObservationInput,
  EcommerceObservationInput,
  EcommerceProductAssetInput,
  EcommerceProductInput,
  EcommerceRawObjectInput,
  EcommerceRawObjectKind,
} from "@dlr/schemas";
import { ecommerceAssetObjectKey, ecommerceRawObjectKey } from "@dlr/storage";
import { assertSha256, contentType, fileMetadata, relativePosix, resolveInside } from "./catalog.js";
import type { CatalogProduct, DatasetInput, ImportPlan, PlannedUpload } from "./types.js";

const PLATFORM = "tmall";

interface MutableRelation {
  platform: string;
  itemId: string;
  sha256: string;
  sourceDatasets: Set<string>;
  imageTypes: Set<string>;
  sourceUrls: Set<string>;
  firstCollectedAt: string;
  lastCollectedAt: string;
  needsReview: boolean;
}

function observationId(dataset: string, itemId: string, collectedAt: string): string {
  return createHash("sha256").update(`${dataset}\0${itemId}\0${collectedAt}`).digest("hex");
}

function chooseItemIds(datasets: DatasetInput[], requested: string[], limit?: number): string[] {
  const available = new Set(datasets.flatMap((dataset) => [...dataset.products.keys()]));
  const selected = requested.length ? [...new Set(requested)] : [...available].sort();
  for (const itemId of selected) {
    if (!available.has(itemId)) throw new Error(`Requested item_id not found: ${itemId}`);
  }
  return limit === undefined ? selected : selected.slice(0, limit);
}

async function addRawObject(
  dataset: DatasetInput,
  itemId: string,
  kind: EcommerceRawObjectKind,
  absolutePath: string,
  rawObjects: EcommerceRawObjectInput[],
  uploads: Map<string, PlannedUpload>,
): Promise<EcommerceRawObjectInput | undefined> {
  const metadata = await stat(absolutePath);
  if (!metadata.isFile()) throw new Error(`Raw path is not a file: ${absolutePath}`);
  if (metadata.size === 0) return undefined;
  const { sha256, byteSize } = await fileMetadata(absolutePath);
  const objectKey = ecommerceRawObjectKey(PLATFORM, sha256);
  const raw: EcommerceRawObjectInput = {
    sourceDataset: dataset.name,
    itemId,
    kind,
    relativePath: relativePosix(dataset.root, absolutePath),
    sha256,
    objectKey,
    byteSize,
    contentType: contentType(absolutePath),
  };
  rawObjects.push(raw);
  uploads.set(objectKey, {
    objectKey,
    localPath: absolutePath,
    contentType: raw.contentType,
    sha256,
    byteSize,
    kind: "raw",
  });
  return raw;
}

function setRawKey(
  observation: EcommerceObservationInput,
  kind: EcommerceRawObjectKind,
  raw: EcommerceRawObjectInput | undefined,
): void {
  if (!raw) return;
  if (kind === "product_json") observation.rawProductObjectKey = raw.objectKey;
  if (kind === "raw_json") observation.rawJsonObjectKey = raw.objectKey;
  if (kind === "raw_html") observation.rawHtmlObjectKey = raw.objectKey;
}

async function addProductRawObjects(
  dataset: DatasetInput,
  product: CatalogProduct,
  observation: EcommerceObservationInput,
  rawObjects: EcommerceRawObjectInput[],
  uploads: Map<string, PlannedUpload>,
): Promise<number> {
  let skippedEmpty = 0;
  const directory = `products/${product.item_id}`;
  for (const [kind, fileName] of [
    ["product_json", "product.json"],
    ["raw_json", "raw.json"],
    ["raw_html", "raw.html"],
  ] as const) {
    const path = resolveInside(dataset.root, `${directory}/${fileName}`);
    const raw = await addRawObject(dataset, product.item_id, kind, path, rawObjects, uploads);
    if (!raw) skippedEmpty += 1;
    setRawKey(observation, kind, raw);
  }
  const snapshotsDirectory = resolve(dataset.root, "snapshots");
  for (const name of await readdir(snapshotsDirectory)) {
    if (!name.startsWith(`${product.item_id}_`) || !name.endsWith(".json")) continue;
    await addRawObject(
      dataset,
      product.item_id,
      "snapshot",
      resolveInside(dataset.root, `snapshots/${basename(name)}`),
      rawObjects,
      uploads,
    );
  }
  return skippedEmpty;
}

export async function buildImportPlan(
  datasets: DatasetInput[],
  requestedItemIds: string[],
  limit?: number,
): Promise<ImportPlan> {
  if (!datasets.length) throw new Error("At least one dataset is required");
  const selectedItemIds = chooseItemIds(datasets, requestedItemIds, limit);
  const products = new Map<string, EcommerceProductInput>();
  const observations: EcommerceObservationInput[] = [];
  const assets = new Map<string, EcommerceAssetInput>();
  const relations = new Map<string, MutableRelation>();
  const imageObservations: EcommerceImageObservationInput[] = [];
  const rawObjects: EcommerceRawObjectInput[] = [];
  const uploads = new Map<string, PlannedUpload>();
  const verifiedPaths = new Map<string, string>();
  let skippedEmptyFiles = 0;

  const brandsByShop = new Map<string, string>();
  for (const dataset of datasets) {
    for (const product of dataset.products.values()) {
      const { shop, brand } = deriveEcommerceClassification(product);
      if (shop && brand && !brandsByShop.has(shop)) brandsByShop.set(shop, brand);
    }
  }

  for (const dataset of datasets) {
    for (const itemId of selectedItemIds) {
      const product = dataset.products.get(itemId);
      if (!product) continue;
      const current = products.get(itemId);
      const classification: EcommerceClassification = deriveEcommerceClassification(product);
      const brand = classification.brand ?? (classification.shop ? brandsByShop.get(classification.shop) : undefined);
      const { category } = classification;
      if (!current || Date.parse(product.collected_at) > Date.parse(current.latestCollectedAt)) {
        products.set(itemId, {
          platform: PLATFORM,
          itemId,
          sourceUrl: product.source_url,
          title: product.title,
          latestCollectedAt: product.collected_at,
          brand: brand ?? current?.brand,
          category: category ?? current?.category,
        });
      } else {
        current.brand ??= brand;
        current.category ??= category;
      }
      const id = observationId(dataset.name, itemId, product.collected_at);
      const observation: EcommerceObservationInput = {
        observationId: id,
        platform: PLATFORM,
        itemId,
        sourceDataset: dataset.name,
        collectedAt: product.collected_at,
        payload: product,
      };
      observations.push(observation);
      skippedEmptyFiles += await addProductRawObjects(dataset, product, observation, rawObjects, uploads);

      for (const [position, image] of product.images.entries()) {
        if (image.status !== "downloaded" && image.status !== "duplicate") {
          console.warn(
            `${dataset.name}/${itemId} image ${position} skipped because status is ${image.status}`,
          );
          continue;
        }
        if (image.error) throw new Error(`${dataset.name}/${itemId} image ${position} still has an error`);
        assertSha256(image.sha256);
        const localPath = resolveInside(dataset.root, image.local_path);
        let actualSha256 = verifiedPaths.get(localPath);
        let byteSize: number;
        if (!actualSha256) {
          const metadata = await fileMetadata(localPath);
          actualSha256 = metadata.sha256;
          byteSize = metadata.byteSize;
          verifiedPaths.set(localPath, actualSha256);
        } else {
          byteSize = (await stat(localPath)).size;
        }
        if (actualSha256 !== image.sha256) throw new Error(`SHA256 mismatch: ${image.local_path}`);
        const objectKey = ecommerceAssetObjectKey(PLATFORM, image.sha256);
        const mime = contentType(localPath);
        const existingAsset = assets.get(image.sha256);
        if (existingAsset && existingAsset.byteSize !== byteSize) {
          throw new Error(`Conflicting byte size for SHA256 ${image.sha256}`);
        }
        assets.set(image.sha256, { sha256: image.sha256, objectKey, byteSize, contentType: mime });
        uploads.set(objectKey, {
          objectKey,
          localPath,
          contentType: mime,
          sha256: image.sha256,
          byteSize,
          kind: "asset",
        });
        imageObservations.push({
          observationId: id,
          position,
          sha256: image.sha256,
          sourceUrl: image.source_url,
          imageType: image.type,
          localPath: image.local_path,
          needsReview: Boolean(image.needs_review),
          alt: image.alt ?? "",
          width: image.width,
          height: image.height,
          status: image.status,
        });
        const relationKey = `${itemId}\0${image.sha256}`;
        const relation = relations.get(relationKey) ?? {
          platform: PLATFORM,
          itemId,
          sha256: image.sha256,
          sourceDatasets: new Set<string>(),
          imageTypes: new Set<string>(),
          sourceUrls: new Set<string>(),
          firstCollectedAt: product.collected_at,
          lastCollectedAt: product.collected_at,
          needsReview: false,
        };
        relation.sourceDatasets.add(dataset.name);
        relation.imageTypes.add(image.type);
        relation.sourceUrls.add(image.source_url);
        if (Date.parse(product.collected_at) < Date.parse(relation.firstCollectedAt)) relation.firstCollectedAt = product.collected_at;
        if (Date.parse(product.collected_at) > Date.parse(relation.lastCollectedAt)) relation.lastCollectedAt = product.collected_at;
        relation.needsReview ||= Boolean(image.needs_review);
        relations.set(relationKey, relation);
      }
    }
  }

  const productAssets: EcommerceProductAssetInput[] = [...relations.values()].map((relation) => ({
    platform: relation.platform,
    itemId: relation.itemId,
    sha256: relation.sha256,
    sourceDatasets: [...relation.sourceDatasets].sort(),
    imageTypes: [...relation.imageTypes].sort(),
    sourceUrls: [...relation.sourceUrls].sort(),
    firstCollectedAt: relation.firstCollectedAt,
    lastCollectedAt: relation.lastCollectedAt,
    needsReview: relation.needsReview,
  }));
  const plannedUploads = [...uploads.values()];
  const counts = {
    products: products.size,
    observations: observations.length,
    imageObservations: imageObservations.length,
    assets: assets.size,
    productAssets: productAssets.length,
    rawObjects: rawObjects.length,
    uploadObjects: plannedUploads.length,
    skippedEmptyFiles,
    uploadBytes: plannedUploads.reduce((total, upload) => total + upload.byteSize, 0),
  };
  return {
    batch: {
      batchId: randomUUID(),
      platform: PLATFORM,
      sourceDatasets: datasets.map((dataset) => dataset.name),
      counts,
      products: [...products.values()],
      observations,
      assets: [...assets.values()],
      productAssets,
      imageObservations,
      rawObjects,
    },
    uploads: plannedUploads,
  };
}
