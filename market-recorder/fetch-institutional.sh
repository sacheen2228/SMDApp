#!/usr/bin/env bash
# SMDApp Institutional Positioning daily fetch — invoked by systemd timer at 4:30 PM IST.
# Fetches NSE Participant OI data for next-day trading decisions.
set -u
LOCK="/tmp/smdapp-institutional.lock"
exec 9>"$LOCK"
flock -n 9 || exit 0

BASE="${INSTITUTIONAL_BASE:-http://localhost:3000}"
SECRET="sdm-cron-9f3a2b"

curl -s -o /dev/null -w "institutional fetch http=%{http_code}\n" \
  "$BASE/api/cron/institutional-positioning?secret=$SECRET" || true
exit 0
