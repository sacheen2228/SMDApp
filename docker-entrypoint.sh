#!/bin/sh
# Runs live-data-service (127.0.0.1:8765) alongside Next.js so the agent
# feed-gate and Hermes live-feed check work inside the Render container.
# If the sidecar dies the web app stays up — the gate then honestly reports
# the service unreachable instead of crashing the container.
set -e

python3 /app/live-data-service/live_service.py &

exec node server.js
