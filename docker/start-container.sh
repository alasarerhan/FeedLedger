#!/bin/sh
set -eu

MAMMOTH_DATA_DIR="${MAMMOTH_DATA_DIR:-/data/mammoth}"
MAMMOTH_PORT="${MAMMOTH_PORT:-27017}"

mkdir -p "${MAMMOTH_DATA_DIR}" /app/data /app/logs

echo "[entrypoint] starting mammoth on port ${MAMMOTH_PORT}"
mammoth serve --data-dir "${MAMMOTH_DATA_DIR}" --port "${MAMMOTH_PORT}" &
MAMMOTH_PID=$!

for _ in $(seq 1 30); do
  if nc -z 127.0.0.1 "${MAMMOTH_PORT}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

shutdown() {
  kill "${APP_PID:-0}" 2>/dev/null || true
  kill "${MAMMOTH_PID:-0}" 2>/dev/null || true
}

trap shutdown INT TERM

if [ -n "${NEWSCRUX_LANG:-}" ]; then
  node /app/dist/index.js --lang="${NEWSCRUX_LANG}" &
else
  node /app/dist/index.js &
fi
APP_PID=$!

wait "${APP_PID}"
APP_STATUS=$?
kill "${MAMMOTH_PID}" 2>/dev/null || true
wait "${MAMMOTH_PID}" 2>/dev/null || true
exit "${APP_STATUS}"
