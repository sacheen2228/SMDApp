#!/bin/bash
# Morning Trade Scan — runs daily at 9:05 AM IST
# Cron: 5 9 * * 1-5 /home/sachin/Desktop/SMDApp/scripts/morning-scan.sh

cd /home/sachin/Desktop/SMDApp

echo "[$(date)] Starting morning scan..."

# Run the scan via API
RESULT=$(curl -s --max-time 120 http://localhost:3000/api/morning-scan 2>&1)

echo "[$(date)] Scan result: $RESULT"
echo "$RESULT" >> /tmp/morning-scan.log
