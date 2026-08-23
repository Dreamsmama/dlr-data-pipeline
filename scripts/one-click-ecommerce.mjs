import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function usage() {
  console.log(`Usage:
  pnpm collect:ecommerce:one-click -- --shop-url <https-url> [options]
  pnpm collect:ecommerce:one-click -- --resume [options]

Options:
  --shop-url <url>       HTTPS Taobao/Tmall store or product URL
  --resume               Resume the unfinished extension task
  --max-pages <n>        Listing pages (default: 1)
  --max-products <n>     Products (default: 20)
  --max-images <n>       Images per product (default: 40)
  --wait-ms <n>          Page wait interval (default: 3500)
  --timeout-ms <n>       Collection timeout (default: 1800000)
  --port <n>             Chrome CDP port (default: 9333)
  --export-path <path>   Extension JSON output path
  --catalog-path <path>  Standard catalog output directory
  --manual-wait          Pause for manual login/security verification
  --skip-images          Do not download images during import
  --skip-import          Stop after writing the extension JSON export
  --help                 Show this help
`);
}

function parseArgs(argv) {
  const result = {
    shopUrl: null,
    resume: false,
    maxPages: 1,
    maxProducts: 20,
    maxImages: 40,
    waitMs: 3500,
    timeoutMs: 1800000,
    port: 9333,
    exportPath: "collectors/ecommerce/data/extension/latest.json",
    catalogPath: "collectors/ecommerce/data/extension/catalog",
    manualWait: false,
    skipImages: false,
    skipImport: false
  };
  const values = new Map([
    ["--shop-url", "shopUrl"], ["--max-pages", "maxPages"], ["--max-products", "maxProducts"],
    ["--max-images", "maxImages"], ["--wait-ms", "waitMs"], ["--timeout-ms", "timeoutMs"],
    ["--port", "port"], ["--export-path", "exportPath"], ["--catalog-path", "catalogPath"]
  ]);
  const aliases = new Map([
    ["-shopurl", "--shop-url"], ["-maxpages", "--max-pages"], ["-maxproducts", "--max-products"],
    ["-maximages", "--max-images"], ["-waitms", "--wait-ms"], ["-timeoutms", "--timeout-ms"],
    ["-port", "--port"], ["-exportpath", "--export-path"], ["-catalogpath", "--catalog-path"],
    ["-resume", "--resume"], ["-manualwait", "--manual-wait"], ["-skipimages", "--skip-images"],
    ["-skipimport", "--skip-import"], ["-help", "--help"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--") continue;
    const raw = argv[index].toLowerCase();
    const token = aliases.get(raw) || raw;
    if (token === "--help") result.help = true;
    else if (token === "--resume") result.resume = true;
    else if (token === "--manual-wait") result.manualWait = true;
    else if (token === "--skip-images") result.skipImages = true;
    else if (token === "--skip-import") result.skipImport = true;
    else if (values.has(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argv[index]} requires a value`);
      const key = values.get(token);
      result[key] = ["shopUrl", "exportPath", "catalogPath"].includes(key) ? value : Number(value);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argv[index]}`);
    }
  }
  return result;
}

function validate(args) {
  if (!args.resume && !args.shopUrl) throw new Error("--shop-url is required unless --resume is used");
  if (args.shopUrl) {
    let url;
    try {
      url = new URL(args.shopUrl);
    } catch {
      throw new Error("--shop-url must be a valid HTTPS Taobao or Tmall URL");
    }
    if (url.protocol !== "https:" || !/(^|\.)((taobao|tmall)\.com)$/i.test(url.hostname)) {
      throw new Error("--shop-url must be an HTTPS Taobao or Tmall URL");
    }
  }
  for (const [name, value, minimum, maximum] of [
    ["--max-pages", args.maxPages, 1, 20], ["--max-products", args.maxProducts, 1, 200],
    ["--max-images", args.maxImages, 1, 200], ["--wait-ms", args.waitMs, 1000, 60000],
    ["--timeout-ms", args.timeoutMs, 10000, 86400000], ["--port", args.port, 1, 65535]
  ]) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
  }
}

function absolutePath(value) {
  return path.resolve(projectRoot, value);
}

function runStep(name, args) {
  console.log(`\n==> ${name}`);
  return new Promise((resolve, reject) => {
    const child = spawn(pnpmCommand, args, { cwd: projectRoot, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} failed${signal ? ` (${signal})` : ` with exit code ${code}`}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  validate(args);
  const exportPath = absolutePath(args.exportPath);
  const catalogPath = absolutePath(args.catalogPath);
  await fs.mkdir(path.dirname(exportPath), { recursive: true });

  await runStep("Start Chrome with the unpacked extension", [
    "--filter", "@dlr/ecommerce-collector", "extension:start", "--", "--port", String(args.port)
  ]);
  const collectArgs = [
    "--filter", "@dlr/ecommerce-collector", "extension:run", "--",
    "--cdp-url", `http://127.0.0.1:${args.port}`,
    "--max-pages", String(args.maxPages), "--max-products", String(args.maxProducts),
    "--max-images", String(args.maxImages), "--wait-ms", String(args.waitMs),
    "--timeout-ms", String(args.timeoutMs), "--out", exportPath
  ];
  collectArgs.push(args.resume ? "--resume" : "--shop-url", ...(args.resume ? [] : [args.shopUrl]));
  if (args.manualWait) collectArgs.push("--manual-wait");
  await runStep("Collect through Playwright and the Chrome extension", collectArgs);

  if (!args.skipImport) {
    const importArgs = [
      "--filter", "@dlr/ecommerce-collector", "extension:import", "--",
      exportPath, "--out", catalogPath
    ];
    if (args.skipImages) importArgs.push("--skip-images");
    await runStep("Import the export into the standard catalog", importArgs);
  }
  console.log(`\nOne-click collection completed.\nExport: ${exportPath}`);
  if (!args.skipImport) console.log(`Catalog: ${catalogPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
