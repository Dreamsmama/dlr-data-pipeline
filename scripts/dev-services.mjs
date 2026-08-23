import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDirectory = resolve(root, ".dev-services");
const stateFile = resolve(stateDirectory, "pids.json");
const logDirectory = resolve(root, "logs");
const services = {
  api: { command: "pnpm.cmd --filter @dlr/api dev", url: "http://127.0.0.1:3001/health" },
  web: { command: "pnpm.cmd --filter @dlr/web dev", url: "http://127.0.0.1:3000/" },
};

function readState() {
  if (!existsSync(stateFile)) return {};
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startServices() {
  mkdirSync(logDirectory, { recursive: true });
  const state = readState();
  const startedAt = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");

  for (const [name, service] of Object.entries(services)) {
    if (await reachable(service.url)) {
      console.log(`${name}: already running`);
      continue;
    }

    const logPath = resolve(logDirectory, `${name}-${startedAt}.log`);
    const log = openSync(logPath, "a");
    const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", service.command], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    closeSync(log);
    state[name] = { pid: child.pid, logPath };
    console.log(`${name}: started (PID ${child.pid})`);
    console.log(`${name}: log ${logPath}`);
  }

  writeState(state);
}

function stopServices() {
  const state = readState();
  let stopped = false;
  const stoppedPids = new Set();

  for (const [name, processState] of Object.entries(state)) {
    const pid = typeof processState === "object" ? processState.pid : processState;
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    stoppedPids.add(String(pid));
    if (result.status === 0) {
      stopped = true;
      console.log(`${name}: stopped`);
    }
  }

  const netstat = spawnSync("netstat.exe", ["-ano", "-p", "tcp"], { encoding: "utf8" });
  for (const line of netstat.stdout?.split(/\r?\n/) ?? []) {
    const match = line.match(/^\s*TCP\s+\S+:(?:3000|3001)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match || stoppedPids.has(match[1])) continue;
    const result = spawnSync("taskkill.exe", ["/PID", match[1], "/T", "/F"], { stdio: "ignore" });
    if (result.status === 0) stopped = true;
  }

  writeState({});
  if (!stopped) console.log("No managed services were running.");
}

async function showStatus() {
  for (const [name, service] of Object.entries(services)) {
    console.log(`${name}: ${(await reachable(service.url)) ? "running" : "stopped"}`);
  }
}

const action = process.argv[2];
if (action === "start") await startServices();
else if (action === "stop") stopServices();
else if (action === "status") await showStatus();
else throw new Error("Usage: node scripts/dev-services.mjs <start|stop|status>");
