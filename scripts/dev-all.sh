#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load local env (non-Docker dev).
if [[ -f "$ROOT_DIR/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.local"
  set +a
elif [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

: "${BOOK_INGEST_DB_PATH:=$ROOT_DIR/scripts/book_ingest/data/books.sqlite}"
: "${STORY_GENERATOR_OUTPUT_ROOT:=${STORY_GENERATION_OUTPUT_ROOT:-$ROOT_DIR/backend/data/generated/content/stories}}"
: "${STORY_GENERATOR_INDEX_FILE:=${STORY_GENERATION_INDEX_FILE:-$ROOT_DIR/backend/data/generated/content/stories/index.json}}"
: "${STORY_GENERATOR_LOG_DIR:=${STORY_GENERATION_LOG_DIR:-$ROOT_DIR/backend/data/generated/logs/story_generator}}"
: "${STORY_GENERATOR_SUMMARY_DIR:=${STORY_GENERATION_SUMMARY_DIR:-$ROOT_DIR/backend/data/generated/summaries/story_generator}}"
: "${STORY_GENERATOR_QUEUE_POLL_SECONDS:=${STORY_GENERATION_QUEUE_POLL_SECONDS:-2}}"
: "${STORY_GENERATOR_BACKEND_URL:=${STORY_GENERATION_BACKEND_URL:-http://127.0.0.1:8787}}"
: "${STORY_GENERATOR_WORKER_TOKEN:=${STORY_GENERATION_WORKER_TOKEN:-dev-worker-token}}"

STORY_GENERATION_OUTPUT_ROOT="$STORY_GENERATOR_OUTPUT_ROOT"
STORY_GENERATION_INDEX_FILE="$STORY_GENERATOR_INDEX_FILE"
STORY_GENERATION_LOG_DIR="$STORY_GENERATOR_LOG_DIR"
STORY_GENERATION_SUMMARY_DIR="$STORY_GENERATOR_SUMMARY_DIR"
STORY_GENERATION_QUEUE_POLL_SECONDS="$STORY_GENERATOR_QUEUE_POLL_SECONDS"
STORY_GENERATION_BACKEND_URL="$STORY_GENERATOR_BACKEND_URL"
STORY_GENERATION_WORKER_TOKEN="$STORY_GENERATOR_WORKER_TOKEN"

export BOOK_INGEST_DB_PATH
export STORY_GENERATOR_OUTPUT_ROOT
export STORY_GENERATOR_INDEX_FILE
export STORY_GENERATOR_LOG_DIR
export STORY_GENERATOR_SUMMARY_DIR
export STORY_GENERATOR_QUEUE_POLL_SECONDS
export STORY_GENERATOR_BACKEND_URL
export STORY_GENERATOR_WORKER_TOKEN
export STORY_GENERATION_OUTPUT_ROOT
export STORY_GENERATION_INDEX_FILE
export STORY_GENERATION_LOG_DIR
export STORY_GENERATION_SUMMARY_DIR
export STORY_GENERATION_QUEUE_POLL_SECONDS
export STORY_GENERATION_BACKEND_URL
export STORY_GENERATION_WORKER_TOKEN

if [[ -z "${AIHUBMIX_API_KEY:-}" ]]; then
  echo "[warn] AIHUBMIX_API_KEY is empty. Story generation jobs may fail."
fi

mkdir -p "$STORY_GENERATOR_OUTPUT_ROOT"
mkdir -p "$STORY_GENERATOR_LOG_DIR"
mkdir -p "$STORY_GENERATOR_SUMMARY_DIR"

npm --prefix "$ROOT_DIR/backend" install
# better-sqlite3 is a native module; rebuild it for the current Node runtime
npm --prefix "$ROOT_DIR/backend" rebuild better-sqlite3
npm --prefix "$ROOT_DIR/web" install

npm --prefix "$ROOT_DIR/backend" run dev &
BACKEND_PID=$!

echo "[info] backend started (pid=$BACKEND_PID)"

for _ in {1..40}; do
  if curl -fsS "${STORY_GENERATOR_BACKEND_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

npm --prefix "$ROOT_DIR/web" run dev &
WEB_PID=$!

echo "[info] web started (pid=$WEB_PID)"

WORKER_PID=""
if command -v uv >/dev/null 2>&1; then
  uv run python "$ROOT_DIR/scripts/story_generator_pipeline/queue_worker.py" \
    --backend-url "$STORY_GENERATOR_BACKEND_URL" \
    --worker-token "$STORY_GENERATOR_WORKER_TOKEN" \
    --poll-seconds "$STORY_GENERATOR_QUEUE_POLL_SECONDS" &
  WORKER_PID=$!
  echo "[info] worker started (pid=$WORKER_PID)"
else
  echo "[warn] uv not found, worker not started."
fi

cleanup() {
  kill "$BACKEND_PID" "$WEB_PID" 2>/dev/null || true
  if [[ -n "$WORKER_PID" ]]; then
    kill "$WORKER_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

wait
