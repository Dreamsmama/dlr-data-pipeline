#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${REPOSITORY_ROOT}/deploy.sh"

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

INSTALL_ROOT="${TEST_ROOT}/install"
SHARED_DIR="${INSTALL_ROOT}/shared"
INCOMING_DIR="${INSTALL_ROOT}/incoming"
RELEASES_DIR="${INSTALL_ROOT}/releases"
REPOSITORY_DIR="${INSTALL_ROOT}/repository"
LAUNCHER_PATH="${INSTALL_ROOT}/deploy.sh"
REPOSITORY_URL="${DEPLOY_INTEGRATION_REPOSITORY_URL:-https://github.com/Dreamsmama/dlr-data-pipeline.git}"
GIT_BRANCH="main"
GIT_NETWORK_RETRIES=2
GIT_NETWORK_TIMEOUT_SECONDS=60
SOURCE_ARCHIVE=""
SOURCE_VERSION=""
SOURCE_SHA256=""
SOURCE_BRANCH="main"
mkdir -p "$INCOMING_DIR" "$RELEASES_DIR"

prepare_git_release
remote_commit="$(git -C "$REPOSITORY_DIR" rev-parse refs/remotes/origin/main)"
[[ "$SOURCE_VERSION" == "$remote_commit" ]] || {
  printf 'source integration failed: release does not match origin/main\n' >&2
  exit 1
}
[[ -f "${RELEASES_DIR}/${SOURCE_VERSION}/docker-compose.yml" ]] || {
  printf 'source integration failed: immutable release was not extracted\n' >&2
  exit 1
}
[[ -x "$LAUNCHER_PATH" ]] || {
  printf 'source integration failed: fixed server launcher was not installed\n' >&2
  exit 1
}
printf 'server source integration: commit=%s\n' "$SOURCE_VERSION"
