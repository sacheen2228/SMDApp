#!/bin/sh
# SMDApp container entrypoint — starts the 3 processes:
#   1. trade-audit sidecar   (:4001)
#   2. market-history sidecar(:4002)
#   3. Next.js app           (:3000)
# Each gets its own PORT so the sidecars never collide with the web app.

set -e

echo "[entrypoint] Starting trade-audit on :4001 ..."
PORT=4001 DB_PATH=/data/trade_audit.db \
  node /app/trade-audit/dist/server.js > /app/trade-audit/data/engine.log 2>&1 &
TA_PID=$!

echo "[entrypoint] Starting market-history on :4002 ..."
MARKET_HISTORY_PORT=4002 MARKET_HISTORY_DB=/data/market_history.db \
  node /app/market-history/dist/server.js > /app/market-history/data/engine.log 2>&1 &
MH_PID=$!

# Give sidecars a moment to bind + create schemas before Next.js calls them.
sleep 3

echo "[entrypoint] Starting Next.js on :3000 ..."
PORT=3000 HOSTNAME=0.0.0.0 node /app/server.js > /app/server.log 2>&1 &
NEXT_PID=$!

# Simple supervisor: if the web server dies, take the container down so
# Render restarts it.
wait $NEXT_PID
echo "[entrypoint] Next.js exited (code $?). Shutting down sidecars."
kill $TA_PID $MH_PID 2>/dev/null || true
exit 1