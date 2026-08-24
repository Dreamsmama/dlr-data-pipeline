import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const server = process.env.DEPLOY_SERVER ?? "wuyang";
const installRoot = process.env.DEPLOY_INSTALL_ROOT ?? "/opt/dlr-data-pipeline";
const ssh = process.platform === "win32" ? `${process.env.WINDIR}\\System32\\OpenSSH\\ssh.exe` : "ssh";
const scp = process.platform === "win32" ? `${process.env.WINDIR}\\System32\\OpenSSH\\scp.exe` : "scp";

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} exited with status ${result.status}`);
  return result.stdout.trim();
}

const status = output("git", ["status", "--porcelain"]);
if (status) throw new Error("Working tree is not clean; commit the intended deployment input first.");

const commit = output("git", ["rev-parse", "HEAD"]);
const temporaryDirectory = mkdtempSync(join(tmpdir(), "dlr-deploy-"));
const archiveName = `${commit}.tar.gz`;
const archivePath = join(temporaryDirectory, archiveName);
const remoteArchive = `${installRoot}/incoming/${archiveName}`;

try {
  console.log(`Packaging commit ${commit.slice(0, 12)}...`);
  run("git", ["archive", "--format=tar.gz", `--output=${archivePath}`, "HEAD"]);
  run(ssh, ["-o", "BatchMode=yes", server, `install -d -m 755 '${installRoot}/incoming'`]);
  run(scp, ["-q", archivePath, `${server}:${remoteArchive}`]);
  run(scp, ["-q", resolve(repositoryRoot, "deploy.sh"), `${server}:${installRoot}/deploy.sh.new`]);
  const remoteCommand = [
    `chmod 755 '${installRoot}/deploy.sh.new'`,
    `mv '${installRoot}/deploy.sh.new' '${installRoot}/deploy.sh'`,
    `DEPLOY_SOURCE_ARCHIVE='${remoteArchive}' DEPLOY_SOURCE_VERSION='${commit}' bash '${installRoot}/deploy.sh'`,
  ].join(" && ");
  run(ssh, ["-o", "BatchMode=yes", server, remoteCommand]);
  console.log(`Deployment completed for ${commit.slice(0, 12)}.`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
