#!/usr/bin/env bash
set -Eeuo pipefail

: "${COMPOSE_FILE:?COMPOSE_FILE is required}"
: "${APP_ENV_FILE:?APP_ENV_FILE is required}"

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-dlr-data-pipeline}"

compose() {
  docker compose \
    --project-name "$COMPOSE_PROJECT_NAME" \
    --env-file "$APP_ENV_FILE" \
    --file "$COMPOSE_FILE" \
    "$@"
}

compose exec -T api sh -euc '
expect_prefix() {
  label="$1"
  actual="$2"
  expected="$3"
  case "$actual" in
    "$expected"*) printf "%s=%s\n" "$label" "$actual" ;;
    *) printf "%s 版本不符合要求：期望 %s，实际 %s\n" "$label" "$expected" "$actual" >&2; exit 1 ;;
  esac
}

expect_exact() {
  label="$1"
  actual="$2"
  expected="$3"
  if [ "$actual" != "$expected" ]; then
    printf "%s 版本不符合要求：期望 %s，实际 %s\n" "$label" "$expected" "$actual" >&2
    exit 1
  fi
  printf "%s=%s\n" "$label" "$actual"
}

expect_prefix node "$(node --version)" "v22."
expect_exact pnpm "$(pnpm --version)" "11.19.0"
expect_exact python "$(python3 --version | awk "{print \$2}")" "3.12.13"
expect_exact uv "$(uv --version | awk "{print \$2}")" "0.11.7"
expect_exact lark_cli "$(lark-cli --version | awk "{print \$NF}")" "1.0.88"

test -d "${FEISHU_DATA_DIR:-/data/feishu}"
test -w "${FEISHU_DATA_DIR:-/data/feishu}"
'

if compose exec -T api sh -ec 'lark-cli doctor --offline' 2>/dev/null \
  | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
  printf 'lark_cli_auth=profile-readable\n'
else
  printf 'lark_cli_auth=not-configured-or-keychain-unavailable\n'
  printf '警告：飞书 CLI 已安装，但认证持久化尚未通过；需要真实扫码和容器重建验收。\n' >&2
fi
