import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const packageRoot = path.resolve(import.meta.dirname, "..");

function printUsage() {
  console.log(`Usage:
  node scripts/start-extension-browser.js [options]

Options:
  --executable-path <path>  Chrome/Chromium executable; defaults to CHROME_PATH or auto-discovery
  --profile-dir <path>      Dedicated browser profile directory
  --extension-dir <path>    Unpacked extension directory
  --port <n>                Remote debugging port (default: 9333)
  --help                    Show this help`);
}

function parseArgs(argv) {
  const result = {
    executablePath: process.env.CHROME_PATH || null,
    profileDir: path.join(packageRoot, ".chrome-extension-profile"),
    extensionDir: path.join(packageRoot, "extension"),
    port: 9333,
    help: false
  };
  const valueOptions = new Map([
    ["--executable-path", "executablePath"],
    ["--profile-dir", "profileDir"],
    ["--extension-dir", "extensionDir"],
    ["--port", "port"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    else if (token === "--help" || token === "-h") result.help = true;
    else if (valueOptions.has(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      const key = valueOptions.get(token);
      result[key] = key === "port" ? Number(value) : value;
      index += 1;
    } else throw new Error(`Unknown option: ${token}`);
  }
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  result.profileDir = path.resolve(result.profileDir);
  result.extensionDir = path.resolve(result.extensionDir);
  if (result.executablePath) result.executablePath = path.resolve(result.executablePath);
  return result;
}

function chromeCandidates() {
  if (process.platform === "win32") {
    return [
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
      process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    ].filter(Boolean);
  }
  if (process.platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

async function findExecutable(explicitPath) {
  const candidates = explicitPath ? [explicitPath] : chromeCandidates();
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next known installation path.
    }
  }
  throw new Error("Chrome/Chromium not found; pass --executable-path or set CHROME_PATH");
}

async function endpointReady(endpoint) {
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  const endpoint = `http://127.0.0.1:${args.port}`;
  if (await endpointReady(endpoint)) {
    console.log(`browser-ready: ${endpoint}`);
    return;
  }
  const executablePath = await findExecutable(args.executablePath);
  await Promise.all([
    fs.mkdir(args.profileDir, { recursive: true }),
    fs.access(args.extensionDir)
  ]);
  const browser = spawn(
    executablePath,
    [
      `--remote-debugging-port=${args.port}`,
      `--user-data-dir=${args.profileDir}`,
      `--load-extension=${args.extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check"
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    }
  );
  let launchError = null;
  browser.once("error", (error) => {
    launchError = error;
  });
  browser.unref();

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (await endpointReady(endpoint)) {
      console.log(`browser-ready: ${endpoint}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Browser started, but ${endpoint} was not ready within 30 seconds`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
