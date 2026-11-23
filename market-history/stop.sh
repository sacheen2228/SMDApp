#!/usr/bin/env bash
# Stop the Market History engine sidecar.
#
# The PID file alone is not enough: ts-node-dev spawns a child process, and a
# stale PID file (or a reload that left an orphan child) leaves an OLD build
# serving :4002 — which silently hides newly added routes. So the script also
# sweeps every process started from this directory's node_modules.
cd "$(dirname "$0")"
if [ -f data/engine.pid ]; then
  PID=$(cat data/engine.pid)
  if kill "$PID" 2>/dev/null; then
    echo "Stopped Market History engine (PID $PID)."
  else
    echo "Process $PID not running."
  fi
  rm -f data/engine.pid
else
  echo "No PID file — sweeping by process pattern."
fi

# Sweep any orphan ts-node-dev / node process of THIS sidecar (never touches
# the trade-audit sidecar, which lives in a different directory).
for p in $(pgrep -f "$(pwd)/node_modules" 2>/dev/null); do
  if [ "$p" != "$$" ]; then
    kill -9 "$p" 2>/dev/null && echo "Killed orphan process $p."
  fi
done

sleep 1
if ss -ltn 2>/dev/null | grep -q ':4002 '; then
  echo "WARNING: port 4002 is still bound — an old build may still be serving."
else
  echo "Port 4002 is free."
fi
