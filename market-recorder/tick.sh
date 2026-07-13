#!/usr/bin/env bash
# SMDApp Market Recorder tick — invoked by systemd timer every market minute.
# - flock-guarded so overlapping ticks cannot run concurrently.
# - Skips outside Mon-Fri 09:15-15:30 IST (Breeze returns nothing useful off-hours).
# - Calls the recorder API with {"auto":true}; the app applies the configured
#   per-mode interval (RECORDER_INTERVAL_*) and MANUAL-mode skip.
set -u
LOCK="/tmp/smdapp-recorder.lock"
exec 9>"$LOCK"
flock -n 9 || exit 0

NOW=$(TZ=Asia/Kolkata date +%u,%H,%M)
DOW=${NOW%%,*}; REST=${NOW#*,}; HH=${REST%%,*}; MM=${REST##*,}
if [ "$DOW" -lt 1 ] || [ "$DOW" -gt 5 ]; then exit 0; fi
if [ "$HH" -lt 9 ] || [ "$HH" -gt 15 ]; then exit 0; fi
if [ "$HH" -eq 9 ] && [ "$MM" -lt 15 ]; then exit 0; fi
if [ "$HH" -eq 15 ] && [ "$MM" -gt 30 ]; then exit 0; fi

BASE="${MARKET_RECORDER_BASE:-http://localhost:3000}"
curl -s -o /dev/null -w "recorder tick http=%{http_code}\n" \
  -X POST "$BASE/api/market-recorder/record" \
  -H "Content-Type: application/json" \
  -d '{"auto":true}' || true
exit 0
