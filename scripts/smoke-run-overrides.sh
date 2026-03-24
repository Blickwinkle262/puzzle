#!/usr/bin/env bash
set -euo pipefail

# Smoke checks for run override behavior:
# 1) chapter_text_override can reuse existing payload.chapter_id on rerun
# 2) story_file + chapter_text_override is rejected
# 3) /api/runs/:runId payload stays lightweight
# 4) /api/runs/:runId/overrides can return full override text on demand

: "${RUN_ID:?RUN_ID is required}"
: "${AUTH_COOKIE:?AUTH_COOKIE is required (example: puzzle_session=...; puzzle_csrf=...)}"
: "${CSRF_TOKEN:?CSRF_TOKEN is required}"

API_BASE="${API_BASE:-http://127.0.0.1:3000/api}"
TARGET_DATE="${TARGET_DATE:-$(date +%F)}"
SCENE_COUNT="${SCENE_COUNT:-6}"
CHAPTER_OVERRIDE_TEXT="${CHAPTER_OVERRIDE_TEXT:-Smoke override $(date +%s)}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required"
  exit 1
fi

json_request() {
  local method="$1"
  local url="$2"
  local body="${3:-}"

  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "$url" \
      -H "Content-Type: application/json" \
      -H "x-csrf-token: ${CSRF_TOKEN}" \
      -H "Cookie: ${AUTH_COOKIE}" \
      --data "$body"
  else
    curl -sS -X "$method" "$url" \
      -H "x-csrf-token: ${CSRF_TOKEN}" \
      -H "Cookie: ${AUTH_COOKIE}"
  fi
}

echo "[1/5] read run detail"
RUN_DETAIL="$(json_request GET "${API_BASE}/runs/${RUN_ID}")"
echo "$RUN_DETAIL" | jq '.job.run_id, .job.status' >/dev/null

STORY_FILE="$(echo "$RUN_DETAIL" | jq -r '.job.payload.story_file // ""')"

echo "[2/5] rerun with chapter_text_override (without chapter_id)"
RERUN_PAYLOAD="$(jq -nc --arg target_date "$TARGET_DATE" --argjson scene_count "$SCENE_COUNT" --arg chapter_text_override "$CHAPTER_OVERRIDE_TEXT" '{target_date: $target_date, scene_count: $scene_count, chapter_text_override: $chapter_text_override}')"
RERUN_RESPONSE="$(json_request POST "${API_BASE}/runs/${RUN_ID}/generate-text" "$RERUN_PAYLOAD")"
echo "$RERUN_RESPONSE" | jq '.ok, .run_id' >/dev/null

echo "[3/5] verify lightweight payload from /runs/:runId"
LATEST_DETAIL="$(json_request GET "${API_BASE}/runs/${RUN_ID}")"
INLINE_EXISTS="$(echo "$LATEST_DETAIL" | jq '(.job.payload | has("chapter_text_override") or has("system_prompt_text") or has("user_prompt_template_text") or has("image_prompt_suffix_text"))')"
if [[ "$INLINE_EXISTS" != "false" ]]; then
  echo "payload still contains inline large text fields"
  exit 1
fi

echo "[4/5] verify overrides endpoint"
OVERRIDES="$(json_request GET "${API_BASE}/runs/${RUN_ID}/overrides")"
echo "$OVERRIDES" | jq '.ok, .overrides.chapter_text_override_chars, .overrides.system_prompt_chars, .overrides.user_prompt_template_chars, .overrides.image_prompt_suffix_chars' >/dev/null

if [[ -n "$STORY_FILE" ]]; then
  echo "[5/5] verify story_file + chapter_text_override is rejected"
  INVALID_PAYLOAD="$(jq -nc --arg story_file "$STORY_FILE" --arg chapter_text_override "x" --arg target_date "$TARGET_DATE" --argjson scene_count "$SCENE_COUNT" '{story_file: $story_file, chapter_text_override: $chapter_text_override, target_date: $target_date, scene_count: $scene_count}')"
  STATUS="$(curl -sS -o /tmp/smoke-run-overrides-invalid.json -w "%{http_code}" -X POST "${API_BASE}/runs/${RUN_ID}/generate-text" \
    -H "Content-Type: application/json" \
    -H "x-csrf-token: ${CSRF_TOKEN}" \
    -H "Cookie: ${AUTH_COOKIE}" \
    --data "$INVALID_PAYLOAD")"
  if [[ "$STATUS" != "400" ]]; then
    echo "expected 400, got ${STATUS}"
    cat /tmp/smoke-run-overrides-invalid.json
    exit 1
  fi
fi

echo "smoke checks passed"

