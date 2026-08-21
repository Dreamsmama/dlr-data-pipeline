export type StorageArea = "internal" | "ecommerce";

export function objectKey(area: StorageArea, category: string, fileName: string): string {
  const clean = (part: string) => part.replace(/^\/+|\/+$/g, "");
  return ["dlr", area, clean(category), clean(fileName)].join("/");
}
