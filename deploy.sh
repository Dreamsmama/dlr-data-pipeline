#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="dlr-data-pipeline"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/${APP_NAME}}"
SHARED_DIR="${SHARED_DIR:-${INSTALL_ROOT}/shared}"
ENV_FILE="${APP_ENV_FILE:-${SHARED_DIR}/.env}"
DATA_DIR="${APP_DATA_DIR:-${SHARED_DIR}/data}"
BACKUP_DIR="${APP_BACKUP_DIR:-${SHARED_DIR}/backups}"
LOG_DIR="${SHARED_DIR}/logs"
METADATA_DIR="${SHARED_DIR}/deployments"
INCOMING_DIR="${INSTALL_ROOT}/incoming"
RELEASES_DIR="${INSTALL_ROOT}/releases"
CURRENT_RELEASE_LINK="${SHARED_DIR}/current-release"
PREVIOUS_RELEASE_LINK="${SHARED_DIR}/previous-release"
CURRENT_VERSION_FILE="${SHARED_DIR}/current-version"
PREVIOUS_VERSION_FILE="${SHARED_DIR}/previous-version"
LOCK_FILE="${INSTALL_ROOT}/deploy.lock"
LAUNCHER_PATH="${INSTALL_ROOT}/deploy.sh"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-dlr-data-pipeline}"
SOURCE_ARCHIVE="${DEPLOY_SOURCE_ARCHIVE:-}"
SOURCE_VERSION="${DEPLOY_SOURCE_VERSION:-}"
SOURCE_SHA256="${DEPLOY_SOURCE_SHA256:-}"
SOURCE_BRANCH="${DEPLOY_SOURCE_BRANCH:-main}"

COMMAND="${1:-deploy}"
if (( $# > 0 )); then shift; fi
ROLLBACK_VERSION="${1:-}"

COMPOSE_FILE=""
RELEASE_DIR=""
PUBLIC_PORT=""
PUBLIC_BIND_ADDRESS=""
SWITCH_STARTED=false
OLD_RELEASE=""
OLD_VERSION=""
OLD_COMPOSE_FILE=""
LOG_FILE=""
BACKUP_FILE_PATH=""

usage() {
  cat <<'EOF'
Usage: deploy.sh <command> [version]

Commands:
  bootstrap          Install host prerequisites and create the production env template
  deploy             Build, back up, migrate, switch, and verify an uploaded release
  verify             Verify the currently deployed release
  status             Show the current release, resources, and container state
  rollback <version> Switch to a retained release and verify it
  public-url         Print the configured non-secret WEB_ORIGIN
EOF
}

if [[ ! "$COMMAND" =~ ^(bootstrap|deploy|verify|status|rollback|public-url)$ ]]; then
  usage >&2
  exit 64
fi
if [[ "$COMMAND" == "rollback" && -z "$ROLLBACK_VERSION" ]]; then
  usage >&2
  exit 64
fi
if [[ "${EUID}" -ne 0 ]]; then
  printf '请使用 root 运行部署脚本\n' >&2
  exit 1
fi

mkdir -p "$INSTALL_ROOT" "$SHARED_DIR" "$DATA_DIR" "$BACKUP_DIR" "$LOG_DIR" \
  "$METADATA_DIR" "$INCOMING_DIR" "$RELEASES_DIR"
LOG_FILE="${LOG_DIR}/${COMMAND}-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

env_value() {
  local name="$1"
  sed -n "s/^${name}=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r'
}

compose() {
  docker compose \
    --project-name "$COMPOSE_PROJECT_NAME" \
    --env-file "$ENV_FILE" \
    --file "$COMPOSE_FILE" \
    "$@"
}

read_version_file() {
  local file="$1"
  if [[ -f "$file" ]]; then tr -d '\r\n' < "$file"; fi
}

resolve_link() {
  local link="$1"
  if [[ -L "$link" ]]; then readlink -f "$link" 2>/dev/null || true; fi
}

require_release_layout() {
  local directory="$1"
  if [[ ! -f "${directory}/docker-compose.yml" || ! -f "${directory}/deploy.sh" \
    || ! -f "${directory}/deploy/runtime-check.sh" || ! -f "${directory}/deploy/smoke-test.sh" ]]; then
    log "发布目录不完整：${directory}"
    return 1
  fi
}

set_release_context() {
  local directory="$1"
  require_release_layout "$directory"
  RELEASE_DIR="$(readlink -f "$directory")"
  case "$RELEASE_DIR" in
    "$RELEASES_DIR"/*) ;;
    *) log "发布目录超出 ${RELEASES_DIR}"; return 1 ;;
  esac
  COMPOSE_FILE="${RELEASE_DIR}/docker-compose.yml"
}

install_launcher() {
  local source="$1"
  local resolved_source resolved_target
  resolved_source="$(readlink -f "$source")"
  resolved_target="$(readlink -m "$LAUNCHER_PATH")"
  if [[ "$resolved_source" != "$resolved_target" ]]; then
    install -m 755 "$source" "$LAUNCHER_PATH"
  fi
}

acquire_lock() {
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "已有部署或回滚任务正在运行"
    exit 75
  fi
}

install_host_prerequisites() {
  log "检查服务器部署依赖"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates curl git iproute2 tar util-linux
  if ! command -v docker >/dev/null 2>&1; then
    local installer="/tmp/${APP_NAME}-get-docker.$$"
    log "安装 Docker Engine"
    curl --fail --silent --show-error --location https://get.docker.com --output "$installer"
    sh "$installer"
    rm -f "$installer"
  fi
  docker compose version >/dev/null
}

check_host_prerequisites() {
  local missing=()
  local command
  for command in curl docker flock sha256sum tar ss awk sed grep find sort; do
    command -v "$command" >/dev/null 2>&1 || missing+=("$command")
  done
  if (( ${#missing[@]} > 0 )); then
    log "服务器缺少部署命令：${missing[*]}；请先执行 bootstrap"
    return 1
  fi
  docker compose version >/dev/null
}

prepare_archive_release() {
  local archive_path archive_listing calculated_sha release_dir temporary_dir
  if [[ -z "$SOURCE_ARCHIVE" || -z "$SOURCE_VERSION" || -z "$SOURCE_SHA256" ]]; then
    log "deploy/bootstrap 必须由本地入口提供制品、提交 ID 和 SHA-256"
    return 1
  fi
  if [[ ! "$SOURCE_VERSION" =~ ^[0-9a-f]{40}$ || ! "$SOURCE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    log "提交 ID 或制品 SHA-256 格式不合法"
    return 1
  fi
  if [[ ! "$SOURCE_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    log "部署分支名包含不安全字符"
    return 1
  fi
  archive_path="$(readlink -f "$SOURCE_ARCHIVE")"
  case "$archive_path" in
    "$INCOMING_DIR"/*) ;;
    *) log "部署制品必须位于 ${INCOMING_DIR}"; return 1 ;;
  esac
  [[ -f "$archive_path" ]] || { log "部署制品不存在：${archive_path}"; return 1; }
  calculated_sha="$(sha256sum "$archive_path" | awk '{print $1}')"
  if [[ "$calculated_sha" != "$SOURCE_SHA256" ]]; then
    log "部署制品 SHA-256 校验失败"
    return 1
  fi
  archive_listing="$(tar -tzf "$archive_path")"
  if grep -Eq '(^/|(^|/)\.\.(/|$))' <<< "$archive_listing"; then
    log "部署制品包含不安全路径"
    return 1
  fi

  release_dir="${RELEASES_DIR}/${SOURCE_VERSION}"
  if [[ ! -d "$release_dir" ]]; then
    temporary_dir="${release_dir}.extract.$$"
    mkdir "$temporary_dir"
    tar -xzf "$archive_path" -C "$temporary_dir"
    require_release_layout "$temporary_dir"
    mv "$temporary_dir" "$release_dir"
  fi
  set_release_context "$release_dir"
  install_launcher "${RELEASE_DIR}/deploy.sh"
}

ensure_config_template() {
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "${RELEASE_DIR}/deploy/.env.production.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    log "已生成生产配置：${ENV_FILE}"
    log "请填写所有 FILL_ 项；密钥不要提交到 Git 或粘贴到部署日志"
    return 2
  fi
  chmod 600 "$ENV_FILE"
}

validate_config() {
  local required value permissions
  [[ -f "$ENV_FILE" ]] || { log "生产配置不存在：${ENV_FILE}；请先执行 bootstrap"; return 2; }
  permissions="$(stat -c '%a' "$ENV_FILE")"
  if [[ "$permissions" != "600" ]]; then
    chmod 600 "$ENV_FILE"
    log "已将生产配置权限修正为 0600"
  fi
  if grep -Eq '^[A-Z0-9_]+=FILL_' "$ENV_FILE"; then
    log "生产配置仍有未填写项："
    grep -E '^[A-Z0-9_]+=FILL_' "$ENV_FILE" | cut -d= -f1
    return 2
  fi
  for required in DATABASE_URL ALIYUN_OSS_REGION ALIYUN_OSS_ACCESS_KEY_ID \
    ALIYUN_OSS_ACCESS_KEY_SECRET ALIYUN_OSS_BUCKET_NAME WEB_ORIGIN FEISHU_PERSISTENCE_MODE; do
    value="$(env_value "$required")"
    [[ -n "$value" ]] || { log "生产配置缺少 ${required}"; return 2; }
  done

  PUBLIC_PORT="$(env_value PUBLIC_PORT)"
  PUBLIC_PORT="${PUBLIC_PORT:-3002}"
  if [[ ! "$PUBLIC_PORT" =~ ^[0-9]+$ ]] || (( PUBLIC_PORT < 1 || PUBLIC_PORT > 65535 )); then
    log "PUBLIC_PORT 必须是 1-65535 之间的端口"
    return 2
  fi
  PUBLIC_BIND_ADDRESS="$(env_value PUBLIC_BIND_ADDRESS)"
  PUBLIC_BIND_ADDRESS="${PUBLIC_BIND_ADDRESS:-127.0.0.1}"
  if [[ "$PUBLIC_BIND_ADDRESS" != "127.0.0.1" && "$PUBLIC_BIND_ADDRESS" != "0.0.0.0" ]]; then
    log "PUBLIC_BIND_ADDRESS 只允许 127.0.0.1 或 0.0.0.0"
    return 2
  fi
  if [[ "$(env_value FEISHU_PERSISTENCE_MODE)" != "postgres-oss" ]]; then
    log "生产环境必须设置 FEISHU_PERSISTENCE_MODE=postgres-oss"
    return 2
  fi
  if [[ ! "$(env_value WEB_ORIGIN)" =~ ^https?://[^[:space:]]+$ ]]; then
    log "WEB_ORIGIN 必须是 http/https URL"
    return 2
  fi
  if [[ "$PUBLIC_BIND_ADDRESS" == "0.0.0.0" ]]; then
    if [[ "$(env_value ALLOW_UNAUTHENTICATED_PUBLIC_ACCESS)" != "true" ]]; then
      log "当前后台没有登录鉴权；公网绑定必须显式设置 ALLOW_UNAUTHENTICATED_PUBLIC_ACCESS=true"
      return 2
    fi
    log "高风险警告：当前后台无鉴权且绑定公网地址，请尽快增加 HTTPS 与访问控制"
  fi

  export APP_ENV_FILE="$ENV_FILE"
  export APP_DATA_DIR="$DATA_DIR"
  export APP_BACKUP_DIR="$BACKUP_DIR"
  export COMPOSE_PROJECT_NAME PUBLIC_PORT PUBLIC_BIND_ADDRESS
}

positive_integer_config() {
  local name="$1" fallback="$2" value
  value="$(env_value "$name")"
  value="${value:-$fallback}"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { log "${name} 必须是正整数"; return 2; }
  printf '%s' "$value"
}

preflight_resources() {
  local minimum_disk minimum_memory free_disk available_memory current_web
  minimum_disk="$(positive_integer_config MIN_FREE_DISK_MB 8192)"
  minimum_memory="$(positive_integer_config MIN_AVAILABLE_MEMORY_MB 1024)"
  free_disk="$(df -Pm "$INSTALL_ROOT" | awk 'NR==2 {print $4}')"
  available_memory="$(awk '/MemAvailable:/ {m=$2} /SwapFree:/ {s=$2} END {printf "%d", (m+s)/1024}' /proc/meminfo)"
  log "资源预检：磁盘可用 ${free_disk} MB，内存+Swap 可用 ${available_memory} MB"
  (( free_disk >= minimum_disk )) || { log "磁盘不足，至少需要 ${minimum_disk} MB"; return 1; }
  (( available_memory >= minimum_memory )) || { log "可用内存不足，至少需要 ${minimum_memory} MB"; return 1; }

  current_web="$(docker ps --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --filter 'label=com.docker.compose.service=web' --format '{{.ID}}' | head -n 1)"
  if [[ -z "$current_web" ]] && ss -ltn | awk '{print $4}' | grep -Eq "[:.]${PUBLIC_PORT}$"; then
    log "端口 ${PUBLIC_PORT} 已被非本项目服务占用"
    return 1
  fi
  compose config --quiet
}

validate_migration_safety() {
  local old_migrations="" candidate
  if [[ -n "$OLD_RELEASE" && -d "${OLD_RELEASE}/packages/database/migrations" ]]; then
    old_migrations="${OLD_RELEASE}/packages/database/migrations"
  fi
  while IFS= read -r candidate; do
    if [[ -n "$old_migrations" && -f "${old_migrations}/$(basename "$candidate")" ]]; then
      continue
    fi
    if grep -Eiq '\b(DROP[[:space:]]+(TABLE|COLUMN)|TRUNCATE[[:space:]]+|ALTER[[:space:]]+TABLE.+ALTER[[:space:]]+COLUMN.+TYPE)\b' "$candidate"; then
      if [[ "$(env_value ALLOW_DESTRUCTIVE_MIGRATIONS)" != "true" ]]; then
        log "检测到破坏性 migration：$(basename "$candidate")"
        log "请采用兼容迁移；完成恢复演练后才可显式设置 ALLOW_DESTRUCTIVE_MIGRATIONS=true"
        return 1
      fi
      log "高风险警告：已显式允许破坏性 migration $(basename "$candidate")"
    fi
  done < <(find "${RELEASE_DIR}/packages/database/migrations" -maxdepth 1 -type f -name '*.sql' | sort)
}

backup_database() {
  local backup_file
  backup_file="${SOURCE_VERSION:-manual}-$(date +%Y%m%d-%H%M%S).dump"
  log "拉取数据库备份工具镜像"
  compose pull --quiet db-backup
  log "迁移前创建 PostgreSQL custom-format 备份：${backup_file}"
  compose run --rm --no-deps -e "BACKUP_FILE=${backup_file}" db-backup
  [[ -s "${BACKUP_DIR}/${backup_file}" ]] || { log "数据库备份为空"; return 1; }
  chmod 600 "${BACKUP_DIR}/${backup_file}"
  BACKUP_FILE_PATH="${BACKUP_DIR}/${backup_file}"
}

wait_basic_application() {
  local attempt
  for attempt in $(seq 1 15); do
    if curl --fail --silent --show-error "http://127.0.0.1:${PUBLIC_PORT}/" >/dev/null 2>&1 \
      && curl --fail --silent --show-error "http://127.0.0.1:${PUBLIC_PORT}/api/summary" \
        | grep -Eq '"configured"[[:space:]]*:[[:space:]]*true'; then
      return 0
    fi
    sleep 4
  done
  return 1
}

container_health() {
  local service="$1" container_id status health
  container_id="$(compose ps -q "$service")"
  [[ -n "$container_id" ]] || { log "${service} 容器不存在"; return 1; }
  status="$(docker inspect --format '{{.State.Status}}' "$container_id")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
  [[ "$status" == "running" && "$health" == "healthy" ]] || {
    log "${service} 状态异常：status=${status} health=${health}"
    return 1
  }
}

verify_release() {
  local deep="${1:-false}"
  log "等待并执行 Web/API 业务冒烟"
  PUBLIC_PORT="$PUBLIC_PORT" bash "${RELEASE_DIR}/deploy/smoke-test.sh"
  container_health api
  container_health web

  log "检查 API 镜像运行时"
  COMPOSE_FILE="$COMPOSE_FILE" APP_ENV_FILE="$ENV_FILE" \
    COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
    bash "${RELEASE_DIR}/deploy/runtime-check.sh"

  if [[ "$deep" == "true" ]]; then
    log "执行 PostgreSQL 写入/幂等/清理深度检查"
    compose run --rm --no-deps migrate pnpm db:check
    log "执行 OSS 上传/读取/删除深度检查"
    compose run --rm --no-deps migrate pnpm storage:check
  fi
  log "服务器内部验收通过"
}

restore_old_release() {
  local failed_compose_file="$COMPOSE_FILE"
  set +e
  if [[ -n "$OLD_RELEASE" && -f "${OLD_RELEASE}/docker-compose.yml" && -n "$OLD_VERSION" ]]; then
    log "恢复上一版本 ${OLD_VERSION}"
    RELEASE_DIR="$OLD_RELEASE"
    COMPOSE_FILE="${OLD_RELEASE}/docker-compose.yml"
    export DEPLOY_IMAGE_TAG="${OLD_VERSION:0:12}"
    compose up --detach --no-build --force-recreate api web
    if wait_basic_application; then
      ln -sfn "$OLD_RELEASE" "$CURRENT_RELEASE_LINK"
      printf '%s\n' "$OLD_VERSION" > "$CURRENT_VERSION_FILE"
      log "上一版本已恢复并通过基础检查"
    else
      log "自动恢复未通过基础检查，请人工处理；保留失败日志 ${LOG_FILE}"
      compose logs --tail 200 api web
    fi
  else
    log "首次部署没有可恢复版本，停止本项目失败容器"
    compose stop api web
  fi
  COMPOSE_FILE="$failed_compose_file"
}

on_error() {
  local status=$?
  trap - ERR
  log "命令失败：command=${COMMAND} exit=${status} log=${LOG_FILE}"
  if [[ "$SWITCH_STARTED" == true ]]; then restore_old_release; fi
  exit "$status"
}
trap on_error ERR

record_success() {
  local version="$1" release="$2" backup_file="${3:-}" previous_version="$4"
  local metadata="${METADATA_DIR}/${version}.metadata"
  {
    printf 'version=%s\n' "$version"
    printf 'branch=%s\n' "$SOURCE_BRANCH"
    printf 'artifact_sha256=%s\n' "$SOURCE_SHA256"
    printf 'release=%s\n' "$release"
    printf 'previous_version=%s\n' "$previous_version"
    printf 'backup=%s\n' "$backup_file"
    printf 'deployed_at=%s\n' "$(date --iso-8601=seconds)"
    printf 'result=success\n'
  } > "$metadata"
  chmod 600 "$metadata"
}

activate_release_record() {
  local version="$1" release="$2"
  if [[ -n "$OLD_RELEASE" && -n "$OLD_VERSION" && "$OLD_RELEASE" != "$release" ]]; then
    ln -sfn "$OLD_RELEASE" "$PREVIOUS_RELEASE_LINK"
    printf '%s\n' "$OLD_VERSION" > "$PREVIOUS_VERSION_FILE"
  fi
  ln -sfn "$release" "$CURRENT_RELEASE_LINK"
  printf '%s\n' "$version" > "$CURRENT_VERSION_FILE"
}

cleanup_backups() {
  local keep index=0 entry path
  keep="$(positive_integer_config DATABASE_BACKUP_RETENTION_COUNT 7)"
  while IFS= read -r entry; do
    index=$((index + 1))
    (( index <= keep )) && continue
    path="${entry#* }"
    case "$(readlink -f "$path")" in
      "$BACKUP_DIR"/*.dump) rm -f -- "$path" ;;
      *) log "跳过不安全的备份清理目标：${path}" ;;
    esac
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.dump' -printf '%T@ %p\n' | sort -rn)
}

cleanup_releases() {
  local keep index=0 entry version path current previous
  keep="$(positive_integer_config RELEASE_RETENTION_COUNT 5)"
  current="$(read_version_file "$CURRENT_VERSION_FILE")"
  previous="$(read_version_file "$PREVIOUS_VERSION_FILE")"
  while IFS= read -r entry; do
    index=$((index + 1))
    (( index <= keep )) && continue
    version="${entry#* }"
    [[ "$version" =~ ^[0-9a-f]{40}$ ]] || continue
    [[ "$version" == "$current" || "$version" == "$previous" ]] && continue
    path="${RELEASES_DIR}/${version}"
    case "$(readlink -f "$path")" in
      "$RELEASES_DIR"/"$version")
        rm -rf -- "$path"
        docker image rm "${APP_NAME}-api:${version:0:12}" "${APP_NAME}-web:${version:0:12}" >/dev/null 2>&1 || true
        ;;
      *) log "跳过不安全的发布清理目标：${path}" ;;
    esac
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn)
}

resolve_retained_release() {
  local requested="$1" matches=() candidate
  [[ "$requested" =~ ^[0-9a-f]{7,40}$ ]] || { log "回滚版本必须是 7-40 位 Git 提交前缀"; return 1; }
  while IFS= read -r candidate; do matches+=("$candidate"); done \
    < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -name "${requested}*" -print | sort)
  if (( ${#matches[@]} != 1 )); then
    log "回滚版本匹配数量不是 1：${requested}（匹配 ${#matches[@]} 个）"
    return 1
  fi
  printf '%s' "${matches[0]}"
}

show_status() {
  local current previous current_release free_disk available_memory
  current="$(read_version_file "$CURRENT_VERSION_FILE")"
  previous="$(read_version_file "$PREVIOUS_VERSION_FILE")"
  current_release="$(resolve_link "$CURRENT_RELEASE_LINK")"
  free_disk="$(df -Pm "$INSTALL_ROOT" | awk 'NR==2 {print $4}')"
  available_memory="$(awk '/MemAvailable:/ {m=$2} /SwapFree:/ {s=$2} END {printf "%d", (m+s)/1024}' /proc/meminfo)"
  printf 'current_version=%s\n' "${current:-none}"
  printf 'previous_version=%s\n' "${previous:-none}"
  printf 'current_release=%s\n' "${current_release:-none}"
  printf 'free_disk_mb=%s\n' "$free_disk"
  printf 'available_memory_mb=%s\n' "$available_memory"
  if [[ -n "$current_release" && -f "${current_release}/docker-compose.yml" ]]; then
    set_release_context "$current_release"
    validate_config
    export DEPLOY_IMAGE_TAG="${current:0:12}"
    compose ps
  fi
}

case "$COMMAND" in
  bootstrap)
    acquire_lock
    install_host_prerequisites
    prepare_archive_release
    if ensure_config_template; then :; else
      status=$?
      [[ "$status" == 2 ]] || exit "$status"
    fi
    log "初始化完成。填写 ${ENV_FILE} 后执行 deploy；本命令没有启动或修改现有业务容器"
    ;;

  deploy)
    acquire_lock
    check_host_prerequisites
    prepare_archive_release
    validate_config
    OLD_RELEASE="$(resolve_link "$CURRENT_RELEASE_LINK")"
    OLD_VERSION="$(read_version_file "$CURRENT_VERSION_FILE")"
    if [[ -n "$OLD_RELEASE" ]]; then OLD_COMPOSE_FILE="${OLD_RELEASE}/docker-compose.yml"; fi
    preflight_resources
    validate_migration_safety
    export DEPLOY_IMAGE_TAG="${SOURCE_VERSION:0:12}"

    log "构建不可变镜像：commit=${SOURCE_VERSION} branch=${SOURCE_BRANCH}"
    compose build --pull api web
    backup_database
    log "执行幂等数据库 migration"
    compose run --rm --no-deps migrate

    SWITCH_STARTED=true
    log "切换到新版本容器"
    compose up --detach --no-build --force-recreate api web
    deep_verify="$(env_value DEEP_VERIFY_ON_DEPLOY)"
    verify_release "${deep_verify:-true}"
    activate_release_record "$SOURCE_VERSION" "$RELEASE_DIR"
    record_success "$SOURCE_VERSION" "$RELEASE_DIR" "$BACKUP_FILE_PATH" "$OLD_VERSION"
    SWITCH_STARTED=false
    cleanup_backups
    cleanup_releases
    rm -f -- "$(readlink -f "$SOURCE_ARCHIVE")"
    log "部署成功：commit=${SOURCE_VERSION} url=$(env_value WEB_ORIGIN)"
    compose ps
    ;;

  verify)
    check_host_prerequisites
    current_release="$(resolve_link "$CURRENT_RELEASE_LINK")"
    [[ -n "$current_release" ]] || { log "尚无已部署版本"; exit 1; }
    set_release_context "$current_release"
    validate_config
    current_version="$(read_version_file "$CURRENT_VERSION_FILE")"
    export DEPLOY_IMAGE_TAG="${current_version:0:12}"
    verify_release true
    ;;

  status)
    check_host_prerequisites
    show_status
    ;;

  rollback)
    acquire_lock
    check_host_prerequisites
    target_release="$(resolve_retained_release "$ROLLBACK_VERSION")"
    target_version="$(basename "$target_release")"
    set_release_context "$target_release"
    validate_config
    OLD_RELEASE="$(resolve_link "$CURRENT_RELEASE_LINK")"
    OLD_VERSION="$(read_version_file "$CURRENT_VERSION_FILE")"
    [[ "$target_version" != "$OLD_VERSION" ]] || { log "目标版本已经是当前版本"; exit 0; }
    docker image inspect "${APP_NAME}-api:${target_version:0:12}" >/dev/null
    docker image inspect "${APP_NAME}-web:${target_version:0:12}" >/dev/null
    export DEPLOY_IMAGE_TAG="${target_version:0:12}"
    SWITCH_STARTED=true
    log "回滚代码到 ${target_version}；数据库结构不会自动逆转"
    compose up --detach --no-build --force-recreate api web
    verify_release false
    activate_release_record "$target_version" "$target_release"
    record_success "$target_version" "$target_release" "" "$OLD_VERSION"
    SWITCH_STARTED=false
    log "回滚完成：${target_version}"
    ;;

  public-url)
    validate_config
    env_value WEB_ORIGIN
    printf '\n'
    ;;
esac
