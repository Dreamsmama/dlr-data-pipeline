import { resolve } from "node:path";
import type { CliOptions } from "./types.js";

export function printUsage(): void {
  console.log(`Usage:
  pnpm import:ecommerce -- --full-dir <path> --extension-dir <path> [options]

Options:
  --dry-run             Validate and print the plan without OSS or database writes
  --item-id <id>        Select one item; may be repeated
  --limit <n>           Limit selected item IDs after sorting
  --concurrency <n>     Concurrent OSS uploads (default: 4)
  --help                Show this help`);
}

function positiveInteger(raw: string | undefined, option: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${option} must be a positive integer`);
  return value;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { itemIds: [], concurrency: 4, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--full-dir") options.fullDir = resolve(argv[++index] ?? "");
    else if (argument === "--extension-dir") options.extensionDir = resolve(argv[++index] ?? "");
    else if (argument === "--item-id") options.itemIds.push(argv[++index] ?? "");
    else if (argument === "--limit") options.limit = positiveInteger(argv[++index], argument);
    else if (argument === "--concurrency") options.concurrency = positiveInteger(argv[++index], argument);
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--help") {
      printUsage();
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.fullDir && !options.extensionDir) throw new Error("At least one dataset directory is required");
  if (options.itemIds.some((itemId) => !itemId)) throw new Error("--item-id requires a value");
  return options;
}
