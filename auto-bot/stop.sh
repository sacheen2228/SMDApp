#!/bin/sh
if [ -f /tmp/auto-bot.pid ]; then
  PID=$(cat /tmp/auto-bot.pid)
  if kill -0 "$PID" 2>/dev/null; then
    echo "[auto-bot] Stopping (PID $PID)..."
    kill -TERM "$PID"
    sleep 1
    if kill -0 "$PID" 2>/dev/null; then
      kill -KILL "$PID"
    fi
  else
    echo "[auto-bot] Process $PID not running"
  fi
  rm -f /tmp/auto-bot.pid
else
  echo "[auto-bot] No PID file found"
fi
