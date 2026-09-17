#!/bin/bash
# Auto-sets Telegram webhook AND notifies when tunnel URL changes
# Runs every 30 seconds

LAST_URL=""
TOKEN=$(grep TELEGRAM_BOT_TOKEN /home/sachin/Desktop/SMDApp/.env | cut -d= -f2)
CHAT_ID=$(grep TELEGRAM_CHAT_ID /home/sachin/Desktop/SMDApp/.env | cut -d= -f2)

send_notification() {
  local url="$1"
  curl -s --max-time 10 "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\":\"${CHAT_ID}\",\"text\":\"🔗 New dashboard URL:\\n\\n${url}\\n\\nBookmark this link for office access.\",\"parse_mode\":\"HTML\"}" > /dev/null 2>&1
}

while true; do
  CURRENT_URL=$(grep -oP "https://[a-z0-9-]+\.trycloudflare\.com" /tmp/smdapp-tunnel.log 2>/dev/null | tail -1)
  
  if [ -n "$CURRENT_URL" ] && [ "$CURRENT_URL" != "$LAST_URL" ]; then
    # Set webhook
    RESULT=$(curl -s --max-time 10 "https://api.telegram.org/bot${TOKEN}/setWebhook?url=${CURRENT_URL}/api/telegram/webhook")
    OK=$(echo $RESULT | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',False))" 2>/dev/null)
    
    if [ "$OK" = "True" ]; then
      echo "$(date): Webhook set: ${CURRENT_URL}" >> /tmp/webhook-updater.log
    else
      echo "$(date): Webhook failed (DNS not resolved yet)" >> /tmp/webhook-updater.log
    fi
    
    # Notify user about new URL (only if URL actually changed)
    if [ -n "$LAST_URL" ] && [ "$LAST_URL" != "$CURRENT_URL" ]; then
      send_notification "$CURRENT_URL"
      echo "$(date): Notified user: ${CURRENT_URL}" >> /tmp/webhook-updater.log
    fi
    
    LAST_URL="$CURRENT_URL"
  fi
  
  sleep 30
done
