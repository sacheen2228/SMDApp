#!/usr/bin/env bash
# Start the local Piper TTS sidecar (keeps the voice model resident → ~3-4s synth).
# Voice degrades to one-shot CLI if this is not running (slower, still works).
set -euo pipefail
cd "$(dirname "$0")/.."
MODEL="${VOICE_MODEL:-en_US-ryan-medium}"
PORT="${VOICE_PIPER_PORT:-5000}"
if curl -sf -o /dev/null --max-time 1 "http://127.0.0.1:${PORT}/" 2>/dev/null; then
  echo "[voice] piper sidecar already running on :${PORT}"
  exit 0
fi
mkdir -p /tmp/smdapp-voice
nohup python3 -m piper.http_server \
  -m "${MODEL}" \
  --data-dir "${VOICE_MODEL_DIR:-$PWD/voices}" \
  --host 127.0.0.1 --port "${PORT}" \
  > /tmp/smdapp-voice/piper-sidecar.log 2>&1 &
echo $! > /tmp/smdapp-voice/piper-sidecar.pid
sleep 2
echo "[voice] piper sidecar started (pid $(cat /tmp/smdapp-voice/piper-sidecar.pid)) on :${PORT}"
