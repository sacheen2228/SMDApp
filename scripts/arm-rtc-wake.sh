#!/bin/bash
# Arm the RTC to wake the machine for the next weekday 08:00 IST.
# Why: the box powers off overnight (~01:42) and boots too late for the
# 08:50/09:02/09:10 pre-market jobs. RTC wake boots it before those windows.
#
# Run as root (systemd system timer). Safe to re-run — clears then sets alarm.
set -euo pipefail

TARGET_EPOCH=$(python3 - <<'PY'
from datetime import datetime, timedelta, timezone
import sys
IST = timezone(timedelta(hours=5, minutes=30))
now = datetime.now(IST)
cand = now.replace(hour=8, minute=0, second=0, microsecond=0)
if cand <= now:
    cand += timedelta(days=1)
while cand.weekday() >= 5:  # skip Sat/Sun
    cand += timedelta(days=1)
print(int(cand.timestamp()))
print(cand.isoformat(), file=sys.stderr)
PY
)

# rtcwake -m no: set alarm only, do not suspend (machine may stay up).
# If already armed for the same time this is a no-op rewrite.
rtcwake -m no -t "$TARGET_EPOCH"
echo "RTC wake armed for epoch ${TARGET_EPOCH} ($(date -d "@${TARGET_EPOCH}" '+%Y-%m-%d %H:%M %Z' 2>/dev/null || date -r "${TARGET_EPOCH}" '+%Y-%m-%d %H:%M %Z'))"
