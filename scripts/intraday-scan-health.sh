#!/usr/bin/env bash
#
# Cron health wrapper for /api/intraday-scan.
#
# Replaces the raw `curl` in smdapp-intraday-scan.service:
#   1. calls the scan endpoint locally (auth via x-cron-secret header),
#   2. on HTTP 200            -> exit 0 (and send a one-time "recovered" note
#                                if the previous run failed),
#   3. on non-200 / transport  -> send a Telegram alert (throttled to one per
#      failure / timeout         30 min) and exit non-zero so systemd records
#                                the failure.
#
# Secrets are read from .env on disk (the systemd user manager does NOT expand
# $DAILY_SCAN_SECRET in ExecStart, which is why the old unit silently sent an
# empty header and got 401).
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/.env"
BASE_URL="${SMDAPP_BASE_URL:-http://localhost:3000}"
STATE_DIR="${SMDAPP_STATE_DIR:-/tmp/smdapp-health}"
STATE_FILE="${STATE_DIR}/intraday-scan.state"
THROTTLE_SECS=1800
SCAN_MAX_TIME=115   # scan's internal budget is 100s; allow margin

# Read a single KEY=value (or `export KEY=value`) from .env without sourcing it
# and without ever printing the value.
load_env() {
  local key="$1" line val
  [ -n "${!key:-}" ] && return 0
  [ -f "$ENV_FILE" ] || return 0
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE" | tail -1) || return 0
  [ -z "$line" ] && return 0
  val="${line#*=}"
  val="${val%$'\r'}"
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  printf -v "$key" '%s' "$val"
  export "$key"
}

load_env TELEGRAM_BOT_TOKEN
load_env TELEGRAM_CHAT_ID
load_env DAILY_SCAN_SECRET
load_env TELEGRAM_DIGEST_CHAT_IDS

# Fall back to the first digest chat if the primary chat id is not configured.
if [ -z "${TELEGRAM_CHAT_ID:-}" ] && [ -n "${TELEGRAM_DIGEST_CHAT_IDS:-}" ]; then
  TELEGRAM_CHAT_ID="${TELEGRAM_DIGEST_CHAT_IDS%%,*}"
fi

# Telegram sends bypass the app's 09:10-15:30 send-window on purpose: a cron
# failure after hours is exactly when you want to hear about it.
send_telegram() {
  local text="$1"
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] || return 0
  curl -sS --max-time 15 -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${text}" >/dev/null 2>&1 || true
}

mkdir -p "$STATE_DIR" 2>/dev/null || true

now=$(date +%s)
last_status="ok"
last_alert=0
if [ -f "$STATE_FILE" ]; then
  read -r last_status last_alert < "$STATE_FILE" 2>/dev/null || true
  [ -z "${last_alert:-}" ] && last_alert=0
fi

TMP_BODY="$(mktemp)"
TMP_ERR="$(mktemp)"
trap 'rm -f "$TMP_BODY" "$TMP_ERR"' EXIT

http_code=$(curl -sS -o "$TMP_BODY" -w '%{http_code}' \
  --max-time "$SCAN_MAX_TIME" \
  -H "x-cron-secret: ${DAILY_SCAN_SECRET:-}" \
  "${BASE_URL}/api/intraday-scan" 2>"$TMP_ERR")
curl_rc=$?

body="$(head -c 400 "$TMP_BODY" 2>/dev/null | tr '\n' ' ')"
err="$(head -c 200 "$TMP_ERR" 2>/dev/null | tr '\n' ' ')"

if [ "$curl_rc" -eq 0 ] && [ "$http_code" = "200" ]; then
  if [ "$last_status" = "fail" ]; then
    send_telegram "✅ SMDApp intraday scan recovered — HTTP 200 at $(date -Is)."
  fi
  echo "$(date -Is) OK http=200 body=${body}"
  printf 'ok 0\n' > "$STATE_FILE"
  exit 0
fi

echo "$(date -Is) FAIL http=${http_code:-none} curl_rc=${curl_rc} err=${err} body=${body}" >&2

if [ "$last_status" != "fail" ] || [ $((now - last_alert)) -ge "$THROTTLE_SECS" ]; then
  send_telegram "🚨 SMDApp intraday scan FAILED
http=${http_code:-none} curl_rc=${curl_rc}
$(date -Is)
${err:+err: $err}
${body:+body: $body}

Check ${BASE_URL}/api/health and Next.js logs (/tmp/smdapp.log)."
  last_alert=$now
fi

printf 'fail %s\n' "$last_alert" > "$STATE_FILE"
exit 1
