#!/usr/bin/env bash
set -euo pipefail

USER_ID="${1:-admin}"
REPORT_DATE="${2:-$(TZ=Europe/Istanbul date +%F)}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
STATE_FILE="$DATA_DIR/daily-state.json"
INDEX_FILE="$DATA_DIR/report-index.json"
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$DATA_DIR"

if [[ -f "$STATE_FILE" ]]; then
  cp "$STATE_FILE" "$STATE_FILE.bak.$TS"
fi
if [[ -f "$INDEX_FILE" ]]; then
  cp "$INDEX_FILE" "$INDEX_FILE.bak.$TS"
fi

node --input-type=module - "$STATE_FILE" "$INDEX_FILE" "$USER_ID" "$REPORT_DATE" <<'NODE'
import fs from 'node:fs';

const [stateFile, indexFile, userId, reportDate] = process.argv.slice(2);

function readJson(path, fallback) {
  try {
    if (!fs.existsSync(path)) return fallback;
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

const state = readJson(stateFile, { version: 2, users: {} });
if (!state.users || typeof state.users !== 'object') state.users = {};
if (!state.users[userId] || typeof state.users[userId] !== 'object') {
  state.users[userId] = { reports: {} };
}
const userState = state.users[userId];
if (!userState.reports || typeof userState.reports !== 'object') {
  userState.reports = {};
}

let removedFromState = 0;
for (const [key, value] of Object.entries(userState.reports)) {
  const report = value && typeof value === 'object' ? value : {};
  const rd = typeof report.reportDate === 'string' ? report.reportDate : String(key).split(':')[0];
  if (rd === reportDate) {
    delete userState.reports[key];
    removedFromState += 1;
  }
}

delete userState.scanRetryDate;
delete userState.scanRetryAfterMs;
delete userState.lastScanRunDate;

fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

const index = readJson(indexFile, { version: 2, users: {} });
let removedFromIndex = 0;

if (index && typeof index === 'object' && index.version === 2 && index.users && typeof index.users === 'object') {
  const current = Array.isArray(index.users[userId]) ? index.users[userId] : [];
  const kept = current.filter((item) => {
    const match = item && typeof item === 'object' && item.reportDate === reportDate;
    if (match) removedFromIndex += 1;
    return !match;
  });
  index.users[userId] = kept;
} else if (index && typeof index === 'object' && Array.isArray(index.reports)) {
  const before = index.reports.length;
  index.reports = index.reports.filter((item) => !(item && item.userId === userId && item.reportDate === reportDate));
  removedFromIndex = before - index.reports.length;
}

fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

console.log(`user=${userId}`);
console.log(`reportDate=${reportDate}`);
console.log(`removedFromState=${removedFromState}`);
console.log(`removedFromIndex=${removedFromIndex}`);
NODE

echo "Restarting scheduler service (feedledger unit)..."
systemctl --user restart feedledger
systemctl --user status feedledger --no-pager -n 20

echo
echo "Done. If current time is after scan time, catch-up scan will run immediately."
echo "User: $USER_ID | Report date: $REPORT_DATE"
