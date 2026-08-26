#!/usr/bin/env bash
set -Eeuo pipefail

: "${PUBLIC_PORT:?PUBLIC_PORT is required}"

BASE_URL="http://127.0.0.1:${PUBLIC_PORT}"

request() {
  local path="$1"
  curl --fail --silent --show-error \
    --connect-timeout 5 \
    --max-time 30 \
    "${BASE_URL}${path}"
}

wait_for_application() {
  local attempt
  for attempt in $(seq 1 "${HEALTHCHECK_ATTEMPTS:-30}"); do
    if request "/" >/dev/null 2>&1 \
      && request "/api/summary" | grep -Eq '"configured"[[:space:]]*:[[:space:]]*true'; then
      return 0
    fi
    printf '等待应用健康检查（%s/%s）\n' "$attempt" "${HEALTHCHECK_ATTEMPTS:-30}"
    sleep "${HEALTHCHECK_INTERVAL_SECONDS:-4}"
  done
  return 1
}

wait_for_application

request "/" >/dev/null
request "/files" >/dev/null
request "/internal-data?category=group" >/dev/null
request "/api/summary" | grep -Eq '"configured"[[:space:]]*:[[:space:]]*true'
request "/api/ecommerce/products?page=1&pageSize=1" | grep -Eq '"items"[[:space:]]*:'
request "/api/ecommerce/files?page=1&pageSize=1" | grep -Eq '"items"[[:space:]]*:'
request "/api/internal/feishu/chats?category=group" | grep -Eq '"items"[[:space:]]*:'
request "/api/internal/feishu/chats?category=p2p" | grep -Eq '"items"[[:space:]]*:'

printf 'business_smoke=ok\n'
