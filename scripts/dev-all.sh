#!/usr/bin/env bash
set -euo pipefail

npm --prefix backend install
npm --prefix web install

npm --prefix backend run dev &
BACKEND_PID=$!

npm --prefix web run dev &
WEB_PID=$!

cleanup() {
  kill "$BACKEND_PID" "$WEB_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

wait
