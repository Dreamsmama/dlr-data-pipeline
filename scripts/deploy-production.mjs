import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");

const targetProfileKeys = Object.freeze([
  "TARGET_INSTALL_ROOT",
  "TARGET_OS_ID",
  "TARGET_OS_MIN_VERSION",
  "TARGET_ARCH",
  "TARGET_MIN_CPU_CORES",
  "TARGET_MIN_TOTAL_MEMORY_MB",
  "TARGET_MIN_AVAILABLE_MEMORY_MB",
  "TARGET_MIN_FREE_DISK_MB",
  "TARGET_DOCKER_MIN_VERSION",
  "TARGET_COMPOSE_MIN_VERSION",
  "TARGET_PUBLIC_PORT",
  "TARGET_COMPOSE_PROJECT",
]);

const usage = `
DLR production deployment

Usage:
  pnpm deploy:production -- [deploy]
  pnpm deploy:production -- preflight
  pnpm deploy:production -- bootstrap
  pnpm deploy:production -- verify
  pnpm deploy:production -- status
  pnpm deploy:production -- rollback <git-version>

Compatible flags:
  --preflight
  --bootstrap
  --verify-only
  --status
  --rollback <git-version>

Options:
  --server <ssh-alias>       Default: DEPLOY_SERVER or wuyang
  --profile <name>           Default: DEPLOY_TARGET_PROFILE or SSH alias
  --install-root <path>      Default: DEPLOY_INSTALL_ROOT or /opt/dlr-data-pipeline
  --public-url <url>         Override the public verification URL
  --skip-public-verify       Explicitly skip verification from this computer
  --skip-local-checks        Explicitly skip test/typecheck before upload
  --dry-run                  Validate arguments and print intended actions only
`;

export function parseArguments(argv) {
  const result = {
    command: "deploy",
    version: "",
    server: process.env.DEPLOY_SERVER ?? "wuyang",
    profile: process.env.DEPLOY_TARGET_PROFILE ?? "",
    installRoot: process.env.DEPLOY_INSTALL_ROOT ?? "/opt/dlr-data-pipeline",
    publicUrl: process.env.DEPLOY_PUBLIC_URL ?? "",
    skipPublicVerify: false,
    skipLocalChecks: false,
    dryRun: false,
  };
  let commandSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["deploy", "preflight", "bootstrap", "verify", "status"].includes(argument)) {
      if (commandSeen) throw new Error("只能指定一个部署命令");
      result.command = argument;
      commandSeen = true;
    } else if (argument === "rollback" || argument === "--rollback") {
      if (commandSeen) throw new Error("只能指定一个部署命令");
      result.command = "rollback";
      result.version = argv[++index] ?? "";
      commandSeen = true;
    } else if (argument === "--preflight") {
      if (commandSeen) throw new Error("只能指定一个部署命令");
      result.command = "preflight";
      commandSeen = true;
    } else if (argument === "--bootstrap") {
      if (commandSeen) throw new Error("只能指定一个部署命令");
      result.command = "bootstrap";
      commandSeen = true;
    } else if (argument === "--verify-only") {
      if (commandSeen) throw new Error("只能指定一个部署命令");
      result.command = "verify";
      commandSeen = true;
    } else if (argument === "--status") {
      if (commandSeen) throw new Error("只能指定一个部署命令");
      result.command = "status";
      commandSeen = true;
    } else if (argument === "--server") {
      result.server = argv[++index] ?? "";
    } else if (argument === "--profile") {
      result.profile = argv[++index] ?? "";
    } else if (argument === "--install-root") {
      result.installRoot = argv[++index] ?? "";
    } else if (argument === "--public-url") {
      result.publicUrl = argv[++index] ?? "";
    } else if (argument === "--skip-public-verify") {
      result.skipPublicVerify = true;
    } else if (argument === "--skip-local-checks") {
      result.skipLocalChecks = true;
    } else if (argument === "--dry-run") {
      result.dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      result.command = "help";
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  if (!result.profile) {
    const inferredProfile = result.server.split("@").at(-1) ?? "";
    if (!/^[A-Za-z0-9_-]+$/.test(inferredProfile)) {
      throw new Error("无法从 SSH server 推断目标画像，请显式提供 --profile");
    }
    result.profile = inferredProfile;
  }
  validateOptions(result);
  return result;
}

export function validateOptions(options) {
  if (options.command === "help") return;
  if (!/^[A-Za-z0-9_.@-]+$/.test(options.server)) {
    throw new Error("SSH server 只能包含字母、数字、点、下划线、@ 和连字符");
  }
  if (options.profile && !/^[A-Za-z0-9_-]+$/.test(options.profile)) {
    throw new Error("目标画像名称只能包含字母、数字、下划线和连字符");
  }
  if (
    !/^\/[A-Za-z0-9._/-]+$/.test(options.installRoot)
    || options.installRoot === "/"
    || options.installRoot.split("/").includes("..")
  ) {
    throw new Error("install root 必须是安全的绝对路径，且不能是根目录");
  }
  if (options.command === "rollback" && !/^[0-9a-f]{7,40}$/.test(options.version)) {
    throw new Error("回滚版本必须是 7-40 位 Git 提交前缀");
  }
  if (options.publicUrl) {
    const url = new URL(options.publicUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("public URL 只支持 http/https");
    if (url.username || url.password) throw new Error("public URL 不能包含账号或密码");
  }
}

function executable(name) {
  if (process.platform !== "win32") return name;
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  if (name === "ssh") return join(windowsRoot, "System32", "OpenSSH", "ssh.exe");
  if (name === "scp") return join(windowsRoot, "System32", "OpenSSH", "scp.exe");
  return name;
}

function run(command, args, options = {}) {
  if (options.dryRun) {
    console.log(`[dry-run] ${basename(command)} ${args.join(" ")}`);
    return "";
  }
  const capture = options.capture === true;
  const hasInput = typeof options.input === "string" || Buffer.isBuffer(options.input);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: capture ? "utf8" : undefined,
    input: options.input,
    stdio: capture
      ? [hasInput ? "pipe" : "ignore", "pipe", "pipe"]
      : hasInput
        ? ["pipe", "inherit", "inherit"]
        : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? result.stderr.trim() : "";
    throw new Error(detail || `${basename(command)} exited with status ${result.status}`);
  }
  return capture ? result.stdout.trim() : "";
}

export function loadTargetProfile(profileName, root = repositoryRoot) {
  if (!/^[A-Za-z0-9_-]+$/.test(profileName)) {
    throw new Error("目标画像名称只能包含字母、数字、下划线和连字符");
  }
  const profilePath = resolve(root, "deploy", "targets", `${profileName}.env`);
  let content;
  try {
    content = readFileSync(profilePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`目标画像不存在：deploy/targets/${profileName}.env`);
    throw error;
  }

  const allowedKeys = new Set(targetProfileKeys);
  const values = {};
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`目标画像第 ${index + 1} 行格式错误`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!allowedKeys.has(key)) throw new Error(`目标画像包含未知字段：${key}`);
    if (Object.hasOwn(values, key)) throw new Error(`目标画像字段重复：${key}`);
    if (!value) throw new Error(`目标画像字段不能为空：${key}`);
    values[key] = value;
  }
  for (const key of targetProfileKeys) {
    if (!Object.hasOwn(values, key)) throw new Error(`目标画像缺少字段：${key}`);
  }

  if (
    !/^\/[A-Za-z0-9._/-]+$/.test(values.TARGET_INSTALL_ROOT)
    || values.TARGET_INSTALL_ROOT === "/"
    || values.TARGET_INSTALL_ROOT.split("/").includes("..")
  ) throw new Error("目标画像的安装路径不安全");
  if (!/^[a-z0-9._-]+$/.test(values.TARGET_OS_ID)) throw new Error("目标画像的操作系统 ID 非法");
  if (!/^[A-Za-z0-9._-]+$/.test(values.TARGET_ARCH)) throw new Error("目标画像的架构字段非法");
  if (!/^[A-Za-z0-9._-]+$/.test(values.TARGET_COMPOSE_PROJECT)) throw new Error("目标画像的 Compose project 非法");

  for (const key of ["TARGET_OS_MIN_VERSION", "TARGET_DOCKER_MIN_VERSION", "TARGET_COMPOSE_MIN_VERSION"]) {
    if (!/^\d+(?:\.\d+){1,2}$/.test(values[key])) throw new Error(`目标画像的版本字段非法：${key}`);
  }
  for (const key of [
    "TARGET_MIN_CPU_CORES",
    "TARGET_MIN_TOTAL_MEMORY_MB",
    "TARGET_MIN_AVAILABLE_MEMORY_MB",
    "TARGET_MIN_FREE_DISK_MB",
    "TARGET_PUBLIC_PORT",
  ]) {
    if (!/^[1-9]\d*$/.test(values[key])) throw new Error(`目标画像的正整数字段非法：${key}`);
  }
  if (Number(values.TARGET_PUBLIC_PORT) > 65_535) throw new Error("目标画像的端口超出范围");

  return { path: profilePath, values };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function runPreflight(options) {
  const profile = loadTargetProfile(options.profile);
  if (profile.values.TARGET_INSTALL_ROOT !== options.installRoot) {
    throw new Error(
      `目标画像安装路径 ${profile.values.TARGET_INSTALL_ROOT} 与 --install-root ${options.installRoot} 不一致`,
    );
  }
  console.log(`目标画像：${profile.path}`);
  const script = readFileSync(resolve(repositoryRoot, "deploy", "preflight.sh"), "utf8");
  const argumentsText = targetProfileKeys.map((key) => shellQuote(profile.values[key])).join(" ");
  run(
    executable("ssh"),
    ["-o", "BatchMode=yes", options.server, `bash -s -- ${argumentsText}`],
    { dryRun: options.dryRun, input: script },
  );
}

function runPnpm(args) {
  const pnpmEntry = process.env.npm_execpath;
  if (pnpmEntry?.endsWith(".cjs") || pnpmEntry?.endsWith(".js")) {
    run(process.execPath, [pnpmEntry, ...args]);
    return;
  }
  if (process.platform === "win32") {
    const allowed = new Set(["test", "typecheck"]);
    if (args.length !== 1 || !allowed.has(args[0])) throw new Error("拒绝执行未列入质量门禁的 pnpm 参数");
    run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm ${args[0]}`]);
    return;
  }
  run("pnpm", args);
}

function gitOutput(args) {
  return run("git", args, { capture: true });
}

export function assertProductionSource(environment = process.env) {
  const status = gitOutput(["status", "--porcelain", "--untracked-files=all"]);
  if (status) throw new Error("工作区不干净；一键部署只接受已经提交并经过人工确认的代码");
  const branch = gitOutput(["branch", "--show-current"]);
  if (branch && !/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error(`分支名包含部署入口不接受的字符：${branch}`);
  }
  if (branch !== "main" && environment.DEPLOY_ALLOW_NON_MAIN !== "1") {
    throw new Error(`生产发布默认只允许 main；当前为 ${branch || "detached HEAD"}。紧急发布需显式设置 DEPLOY_ALLOW_NON_MAIN=1`);
  }
  return {
    branch: branch || "detached",
    commit: gitOutput(["rev-parse", "HEAD"]),
  };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runLocalQualityGate(options) {
  if (options.skipLocalChecks) {
    console.log("本地质量门禁：已通过 --skip-local-checks 显式跳过");
    return;
  }
  console.log("本地质量门禁：单元测试");
  runPnpm(["test"]);
  console.log("本地质量门禁：类型检查");
  runPnpm(["typecheck"]);
}

function remoteCommand(options, command, extra = "") {
  const launcher = `${options.installRoot}/deploy.sh`;
  return `bash '${launcher}' ${command}${extra}`;
}

function uploadRelease(options, source) {
  const ssh = executable("ssh");
  const scp = executable("scp");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "dlr-production-deploy-"));
  const archiveName = `${source.commit}.tar.gz`;
  const archivePath = join(temporaryDirectory, archiveName);
  const remoteArchive = `${options.installRoot}/incoming/${archiveName}`;
  try {
    run("git", ["archive", "--format=tar.gz", `--output=${archivePath}`, source.commit]);
    const digest = sha256(archivePath);
    run(ssh, ["-o", "BatchMode=yes", options.server, `install -d -m 755 '${options.installRoot}/incoming'`]);
    run(scp, ["-q", archivePath, `${options.server}:${remoteArchive}`]);
    run(scp, ["-q", resolve(repositoryRoot, "deploy.sh"), `${options.server}:${options.installRoot}/deploy.sh.new`]);
    const installAndRun = [
      `chmod 755 '${options.installRoot}/deploy.sh.new'`,
      `mv '${options.installRoot}/deploy.sh.new' '${options.installRoot}/deploy.sh'`,
      `DEPLOY_SOURCE_ARCHIVE='${remoteArchive}'`,
      `DEPLOY_SOURCE_VERSION='${source.commit}'`,
      `DEPLOY_SOURCE_SHA256='${digest}'`,
      `DEPLOY_SOURCE_BRANCH='${source.branch}'`,
      remoteCommand(options, options.command),
    ].join(" ");
    run(ssh, ["-o", "BatchMode=yes", options.server, installAndRun]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function runRemoteCommand(options) {
  const ssh = executable("ssh");
  const suffix = options.command === "rollback" ? ` '${options.version}'` : "";
  run(ssh, ["-o", "BatchMode=yes", options.server, remoteCommand(options, options.command, suffix)], {
    dryRun: options.dryRun,
  });
}

async function verifyPublicUrl(urlText) {
  const origin = new URL(urlText);
  if (["127.0.0.1", "localhost", "::1"].includes(origin.hostname)) {
    console.log(`公网验收：跳过（WEB_ORIGIN=${origin.origin} 是回环地址）`);
    return;
  }
  const paths = ["/", "/files", "/api/summary"];
  for (const path of paths) {
    const response = await fetch(new URL(path, origin), {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`公网验收失败：${path} 返回 ${response.status}`);
    if (path === "/api/summary") {
      const summary = await response.json();
      if (summary?.ecommerce?.configured !== true) {
        throw new Error("公网验收失败：电商数据库没有 configured=true");
      }
    }
    console.log(`公网验收：${path} ${response.status}`);
  }
}

async function discoverAndVerifyPublic(options) {
  if (options.skipPublicVerify) {
    console.log("公网验收：已通过 --skip-public-verify 显式跳过");
    return;
  }
  let publicUrl = options.publicUrl;
  if (!publicUrl) {
    const output = run(executable("ssh"), [
      "-o", "BatchMode=yes", options.server, remoteCommand(options, "public-url"),
    ], { capture: true });
    publicUrl = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  }
  if (!publicUrl) throw new Error("无法取得 WEB_ORIGIN，不能执行部署机外部验收");
  await verifyPublicUrl(publicUrl);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.command === "help") {
    console.log(usage.trim());
    return;
  }
  console.log(`目标：command=${options.command} server=${options.server} root=${options.installRoot}`);
  if (options.command === "preflight") {
    runPreflight(options);
    if (options.dryRun) {
      console.log("dry-run 只校验参数和目标画像，不连接服务器、不改变生产状态");
    } else {
      console.log("生产命令完成：preflight（只读，未改变服务器状态）");
    }
    return;
  }
  if (options.dryRun) {
    console.log("dry-run 只校验参数，不连接服务器、不生成制品、不改变生产状态");
    return;
  }

  if (["bootstrap", "deploy"].includes(options.command)) {
    const source = assertProductionSource();
    console.log(`发布来源：branch=${source.branch} commit=${source.commit}`);
    if (options.command === "deploy") runLocalQualityGate(options);
    uploadRelease(options, source);
  } else {
    runRemoteCommand(options);
  }

  if (["deploy", "verify"].includes(options.command)) {
    await discoverAndVerifyPublic(options);
  }
  console.log(`生产命令完成：${options.command}`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
