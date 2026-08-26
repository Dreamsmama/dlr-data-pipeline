#!/usr/bin/env bash
set -euo pipefail

SCENARIO="${1:-}"
PREFLIGHT_SCRIPT="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/preflight.sh}"

if [[ ! "$SCENARIO" =~ ^(pass|warn|fail)$ ]]; then
  printf 'usage: bash deploy/preflight-scenarios.sh <pass|warn|fail> [preflight-script]\n' >&2
  exit 2
fi
if [[ ! -f "$PREFLIGHT_SCRIPT" ]]; then
  printf 'preflight script not found: %s\n' "$PREFLIGHT_SCRIPT" >&2
  exit 2
fi

FIXTURE_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf -- "$FIXTURE_ROOT"
}
trap cleanup EXIT

mkdir -p "$FIXTURE_ROOT/shared"
export PREFLIGHT_FIXTURE_SCENARIO="$SCENARIO"

docker() {
  case "${1:-}" in
    info)
      [[ "$*" == *"--format"* ]] && printf 'https://fixture-registry-mirror.local/\n'
      return 0
      ;;
    version) printf '26.1.0\n' ;;
    compose) printf '2.27.0\n' ;;
    buildx) printf 'fixture buildx\n' ;;
    port)
      [[ "$PREFLIGHT_FIXTURE_SCENARIO" == "pass" ]] && printf '3000/tcp -> 127.0.0.1:3002\n'
      ;;
    ps)
      if [[ "$PREFLIGHT_FIXTURE_SCENARIO" == "pass" && "$*" == *"compose.service=web"* ]]; then
        printf 'fixture-web\n'
      elif [[ "$PREFLIGHT_FIXTURE_SCENARIO" == "pass" && "$*" == *"compose.service=api"* ]]; then
        printf 'fixture-api\n'
      fi
      ;;
    *) return 1 ;;
  esac
}

curl() {
  if [[ "$*" == *"registry-1.docker.io"* ]]; then
    printf '000'
  elif [[ "$*" == *"--write-out"* ]]; then
    printf '200'
  else
    printf '{"configured":true}\n'
  fi
}

ss() {
  [[ "$PREFLIGHT_FIXTURE_SCENARIO" == "pass" ]] \
    && printf 'LISTEN 0 4096 127.0.0.1:3002 0.0.0.0:*\n'
  return 0
}

timedatectl() {
  if [[ "$PREFLIGHT_FIXTURE_SCENARIO" == "pass" ]]; then printf 'yes\n'; else printf 'no\n'; fi
}

timeout() {
  return 0
}

ufw() {
  if [[ "$PREFLIGHT_FIXTURE_SCENARIO" == "pass" ]]; then
    printf 'Status: active\n3002/tcp                  ALLOW       Anywhere\n'
  else
    printf 'Status: inactive\n'
  fi
}

export -f docker curl ss timedatectl timeout ufw

if [[ "$SCENARIO" != "warn" ]]; then
  cat > "$FIXTURE_ROOT/shared/.env" <<'EOF'
DATABASE_URL=postgresql://fixture:fixture@fixture-db:5432/fixture
ALIYUN_OSS_REGION=oss-cn-shanghai
ALIYUN_OSS_ENDPOINT=oss-cn-shanghai.aliyuncs.com
ALIYUN_OSS_ACCESS_KEY_ID=fixture
ALIYUN_OSS_ACCESS_KEY_SECRET=fixture
ALIYUN_OSS_BUCKET_NAME=fixture
WEB_ORIGIN=http://127.0.0.1:3002
FEISHU_PERSISTENCE_MODE=postgres-oss
PUBLIC_BIND_ADDRESS=127.0.0.1
PUBLIC_PORT=3002
EOF
  chmod 600 "$FIXTURE_ROOT/shared/.env"
fi

os_id="$(sed -n 's/^ID=//p' /etc/os-release | head -n 1 | tr -d '"\r')"
os_version="$(sed -n 's/^VERSION_ID=//p' /etc/os-release | head -n 1 | tr -d '"\r')"
arch="$(uname -m)"
minimum_cpu=1
[[ "$SCENARIO" == "fail" ]] && minimum_cpu=999999

set +e
bash "$PREFLIGHT_SCRIPT" \
  "$FIXTURE_ROOT" "$os_id" "$os_version" "$arch" \
  "$minimum_cpu" 1 1 1 1.0.0 1.0.0 3002 dlr-data-pipeline
status=$?
set -e

if [[ "$SCENARIO" == "fail" && "$status" -ne 0 ]]; then
  exit 0
fi
if [[ "$SCENARIO" != "fail" && "$status" -eq 0 ]]; then
  exit 0
fi
printf 'scenario %s returned unexpected status %s\n' "$SCENARIO" "$status" >&2
exit 1
