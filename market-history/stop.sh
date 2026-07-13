#!/usr/bin/env bash
# Stop the Market History engine sidecar.
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
  echo "No PID file — is the engine running? Try: pkill -f 'ts-node-dev src/server.ts'"
fi
