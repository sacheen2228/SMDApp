#!/usr/bin/env bash
# Stop the local Piper TTS sidecar.
PIDFILE=/tmp/smdapp-voice/piper-sidecar.pid
if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  kill "$PID" 2>/dev/null && echo "[voice] stopped piper sidecar (pid $PID)" || echo "[voice] pid not running"
  rm -f "$PIDFILE"
else
  pkill -f "piper.http_server" 2>/dev/null && echo "[voice] stopped piper sidecar" || echo "[voice] no sidecar running"
fi
