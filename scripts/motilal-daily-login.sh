#!/bin/bash
# Motilal daily re-login — runs before 6 AM expiry
# Add to crontab: 55 5 * * * /home/sachin/Desktop/SMDApp/scripts/motilal-daily-login.sh

cd /home/sachin/Desktop/SMDApp

# Trigger auto-login via API
curl -s -X POST http://localhost:3000/api/motilal \
  -H "Content-Type: application/json" \
  -d '{"action":"login","userid":"ETHN366887","password":"Sachin@09","dob":"28/03/1985"}' \
  > /tmp/motilal-login-result.json 2>&1

echo "[$(date)] Motilal daily login completed"
cat /tmp/motilal-login-result.json
