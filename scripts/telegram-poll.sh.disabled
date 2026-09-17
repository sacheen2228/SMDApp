#!/bin/bash
# Start continuous Telegram polling in background
# Polls every 30 seconds for new messages
while true; do
  curl -s "http://localhost:3000/api/telegram/poll" > /dev/null 2>&1
  sleep 30
done
