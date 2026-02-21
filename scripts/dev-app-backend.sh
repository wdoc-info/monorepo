#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/app.wdoc.info"
BACKEND_DIR="$ROOT_DIR/backend.wdoc.info"

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required but was not found."
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun is required but was not found."
  exit 1
fi

if [ ! -d "$APP_DIR" ]; then
  echo "Error: app directory not found at $APP_DIR"
  exit 1
fi

if [ ! -d "$BACKEND_DIR" ]; then
  echo "Error: backend directory not found at $BACKEND_DIR"
  exit 1
fi

APP_PID=""
BACKEND_PID=""

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "Stopping running services..."

  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" 2>/dev/null || true
  fi

  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi

  wait "$APP_PID" "$BACKEND_PID" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

echo "Starting backend (bun run dev)..."
(
  cd "$BACKEND_DIR"
  bun run dev
) &
BACKEND_PID=$!

echo "Starting frontend (npm start)..."
(
  cd "$APP_DIR"
  npm start
) &
APP_PID=$!

echo "Frontend PID: $APP_PID"
echo "Backend PID:  $BACKEND_PID"
echo "Press Ctrl+C to stop both services."

while true; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "Frontend process exited."
    break
  fi

  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "Backend process exited."
    break
  fi

  sleep 1
done
