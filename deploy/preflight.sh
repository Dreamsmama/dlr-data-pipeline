#!/usr/bin/env bash
set -uo pipefail

TARGET_INSTALL_ROOT="${1:-/opt/dlr-data-pipeline}"
TARGET_OS_ID="${2:-ubuntu}"
TARGET_OS_MIN_VERSION="${3:-22.04}"
TARGET_ARCH="${4:-x86_64}"
TARGET_MIN_CPU_CORES="${5:-2}"
TARGET_MIN_TOTAL_MEMORY_MB="${6:-3000}"
TARGET_MIN_AVAILABLE_MEMORY_MB="${7:-1024}"
TARGET_MIN_FREE_DISK_MB="${8:-8192}"
TARGET_DOCKER_MIN_VERSION="${9:-24.0.0}"
TARGET_COMPOSE_MIN_VERSION="${10:-2.20.0}"
TARGET_PUBLIC_PORT="${11:-3002}"
TARGET_COMPOSE_PROJECT="${12:-dlr-data-pipeline}"

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '[PASS] %s\n' "$*"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf '[WARN] %s\n' "$*"
}

info() {
  printf '[INFO] %s\n' "$*"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '[FAIL] %s\n' "$*"
}

finish() {
  printf '\npreflight_summary pass=%s warn=%s fail=%s\n' "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
  if (( FAIL_COUNT > 0 )); then
    printf 'PREFLIGHT_RESULT=FAIL\n'
    exit 1
  elif (( WARN_COUNT > 0 )); then
    printf 'PREFLIGHT_RESULT=WARN\n'
  else
    printf 'PREFLIGHT_RESULT=PASS\n'
  fi
}

valid_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

version_ge() {
  local actual="${1#v}" expected="${2#v}" first
  first="$(printf '%s\n%s\n' "$expected" "$actual" | sort -V | head -n 1)"
  [[ "$first" == "$expected" ]]
}

env_value() {
  local file="$1" name="$2"
  sed -n "s/^${name}=//p" "$file" 2>/dev/null | tail -n 1 | tr -d '\r'
}

http_status() {
  local url="$1" code
  code="$(curl --head --silent --show-error --location \
    --connect-timeout 5 --max-time 12 --max-redirs 3 \
    --output /dev/null --write-out '%{http_code}' "$url" 2>/dev/null)" || code="000"
  printf '%s' "$code"
}

http_probe() {
  local label="$1" url="$2" required="${3:-true}" code
  code="$(http_status "$url")"
  if [[ "$code" =~ ^[234][0-9][0-9]$ ]]; then
    pass "${label} 可访问（HTTP ${code}）"
  elif [[ "$required" == "true" ]]; then
    fail "${label} 不可访问（HTTP ${code}）"
  else
    warn "${label} 暂不可访问（HTTP ${code}）"
  fi
}

probe_docker_registry() {
  local direct_code mirrors mirror mirror_url mirror_code mirror_ready=false
  direct_code="$(http_status "https://registry-1.docker.io/v2/")"
  if [[ "$direct_code" =~ ^[234][0-9][0-9]$ ]]; then
    pass "Docker Hub Registry 可访问（HTTP ${direct_code}）"
    return
  fi

  mirrors=""
  if [[ "$docker_ready" == true ]]; then
    mirrors="$(docker info \
      --format '{{range .RegistryConfig.Mirrors}}{{println .}}{{end}}' 2>/dev/null || true)"
  fi
  while IFS= read -r mirror; do
    [[ -z "$mirror" ]] && continue
    if [[ ! "$mirror" =~ ^https?://[A-Za-z0-9._:/-]+/?$ ]]; then
      warn "Docker daemon 包含格式不受支持的 registry mirror，已跳过且未输出地址"
      continue
    fi
    mirror_url="${mirror%/}/v2/"
    mirror_code="$(http_status "$mirror_url")"
    if [[ "$mirror_code" =~ ^[234][0-9][0-9]$ ]]; then
      pass "Docker Hub 直连不可用，但已配置的 registry mirror 可访问（HTTP ${mirror_code}）"
      mirror_ready=true
      break
    fi
  done <<< "$mirrors"
  if [[ "$mirror_ready" != true ]]; then
    fail "Docker Hub 及已配置的 registry mirror 均不可访问（直连 HTTP ${direct_code}）"
  fi
}

printf 'DLR production preflight (read-only)\n'
printf 'target_root=%s target_port=%s target_project=%s\n' \
  "$TARGET_INSTALL_ROOT" "$TARGET_PUBLIC_PORT" "$TARGET_COMPOSE_PROJECT"

if [[ ! "$TARGET_INSTALL_ROOT" =~ ^/[A-Za-z0-9._/-]+$ \
  || "$TARGET_INSTALL_ROOT" == "/" \
  || "$TARGET_INSTALL_ROOT" == *"/../"* ]]; then
  fail "目标安装路径不安全"
fi
for value in "$TARGET_MIN_CPU_CORES" "$TARGET_MIN_TOTAL_MEMORY_MB" \
  "$TARGET_MIN_AVAILABLE_MEMORY_MB" "$TARGET_MIN_FREE_DISK_MB" "$TARGET_PUBLIC_PORT"; do
  valid_positive_integer "$value" || fail "目标画像包含非法正整数"
done

required_commands=(awk bash curl df dirname find getconf grep head sed sort stat tail timeout tr uname)
missing_commands=()
for required_command in "${required_commands[@]}"; do
  command -v "$required_command" >/dev/null 2>&1 || missing_commands+=("$required_command")
done
if (( ${#missing_commands[@]} == 0 )); then
  pass "只读体检基础命令完整"
else
  fail "缺少基础命令：${missing_commands[*]}"
  finish
fi

if [[ -r /etc/os-release ]]; then
  actual_os_id="$(sed -n 's/^ID=//p' /etc/os-release | head -n 1 | tr -d '"\r')"
  actual_os_version="$(sed -n 's/^VERSION_ID=//p' /etc/os-release | head -n 1 | tr -d '"\r')"
  if [[ "$actual_os_id" == "$TARGET_OS_ID" ]] && version_ge "$actual_os_version" "$TARGET_OS_MIN_VERSION"; then
    pass "操作系统 ${actual_os_id} ${actual_os_version} 符合 ${TARGET_OS_ID} ${TARGET_OS_MIN_VERSION}+"
  else
    fail "操作系统为 ${actual_os_id:-unknown} ${actual_os_version:-unknown}，要求 ${TARGET_OS_ID} ${TARGET_OS_MIN_VERSION}+"
  fi
else
  fail "无法读取 /etc/os-release"
fi

actual_arch="$(uname -m 2>/dev/null || printf unknown)"
if [[ "$actual_arch" == "$TARGET_ARCH" ]]; then
  pass "CPU 架构 ${actual_arch}"
else
  fail "CPU 架构为 ${actual_arch}，要求 ${TARGET_ARCH}"
fi

cpu_cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf 0)"
if [[ "$cpu_cores" =~ ^[0-9]+$ ]] && (( cpu_cores >= TARGET_MIN_CPU_CORES )); then
  pass "CPU ${cpu_cores} 核，最低要求 ${TARGET_MIN_CPU_CORES} 核"
else
  fail "CPU ${cpu_cores} 核，低于最低要求 ${TARGET_MIN_CPU_CORES} 核"
fi

load_one="$(awk '{print $1}' /proc/loadavg 2>/dev/null || printf 0)"
if awk -v current_load="$load_one" -v cores="$cpu_cores" \
  'BEGIN { exit !(current_load <= cores * 2) }'; then
  pass "1 分钟负载 ${load_one}，未超过 CPU 核数的两倍"
else
  warn "1 分钟负载 ${load_one} 较高，建议负载下降后再构建"
fi

memory_total_mb="$(awk '/MemTotal:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || printf 0)"
memory_available_mb="$(awk '/MemAvailable:/ {m=$2} /SwapFree:/ {s=$2} END {printf "%d", (m+s)/1024}' /proc/meminfo 2>/dev/null || printf 0)"
swap_total_mb="$(awk '/SwapTotal:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || printf 0)"
if (( memory_total_mb >= TARGET_MIN_TOTAL_MEMORY_MB )); then
  pass "物理内存 ${memory_total_mb} MB，最低要求 ${TARGET_MIN_TOTAL_MEMORY_MB} MB"
else
  fail "物理内存 ${memory_total_mb} MB，低于最低要求 ${TARGET_MIN_TOTAL_MEMORY_MB} MB"
fi
if (( memory_available_mb >= TARGET_MIN_AVAILABLE_MEMORY_MB )); then
  pass "可用内存+Swap ${memory_available_mb} MB（Swap 总量 ${swap_total_mb} MB）"
else
  fail "可用内存+Swap ${memory_available_mb} MB，低于 ${TARGET_MIN_AVAILABLE_MEMORY_MB} MB"
fi

disk_probe="$TARGET_INSTALL_ROOT"
while [[ ! -e "$disk_probe" && "$disk_probe" != "/" ]]; do disk_probe="$(dirname "$disk_probe")"; done
free_disk_mb="$(df -Pm "$disk_probe" 2>/dev/null | awk 'NR==2 {print $4}')"
free_disk_mb="${free_disk_mb:-0}"
if (( free_disk_mb >= TARGET_MIN_FREE_DISK_MB )); then
  pass "磁盘可用 ${free_disk_mb} MB，最低要求 ${TARGET_MIN_FREE_DISK_MB} MB"
else
  fail "磁盘可用 ${free_disk_mb} MB，低于最低要求 ${TARGET_MIN_FREE_DISK_MB} MB"
fi
inode_used_percent="$(df -Pi "$disk_probe" 2>/dev/null | awk 'NR==2 {gsub(/%/, "", $5); print $5}')"
inode_used_percent="${inode_used_percent:-100}"
if (( inode_used_percent < 85 )); then
  pass "inode 使用率 ${inode_used_percent}%"
elif (( inode_used_percent < 95 )); then
  warn "inode 使用率 ${inode_used_percent}% 偏高"
else
  fail "inode 使用率 ${inode_used_percent}% 过高"
fi

docker_ready=false
if ! command -v docker >/dev/null 2>&1; then
  fail "未安装 Docker；preflight 不会自动安装，请在确认报告后运行 bootstrap"
elif ! docker info >/dev/null 2>&1; then
  fail "Docker daemon 不可访问"
else
  docker_ready=true
  docker_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || printf unknown)"
  if [[ "$docker_version" != "unknown" ]] && version_ge "$docker_version" "$TARGET_DOCKER_MIN_VERSION"; then
    pass "Docker ${docker_version}，最低要求 ${TARGET_DOCKER_MIN_VERSION}"
  else
    fail "Docker ${docker_version}，低于或无法确认最低版本 ${TARGET_DOCKER_MIN_VERSION}"
  fi
  compose_version="$(docker compose version --short 2>/dev/null | tr -d '\r' || true)"
  if [[ -n "$compose_version" ]] && version_ge "$compose_version" "$TARGET_COMPOSE_MIN_VERSION"; then
    pass "Docker Compose ${compose_version}，最低要求 ${TARGET_COMPOSE_MIN_VERSION}"
  else
    fail "Docker Compose ${compose_version:-missing}，低于最低版本 ${TARGET_COMPOSE_MIN_VERSION}"
  fi
  if docker buildx version >/dev/null 2>&1; then
    pass "Docker Buildx/BuildKit 可用"
  else
    fail "Docker Buildx 不可用，生产镜像无法按预期构建"
  fi
fi

if command -v timedatectl >/dev/null 2>&1; then
  ntp_synchronized="$(timedatectl show -p NTPSynchronized --value 2>/dev/null | tr -d '\r' || true)"
  if [[ "$ntp_synchronized" == "yes" ]]; then
    pass "系统时间已同步"
  else
    warn "无法确认系统时间同步；TLS 与飞书 OAuth 可能受影响"
  fi
else
  warn "没有 timedatectl，无法确认系统时间同步"
fi

dlr_web_container=""
dlr_api_container=""
dlr_web_uses_target_port=false
if [[ "$docker_ready" == true ]]; then
  dlr_web_container="$(docker ps \
    --filter "label=com.docker.compose.project=${TARGET_COMPOSE_PROJECT}" \
    --filter 'label=com.docker.compose.service=web' --format '{{.ID}}' | head -n 1)"
  dlr_api_container="$(docker ps \
    --filter "label=com.docker.compose.project=${TARGET_COMPOSE_PROJECT}" \
    --filter 'label=com.docker.compose.service=api' --format '{{.ID}}' | head -n 1)"
  if [[ -n "$dlr_web_container" ]] \
    && docker port "$dlr_web_container" 2>/dev/null | grep -Eq ":${TARGET_PUBLIC_PORT}$"; then
    dlr_web_uses_target_port=true
  fi
  other_projects="$(docker ps --format '{{.Label "com.docker.compose.project"}}' \
    | grep -Ev "^$|^${TARGET_COMPOSE_PROJECT}$" | sort -u | awk 'END {print NR+0}')"
  pass "检测到 ${other_projects} 个其他 Compose project；preflight 未操作它们"
  if [[ -n "$dlr_api_container" && -n "$dlr_web_container" ]]; then
    pass "现有 DLR API/Web 正在运行，可作为本次更新的旧版本"
  else
    warn "没有完整运行中的 DLR API/Web；这可能是首次部署"
  fi
fi

if command -v ss >/dev/null 2>&1; then
  if ss -ltn | awk '{print $4}' | grep -Eq "[:.]${TARGET_PUBLIC_PORT}$"; then
    if [[ "$dlr_web_uses_target_port" == true ]]; then
      pass "端口 ${TARGET_PUBLIC_PORT} 由现有 DLR Web 使用，可在更新时复用"
    else
      fail "端口 ${TARGET_PUBLIC_PORT} 已被非 DLR 服务占用"
    fi
  else
    pass "端口 ${TARGET_PUBLIC_PORT} 当前空闲"
  fi
else
  fail "缺少 ss，无法确认端口 ${TARGET_PUBLIC_PORT}"
fi

ENV_FILE="${TARGET_INSTALL_ROOT}/shared/.env"
database_url=""
oss_endpoint=""
if [[ ! -f "$ENV_FILE" ]]; then
  warn "生产配置尚不存在；首次 bootstrap 后需要填写 ${ENV_FILE}"
else
  env_permissions="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || printf unknown)"
  if [[ "$env_permissions" == "600" ]]; then
    pass "生产配置权限为 0600"
  else
    fail "生产配置权限为 ${env_permissions}，要求 0600；preflight 不会自动修正"
  fi
  missing_variables=()
  for required_variable in DATABASE_URL ALIYUN_OSS_REGION ALIYUN_OSS_ACCESS_KEY_ID \
    ALIYUN_OSS_ACCESS_KEY_SECRET ALIYUN_OSS_BUCKET_NAME WEB_ORIGIN FEISHU_PERSISTENCE_MODE \
    PUBLIC_BIND_ADDRESS PUBLIC_PORT; do
    variable_value="$(env_value "$ENV_FILE" "$required_variable")"
    if [[ -z "$variable_value" || "$variable_value" == FILL_* ]]; then
      missing_variables+=("$required_variable")
    fi
  done
  if (( ${#missing_variables[@]} == 0 )); then
    pass "生产配置必填项完整（未输出任何密钥值）"
  else
    fail "生产配置缺少或未填写：${missing_variables[*]}"
  fi
  persistence_mode="$(env_value "$ENV_FILE" FEISHU_PERSISTENCE_MODE)"
  if [[ "$persistence_mode" == "postgres-oss" ]]; then
    pass "飞书持久化模式为 postgres-oss"
  else
    fail "飞书持久化模式为 ${persistence_mode:-missing}，生产要求 postgres-oss"
  fi
  bind_address="$(env_value "$ENV_FILE" PUBLIC_BIND_ADDRESS)"
  configured_public_port="$(env_value "$ENV_FILE" PUBLIC_PORT)"
  if [[ "$configured_public_port" == "$TARGET_PUBLIC_PORT" ]]; then
    pass "生产配置端口与目标画像一致（${TARGET_PUBLIC_PORT}）"
  else
    fail "生产配置端口为 ${configured_public_port:-missing}，目标画像要求 ${TARGET_PUBLIC_PORT}"
  fi
  if [[ "$bind_address" == "0.0.0.0" ]]; then
    public_access_acknowledged="$(env_value "$ENV_FILE" ALLOW_UNAUTHENTICATED_PUBLIC_ACCESS)"
    if [[ "$public_access_acknowledged" == "true" ]]; then
      warn "后台绑定公网且已显式接受当前无登录鉴权的风险；preflight 无法判断阿里云安全组"
    else
      fail "后台绑定公网但未设置 ALLOW_UNAUTHENTICATED_PUBLIC_ACCESS=true"
    fi
  else
    pass "后台未直接绑定所有公网网卡"
  fi
  database_url="$(env_value "$ENV_FILE" DATABASE_URL)"
  oss_endpoint="$(env_value "$ENV_FILE" ALIYUN_OSS_ENDPOINT)"
  if [[ -z "$oss_endpoint" ]]; then
    oss_region="$(env_value "$ENV_FILE" ALIYUN_OSS_REGION)"
    [[ -n "$oss_region" ]] && oss_endpoint="${oss_region}.aliyuncs.com"
  fi
fi

if command -v curl >/dev/null 2>&1; then
  probe_docker_registry
  http_probe "Debian 软件源" "https://deb.debian.org/debian/" true
  http_probe "pnpm/npm 镜像" "https://registry.npmmirror.com/pnpm" true
  http_probe "PyPI uv 镜像" "https://mirrors.aliyun.com/pypi/simple/uv/" true
  case "$TARGET_ARCH" in
    x86_64) lark_arch="amd64" ;;
    aarch64|arm64) lark_arch="arm64" ;;
    *) lark_arch="unknown" ;;
  esac
  if [[ "$lark_arch" != "unknown" ]]; then
    http_probe "飞书 CLI 1.0.88 镜像" \
      "https://registry.npmmirror.com/-/binary/lark-cli/v1.0.88/lark-cli-1.0.88-linux-${lark_arch}.tar.gz" true
  else
    fail "飞书 CLI 没有为目标架构 ${TARGET_ARCH} 配置下载探测"
  fi
  if [[ -n "$oss_endpoint" && "$oss_endpoint" =~ ^[A-Za-z0-9.-]+$ ]]; then
    http_probe "OSS endpoint（仅网络/TLS，不验证凭据）" "https://${oss_endpoint}/" true
    info "preflight 按只读边界不验证 OSS 写权限；AccessKey 权限留给 deploy 深度验收"
  elif [[ -n "$oss_endpoint" ]]; then
    fail "OSS endpoint 格式不安全或不受支持"
  else
    warn "没有生产 OSS endpoint，首次部署暂不探测"
  fi
fi

if [[ -n "$database_url" && "$database_url" =~ ^postgres(ql)?:// ]]; then
  database_authority="${database_url#*://}"
  database_authority="${database_authority%%/*}"
  database_host_port="${database_authority##*@}"
  database_host="${database_host_port%%:*}"
  if [[ "$database_host_port" == *:* ]]; then database_port="${database_host_port##*:}"; else database_port="5432"; fi
  if [[ "$database_host" =~ ^[A-Za-z0-9._-]+$ && "$database_port" =~ ^[0-9]+$ ]]; then
    if timeout 6 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$database_host" "$database_port" 2>/dev/null; then
      pass "PostgreSQL TCP 可达（主机名和连接串未输出）"
    else
      fail "PostgreSQL TCP 不可达（主机名和连接串未输出）"
    fi
  else
    warn "DATABASE_URL 使用了 preflight 不支持的主机格式，未输出或执行连接串"
  fi
else
  warn "没有可探测的 DATABASE_URL；首次部署暂不检查 PostgreSQL"
fi

if [[ -n "$dlr_api_container" ]] && command -v curl >/dev/null 2>&1; then
  if curl --fail --silent --show-error --max-time 10 \
    "http://127.0.0.1:${TARGET_PUBLIC_PORT}/api/summary" 2>/dev/null \
    | grep -Eq '"configured"[[:space:]]*:[[:space:]]*true'; then
    pass "现有 DLR 只读摘要确认应用可访问 PostgreSQL"
  else
    warn "现有 DLR 摘要未确认数据库 configured=true"
  fi
fi

if command -v ufw >/dev/null 2>&1; then
  ufw_status="$(ufw status 2>/dev/null || true)"
  if grep -q '^Status: active' <<< "$ufw_status"; then
    if grep -Eq "${TARGET_PUBLIC_PORT}/tcp[[:space:]]+ALLOW|${TARGET_PUBLIC_PORT}[[:space:]]+ALLOW" <<< "$ufw_status"; then
      pass "UFW 已放行 ${TARGET_PUBLIC_PORT}；阿里云安全组仍需外部验收"
    else
      warn "UFW 已启用但未发现 ${TARGET_PUBLIC_PORT} 放行规则"
    fi
  else
    warn "UFW 未启用；需依赖云安全组或其他主机防火墙"
  fi
else
  warn "未安装 UFW；preflight 不会修改防火墙"
fi

finish
