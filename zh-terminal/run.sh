#!/usr/bin/env bash
# Zero Hero Live Terminal — start with waitress (production WSGI)
# Usage: ./run.sh
#
# Ensure SMDApp dev server is running on :3000 first.

cd "$(dirname "$0")"

FLASK_PORT="${FLASK_PORT:-5000}"
SMDAPP_BASE="${SMDAPP_BASE:-http://localhost:3000}"

echo "[zh-terminal] proxying SMDApp at $SMDAPP_BASE"
echo "[zh-terminal] listening on http://localhost:$FLASK_PORT"

exec python3 -m waitress \
  --host=0.0.0.0 \
  --port="$FLASK_PORT" \
  --threads=4 \
  app:app
