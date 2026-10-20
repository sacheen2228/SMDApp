#!/usr/bin/env bash
# Live refresh: the NSE snapshot + the live breadth / movers feeds.
#
#   * scripts/nse_fetch.py   -> data/live/snapshot.json  (+ the history archive)
#   * scripts/eod_fetch.py --live -> data/live/<date>/*.json (indices, movers)
#
# One NSE fetch per run: the snapshot and the live feeds share it.  The
# scheduler (src/lib/orchestrator/skill-jobs.ts) runs this every 5 minutes
# between 09:00 and 14:55 IST on trading days.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="${GEX_DATA_DIR:-$SKILL_DIR/data}"
LIVE_DIR="$DATA_DIR/live"
HISTORY_DIR="$LIVE_DIR/history"
SYMBOL="${GEX_SYMBOL:-NIFTY}"
KEEP_SNAPSHOTS="${GEX_KEEP_SNAPSHOTS:-60}"

mkdir -p "$HISTORY_DIR"

# 1) the snapshot (the source of truth for the chain, the candles and the VIX)
if ! python3 "$SCRIPT_DIR/nse_fetch.py" --symbol "$SYMBOL" --out "$LIVE_DIR/snapshot.json"; then
  echo "live_fetch: the NSE snapshot failed" >&2
  exit 1
fi

# 2) archive it for the history (the GEX engine needs >= 3 snapshots)
STAMP="$(date +%Y%m%d_%H%M%S)"
cp "$LIVE_DIR/snapshot.json" "$HISTORY_DIR/snap_${STAMP}.json"

# 3) keep the history bounded
ls -1t "$HISTORY_DIR"/snap_*.json 2>/dev/null | tail -n +"$((KEEP_SNAPSHOTS + 1))" | \
  while read -r old; do rm -f "$old"; done

# 4) the live breadth / movers feeds (independent of the snapshot)
python3 "$SCRIPT_DIR/eod_fetch.py" --live
