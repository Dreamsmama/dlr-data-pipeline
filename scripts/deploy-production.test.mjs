import assert from "node:assert/strict";
import test from "node:test";

import { loadTargetProfile, parseArguments, validateOptions } from "./deploy-production.mjs";

test("deploy is the default command", () => {
  const options = parseArguments([]);
  assert.equal(options.command, "deploy");
  assert.equal(options.server, process.env.DEPLOY_SERVER ?? "wuyang");
});

test("legacy-style flags map to production commands", () => {
  assert.equal(parseArguments(["--preflight"]).command, "preflight");
  assert.equal(parseArguments(["--bootstrap"]).command, "bootstrap");
  assert.equal(parseArguments(["--verify-only"]).command, "verify");
  assert.equal(parseArguments(["--status"]).command, "status");
  assert.deepEqual(
    { command: parseArguments(["--rollback", "abcdef1"]).command, version: parseArguments(["--rollback", "abcdef1"]).version },
    { command: "rollback", version: "abcdef1" },
  );
});

test("preflight loads the explicit non-secret server profile", () => {
  const options = parseArguments(["preflight", "--profile", "wuyang"]);
  const profile = loadTargetProfile(options.profile);
  assert.equal(options.command, "preflight");
  assert.equal(profile.values.TARGET_OS_ID, "ubuntu");
  assert.equal(profile.values.TARGET_ARCH, "x86_64");
  assert.equal(profile.values.TARGET_INSTALL_ROOT, "/opt/dlr-data-pipeline");
});

test("preflight rejects missing or path-traversing profiles before SSH", () => {
  assert.throws(() => loadTargetProfile("profile-that-does-not-exist"), /目标画像不存在/);
  assert.throws(() => parseArguments(["preflight", "--profile", "../wuyang"]), /目标画像名称/);
  assert.throws(
    () => parseArguments(["preflight", "--server", "121.199.52.72"]),
    /显式提供 --profile/,
  );
});

test("unsafe SSH targets and install roots are rejected", () => {
  assert.throws(() => parseArguments(["--server", "host;shutdown"]), /SSH server/);
  assert.throws(() => parseArguments(["--install-root", "/"]), /install root/);
  assert.throws(() => parseArguments(["--install-root", "/opt/../root"]), /install root/);
});

test("rollback requires an unambiguous git prefix", () => {
  assert.throws(() => parseArguments(["rollback", "main"]), /Git 提交/);
  assert.equal(parseArguments(["rollback", "a0e46cf"]).version, "a0e46cf");
});

test("public URL cannot carry credentials", () => {
  assert.throws(
    () => validateOptions({ command: "deploy", version: "", server: "wuyang", installRoot: "/opt/dlr", publicUrl: "http://user:pass@example.com" }),
    /账号或密码/,
  );
});

test("local quality checks are enabled unless explicitly skipped", () => {
  assert.equal(parseArguments([]).skipLocalChecks, false);
  assert.equal(parseArguments(["--skip-local-checks"]).skipLocalChecks, true);
});
