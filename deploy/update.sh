#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROJECT_NAME="puzzle"
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.production"
DO_BUILD="1"
SKIP_PULL="0"
ALLOW_DIRTY="0"
SKIP_BACKFILL="0"

usage() {
  cat <<'USAGE'
Usage: deploy/update.sh [options]

Options:
  --project-name <name>   Docker compose project name (default: puzzle)
  --compose-file <path>   Compose file path (default: docker-compose.prod.yml)
  --env-file <path>       Env file path (default: .env.production)
  --no-build              Skip docker image rebuild
  --skip-pull             Skip git pull
  --allow-dirty           Allow git pull when working tree is dirty
  --skip-backfill         Skip generation-job-meta data backfill
  -h, --help              Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-name)
      PROJECT_NAME="$2"
      shift 2
      ;;
    --compose-file)
      COMPOSE_FILE="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --no-build)
      DO_BUILD="0"
      shift
      ;;
    --skip-pull)
      SKIP_PULL="1"
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY="1"
      shift
      ;;
    --skip-backfill)
      SKIP_BACKFILL="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[error] Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "[error] Compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[error] Env file not found: $ENV_FILE" >&2
  echo "[hint] Create it from .env.production.example first." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[error] docker command not found" >&2
  exit 1
fi

if [[ "$SKIP_PULL" != "1" ]]; then
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "[error] Current directory is not a git repository: $ROOT_DIR" >&2
    exit 1
  fi

  if [[ "$ALLOW_DIRTY" != "1" ]] && [[ -n "$(git status --porcelain)" ]]; then
    echo "[error] Working tree is dirty. Commit/stash first, or pass --allow-dirty." >&2
    git status --short
    exit 1
  fi

  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  echo "[info] Pull latest code for branch: $BRANCH"
  git fetch origin "$BRANCH"
  git pull --ff-only origin "$BRANCH"
fi

COMPOSE=(docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

echo "[info] Validate compose config"
"${COMPOSE[@]}" config >/dev/null

echo "[info] Start services"
if [[ "$DO_BUILD" == "1" ]]; then
  "${COMPOSE[@]}" up -d --build
else
  "${COMPOSE[@]}" up -d
fi

echo "[info] Service status"
"${COMPOSE[@]}" ps

if [[ "$SKIP_BACKFILL" != "1" ]]; then
  echo "[info] Run data backfill: generation_job_meta"
  "${COMPOSE[@]}" exec -T node-app npm --prefix backend run backfill:generation-job-meta
fi

WEB_PORT="$(grep -E '^WEB_PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2-)"
WEB_PORT="${WEB_PORT:-8080}"

HEALTH_URL="http://127.0.0.1:${WEB_PORT}/api/health"
echo "[info] Check health: $HEALTH_URL"

ok="0"
for _ in {1..30}; do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    ok="1"
    break
  fi
  sleep 2
done

if [[ "$ok" != "1" ]]; then
  echo "[warn] Health check failed. Check logs:" >&2
  echo "       ${COMPOSE[*]} logs -f node-app story-worker web" >&2
  exit 1
fi

echo "[done] Update finished successfully."
