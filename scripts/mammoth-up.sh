#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$ROOT_DIR/vendor/mammoth"

mkdir -p "$ROOT_DIR/vendor"

if [[ ! -d "$VENDOR_DIR/.git" ]]; then
  echo "[mammoth] Cloning Mammoth source into $VENDOR_DIR"
  git clone --depth 1 https://github.com/MammothEngine/mammoth.git "$VENDOR_DIR"
else
  echo "[mammoth] Existing source found at $VENDOR_DIR (skip clone)"
fi

echo "[mammoth] Building and starting container"
docker compose -p feedledger-mammoth -f "$ROOT_DIR/docker-compose.mammoth.yml" build mammoth
docker compose -p feedledger-mammoth -f "$ROOT_DIR/docker-compose.mammoth.yml" up -d mammoth
docker compose -p feedledger-mammoth -f "$ROOT_DIR/docker-compose.mammoth.yml" ps
