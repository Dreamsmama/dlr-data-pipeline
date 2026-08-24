#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="dlr-data-pipeline"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/${APP_NAME}}"
REPOSITORY_DIR="${REPOSITORY_DIR:-${INSTALL_ROOT}/repository}"
SHARED_DIR="${SHARED_DIR:-${INSTALL_ROOT}/shared}"
ENV_FILE="${APP_ENV_FILE:-${SHARED_DIR}/.env}"
DATA_DIR="${APP_DATA_DIR:-${SHARED_DIR}/data}"
LOG_DIR="${SHARED_DIR}/logs"
BRANCH_FILE="${SHARED_DIR}/deploy-branch"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-}"
if [[ -z "$DEPLOY_BRANCH" && -f "$BRANCH_FILE" ]]; then
  DEPLOY_BRANCH="$(tr -d '\r\n' < "$BRANCH_FILE")"
fi
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
REPOSITORY_URL="${REPOSITORY_URL:-https://github.com/Dreamsmama/dlr-data-pipeline.git}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-dlr-data-pipeline}"
LOCK_FILE="${INSTALL_ROOT}/deploy.lock"
LAUNCHER_PATH="${INSTALL_ROOT}/deploy.sh"
SWITCH_STARTED=false
OLD_API_IMAGE=""
OLD_WEB_IMAGE=""
ROLLBACK_TAG="rollback-$(date +%Y%m%d%H%M%S)"

if [[ "${EUID}" -ne 0 ]]; then
  printf '请使用 root 运行部署脚本\n' >&2
  exit 1
fi

mkdir -p "$INSTALL_ROOT" "$SHARED_DIR" "$DATA_DIR" "$LOG_DIR"
LOG_FILE="${LOG_DIR}/deploy-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

git_with_retry() {
  local attempt status
  for attempt in 1 2 3; do
    if git -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=60 "$@"; then
      return 0
    else
      status=$?
    fi
    if (( attempt == 3 )); then
      return "$status"
    fi
    log "GitHub 连接失败，${attempt}/3，等待 $((attempt * 5)) 秒后重试"
    sleep $((attempt * 5))
  done
}

clone_repository() {
  local attempt
  local clone_dir="${REPOSITORY_DIR}.clone.$$"
  if [[ -e "$REPOSITORY_DIR" ]]; then
    if [[ -n "$(find "$REPOSITORY_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
      log "${REPOSITORY_DIR} 已存在但不是 Git 仓库，请人工确认其内容"
      return 1
    fi
    rmdir "$REPOSITORY_DIR"
  fi

  for attempt in 1 2 3; do
    rm -rf "$clone_dir"
    if git -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=60 \
      clone --depth=1 --single-branch --branch "$DEPLOY_BRANCH" "$REPOSITORY_URL" "$clone_dir"; then
      mv "$clone_dir" "$REPOSITORY_DIR"
      return 0
    fi
    if (( attempt < 3 )); then
      log "GitHub 克隆失败，${attempt}/3，等待 $((attempt * 5)) 秒后重试"
      sleep $((attempt * 5))
    fi
  done
  rm -rf "$clone_dir"
  return 1
}

compose() {
  docker compose --project-name "$COMPOSE_PROJECT_NAME" --file "$REPOSITORY_DIR/docker-compose.yml" "$@"
}

container_image() {
  local service="$1"
  local container_id
  container_id="$(compose ps -q "$service" 2>/dev/null || true)"
  if [[ -n "$container_id" ]]; then
    docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true
  fi
}

wait_for_application() {
  local attempt
  for attempt in $(seq 1 30); do
    if curl --fail --silent --show-error "http://127.0.0.1:${PUBLIC_PORT}/" >/dev/null \
      && curl --fail --silent --show-error "http://127.0.0.1:${PUBLIC_PORT}/api/summary" | grep -q '"configured":true'; then
      return 0
    fi
    log "等待应用健康检查 (${attempt}/30)"
    sleep 4
  done
  return 1
}

rollback() {
  set +e
  if [[ -n "$OLD_API_IMAGE" && -n "$OLD_WEB_IMAGE" ]]; then
    log "新版本启动失败，恢复上一版镜像 ${ROLLBACK_TAG}"
    docker image tag "$OLD_API_IMAGE" "dlr-data-pipeline-api:${ROLLBACK_TAG}"
    docker image tag "$OLD_WEB_IMAGE" "dlr-data-pipeline-web:${ROLLBACK_TAG}"
    export DEPLOY_IMAGE_TAG="$ROLLBACK_TAG"
    compose up --detach --no-build --force-recreate api web
    if wait_for_application; then
      printf '%s\n' "$ROLLBACK_TAG" > "${SHARED_DIR}/current-version"
      log "已恢复上一版服务"
    else
      log "自动回退未通过健康检查，请查看容器日志"
      compose logs --tail 100 api web
    fi
  else
    log "首次部署失败，没有可回退版本；正在停止未通过检查的容器"
    compose down
  fi
}

on_error() {
  local status=$?
  trap - ERR
  log "部署失败，退出码 ${status}，日志：${LOG_FILE}"
  if [[ "$SWITCH_STARTED" == true ]]; then
    rollback
  fi
  exit "$status"
}
trap on_error ERR

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "已有部署任务正在运行"
  exit 1
fi

if ! command -v git >/dev/null || ! command -v curl >/dev/null || ! command -v flock >/dev/null; then
  log "安装 Git、curl 和部署锁依赖"
  apt-get update
  apt-get install -y git curl ca-certificates util-linux
fi

if ! command -v docker >/dev/null; then
  log "安装 Docker Engine"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null

if [[ ! -d "${REPOSITORY_DIR}/.git" ]]; then
  log "克隆 ${DEPLOY_BRANCH} 分支"
  clone_repository
fi

cd "$REPOSITORY_DIR"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  log "服务器仓库存在未提交改动，已停止以免覆盖"
  exit 1
fi

log "拉取 ${DEPLOY_BRANCH} 最新代码"
git config --local http.version HTTP/1.1
git_with_retry fetch --depth=1 --prune origin \
  "+refs/heads/${DEPLOY_BRANCH}:refs/remotes/origin/${DEPLOY_BRANCH}"
git checkout -B "$DEPLOY_BRANCH" "origin/$DEPLOY_BRANCH"
printf '%s\n' "$DEPLOY_BRANCH" > "$BRANCH_FILE"

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
if [[ "$SCRIPT_PATH" != "$(readlink -m "$LAUNCHER_PATH")" ]]; then
  install -m 755 "$REPOSITORY_DIR/deploy.sh" "$LAUNCHER_PATH"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$REPOSITORY_DIR/deploy/.env.production.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "已生成生产配置：${ENV_FILE}"
  log "请填写所有 FILL_ 项后再次运行本脚本"
  exit 2
fi
chmod 600 "$ENV_FILE"

if grep -Eq '^[A-Z0-9_]+=FILL_' "$ENV_FILE"; then
  log "生产配置仍有未填写的 FILL_ 项：${ENV_FILE}"
  grep -E '^[A-Z0-9_]+=FILL_' "$ENV_FILE" | cut -d= -f1
  exit 2
fi

for required in DATABASE_URL ALIYUN_OSS_REGION ALIYUN_OSS_ACCESS_KEY_ID ALIYUN_OSS_ACCESS_KEY_SECRET ALIYUN_OSS_BUCKET_NAME; do
  if ! grep -Eq "^${required}=.+" "$ENV_FILE"; then
    log "生产配置缺少 ${required}"
    exit 2
  fi
done

PUBLIC_PORT="$(sed -n 's/^PUBLIC_PORT=//p' "$ENV_FILE" | tail -n 1 | tr -d '\r')"
PUBLIC_PORT="${PUBLIC_PORT:-3002}"
if [[ ! "$PUBLIC_PORT" =~ ^[0-9]+$ ]] || (( PUBLIC_PORT < 1 || PUBLIC_PORT > 65535 )); then
  log "PUBLIC_PORT 必须是 1-65535 之间的端口"
  exit 2
fi
PUBLIC_BIND_ADDRESS="$(sed -n 's/^PUBLIC_BIND_ADDRESS=//p' "$ENV_FILE" | tail -n 1 | tr -d '\r')"
PUBLIC_BIND_ADDRESS="${PUBLIC_BIND_ADDRESS:-127.0.0.1}"
if [[ "$PUBLIC_BIND_ADDRESS" != "127.0.0.1" && "$PUBLIC_BIND_ADDRESS" != "0.0.0.0" ]]; then
  log "PUBLIC_BIND_ADDRESS 只允许 127.0.0.1 或 0.0.0.0"
  exit 2
fi

export APP_ENV_FILE="$ENV_FILE"
export APP_DATA_DIR="$DATA_DIR"
export COMPOSE_PROJECT_NAME
export PUBLIC_BIND_ADDRESS
export PUBLIC_PORT
DEPLOY_IMAGE_TAG="$(git rev-parse --short=12 HEAD)"
export DEPLOY_IMAGE_TAG

OLD_API_IMAGE="$(container_image api)"
OLD_WEB_IMAGE="$(container_image web)"

if [[ -z "$OLD_WEB_IMAGE" ]] && command -v ss >/dev/null \
  && ss -ltn | awk '{print $4}' | grep -Eq "[:.]${PUBLIC_PORT}$"; then
  log "端口 ${PUBLIC_PORT} 已被其他服务占用，请修改 ${ENV_FILE} 中的 PUBLIC_PORT"
  exit 1
fi

log "构建提交 ${DEPLOY_IMAGE_TAG} 的镜像"
compose build --pull api web

log "执行幂等数据库 migration"
compose run --rm migrate

SWITCH_STARTED=true
log "切换到新版本容器"
compose up --detach --no-build --force-recreate api web

if ! wait_for_application; then
  compose logs --tail 100 api web
  false
fi

printf '%s\n' "$DEPLOY_IMAGE_TAG" > "${SHARED_DIR}/current-version"
SWITCH_STARTED=false
if [[ "$PUBLIC_BIND_ADDRESS" == "0.0.0.0" ]]; then
  ACCESS_HOST="121.199.52.72"
else
  ACCESS_HOST="127.0.0.1"
fi
log "部署成功：commit=${DEPLOY_IMAGE_TAG} url=http://${ACCESS_HOST}:${PUBLIC_PORT}"
log "容器状态："
compose ps
