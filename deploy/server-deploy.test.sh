#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${REPOSITORY_ROOT}/deploy.sh"

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

fail() {
  printf 'server deploy test failed: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s\n' "$*" >> "${TEST_ROOT}/test.log"
}

test_env_template_stops_and_is_not_overwritten() {
  RELEASE_DIR="${TEST_ROOT}/release"
  ENV_FILE="${TEST_ROOT}/shared/.env"
  mkdir -p "${RELEASE_DIR}/deploy" "$(dirname "$ENV_FILE")"
  cp "${REPOSITORY_ROOT}/deploy/.env.production.example" \
    "${RELEASE_DIR}/deploy/.env.production.example"

  local status=0
  ensure_config_template || status=$?
  [[ "$status" == 2 ]] || fail "missing .env must return 2"
  [[ -f "$ENV_FILE" ]] || fail "missing .env template was not created"
  printf '\nTEST_PRESERVE=1\n' >> "$ENV_FILE"
  ensure_config_template || fail "existing .env should be accepted"
  grep -q '^TEST_PRESERVE=1$' "$ENV_FILE" || fail "existing .env was overwritten"
}

test_every_fill_placeholder_is_rejected() {
  ENV_FILE="${TEST_ROOT}/placeholder.env"
  printf 'CUSTOM_VALUE=prefix-FILL_CUSTOM-suffix\n' > "$ENV_FILE"
  local status=0 output
  output="$(validate_config 2>&1)" || status=$?
  [[ "$status" == 2 ]] || fail "embedded FILL_ placeholder must return 2"
  grep -q '^CUSTOM_VALUE$' <<< "$output" \
    || fail "placeholder variable name was not reported"
}

write_fake_git() {
  local fail_until="$1"
  mkdir -p "${TEST_ROOT}/fake-bin"
  cp "${REPOSITORY_ROOT}/deploy/test-fixtures/fake-git.sh" "${TEST_ROOT}/fake-bin/git"
  chmod +x "${TEST_ROOT}/fake-bin/git"
  export FAIL_UNTIL="$fail_until"
}

test_git_timeout_retry_and_http11() {
  local original_path="$PATH" status=0
  export COUNTER_FILE="${TEST_ROOT}/git-count"
  export ARGS_FILE="${TEST_ROOT}/git-args"
  write_fake_git 2
  PATH="${TEST_ROOT}/fake-bin:${PATH}"
  GIT_NETWORK_RETRIES=3
  GIT_NETWORK_TIMEOUT_SECONDS=10
  sleep() { :; }
  git_network fetch origin main || status=$?
  unset -f sleep
  PATH="$original_path"
  [[ "$status" == 0 ]] || fail "Git request did not recover after retries"
  [[ "$(cat "$COUNTER_FILE")" == 3 ]] || fail "Git request retry count is incorrect"
  grep -q -- '-c http.version=HTTP/1.1' "$ARGS_FILE" || fail "Git did not force HTTP/1.1"
  grep -q -- '-c http.lowSpeedLimit=1024' "$ARGS_FILE" || fail "Git low-speed protection missing"

  rm -f "$COUNTER_FILE" "$ARGS_FILE"
  write_fake_git 99
  PATH="${TEST_ROOT}/fake-bin:${PATH}"
  GIT_NETWORK_RETRIES=2
  sleep() { :; }
  status=0
  git_network fetch origin main || status=$?
  unset -f sleep
  PATH="$original_path"
  [[ "$status" != 0 ]] || fail "exhausted Git retries must fail"
  [[ "$(cat "$COUNTER_FILE")" == 2 ]] || fail "exhausted Git retry count is incorrect"
}

test_partial_emergency_artifact_is_rejected() {
  SOURCE_ARCHIVE="${TEST_ROOT}/only-archive.tar.gz"
  SOURCE_VERSION=""
  SOURCE_SHA256=""
  local status=0
  prepare_source_release || status=$?
  [[ "$status" == 2 ]] || fail "partial emergency artifact metadata must return 2"
}

test_failed_release_restores_old_commit_image() {
  local old_version="1111111111111111111111111111111111111111"
  local failed_compose="${TEST_ROOT}/failed/docker-compose.yml"
  OLD_RELEASE="${TEST_ROOT}/old"
  OLD_VERSION="$old_version"
  CURRENT_RELEASE_LINK="${TEST_ROOT}/current-release"
  CURRENT_VERSION_FILE="${TEST_ROOT}/current-version"
  RELEASE_DIR="${TEST_ROOT}/failed"
  COMPOSE_FILE="$failed_compose"
  LOG_FILE="${TEST_ROOT}/failed.log"
  mkdir -p "$OLD_RELEASE" "$RELEASE_DIR"
  : > "${OLD_RELEASE}/docker-compose.yml"
  : > "$failed_compose"

  set_release_context() {
    RELEASE_DIR="$1"
    COMPOSE_FILE="${1}/docker-compose.yml"
  }
  compose() {
    printf '%s|%s\n' "${DEPLOY_IMAGE_TAG:-}" "$*" >> "${TEST_ROOT}/compose-calls"
  }
  wait_basic_application() { return 0; }
  ln() { printf '%s\n' "$*" >> "${TEST_ROOT}/link-calls"; }

  restore_old_release
  [[ "$(cat "$CURRENT_VERSION_FILE")" == "$old_version" ]] \
    || fail "old version record was not restored"
  grep -q "^${old_version:0:12}|up --detach --no-build --force-recreate api web$" \
    "${TEST_ROOT}/compose-calls" || fail "old Commit image was not recreated"
  [[ "$DEPLOY_GIT_COMMIT" == "$old_version" ]] || fail "old full Commit label context was not restored"
  [[ "$COMPOSE_FILE" == "$failed_compose" ]] || fail "failed release context was not preserved"
}

test_env_template_stops_and_is_not_overwritten
test_every_fill_placeholder_is_rejected
test_git_timeout_retry_and_http11
test_partial_emergency_artifact_is_rejected
test_failed_release_restores_old_commit_image
printf 'server deploy safeguards: ok\n'
