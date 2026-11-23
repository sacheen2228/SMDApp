#!/usr/bin/env bash
# SMDApp Market Recorder tick — invoked by systemd timer every market minute.
# - flock-guarded so overlapping ticks cannot run concurrently.
# - Skips outside Mon-Fri 09:15-15:30 IST (Breeze returns nothing useful off-hours).
# - Calls the recorder API with {"auto":true}; the app applies the configured
#   per-mode interval (RECORDER_INTERVAL_*) and MANUAL-mode skip.
#
# P0 (2026-11-19): the curl now carries a HARD TIMEOUT. Without it a hung
# recorder POST kept this script alive for 10+ hours holding the flock, so
# every later tick exited immediately (`flock -n 9 || exit 0`) and the
# recorder silently stopped for the rest of the session (18-Nov: captures
# ended at 11:10 IST). The app route itself is now capped too — this timeout
# is the outer belt to that inner guard.
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
# --connect-timeout: TCP connect only. --max-time: the whole request
# (connect + transfer). A tick may never outlive its minute.
curl -s -o /dev/null -w "recorder tick http=%{http_code} time=%{time_total}s\n" \
  --connect-timeout 5 --max-time 55 \
  -X POST "$BASE/api/market-recorder/record" \
  -H "Content-Type: application/json" \
  -d '{"auto":true}' || true
exit 0
