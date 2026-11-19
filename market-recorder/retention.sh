#!/usr/bin/env bash
# SMDApp market-history retention job — disk-space maintenance.
#
#   ./retention.sh daily    → rolling 30-day cap (delete rows older than 30 days)
#   ./retention.sh monthly  → month reset (delete everything before the month
#                              boundary; the new month starts clean)
#   ./retention.sh dry-run  → report only, deletes nothing
#
# The sidecar owns the policy and every safeguard (archive → verify → rollup →
# batched delete → VACUUM → integrity check). This script only makes sure the
# sidecar is up and calls it with a HARD TIMEOUT, so the job can never hang.
set -u
MODE="${1:-dry-run}"
LOCK="/tmp/smdapp-retention.lock"
exec 9>"$LOCK"
flock -n 9 || exit 0

BASE="${MARKET_HISTORY_BASE:-http://localhost:4002}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! curl -s -o /dev/null --connect-timeout 3 --max-time 5 "$BASE/health"; then
  echo "retention: sidecar down — starting it"
  (cd "$ROOT/market-history" && ./start.sh) || true
  for _ in $(seq 1 30); do
    curl -s -o /dev/null --connect-timeout 3 --max-time 5 "$BASE/health" && break
    sleep 2
  done
fi

if ! curl -s -o /dev/null --connect-timeout 3 --max-time 5 "$BASE/health"; then
  echo "retention: sidecar still down — skipping $MODE"
  exit 0
fi

curl -s --connect-timeout 5 --max-time 1800 \
  -X POST "$BASE/api/maintenance/retention" \
  -H "Content-Type: application/json" \
  -d "{\"mode\":\"$MODE\"}" \
  -w "\nretention http=%{http_code} time=%{time_total}s\n" || true
exit 0
