#!/usr/bin/env bash
# Generic locked job runner for the nse-options-signal scheduled jobs.
#
#   cron_job.sh --name <job> [--timeout <seconds>] [--retries <n>] \
#               [--delay <seconds>] [--trading-day-only] [--log <file>] \
#               [--lock-dir <dir>] -- <command...>
#
# Guarantees:
#   * one instance per job at a time (flock, non-blocking: a second run skips)
#   * a hard timeout per attempt (bounded retries, bounded total runtime)
#   * a structured JSON log line per attempt (status, exit code, duration)
#   * a non-zero exit code when the job failed - a job is NEVER "successful"
#     just because the process exited
#   * trading-day awareness (weekends + the NSE holiday list)
#
# Exit codes: 0 = the job succeeded (or was skipped for a documented reason),
#              1 = the job failed after every attempt,
#              2 = the usage is wrong.
set -uo pipefail

NAME=""; TIMEOUT=300; RETRIES=1; DELAY=30; TRADING_DAY_ONLY=0; LOG=""; LOCK_DIR=""
CMD=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --retries) RETRIES="$2"; shift 2 ;;
    --delay) DELAY="$2"; shift 2 ;;
    --log) LOG="$2"; shift 2 ;;
    --lock-dir) LOCK_DIR="$2"; shift 2 ;;
    --trading-day-only) TRADING_DAY_ONLY=1; shift ;;
    --) shift; CMD=("$@"); break ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$NAME" || ${#CMD[@]} -eq 0 ]]; then
  echo "usage: cron_job.sh --name <job> [options] -- <command...>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="${GEX_DATA_DIR:-$SKILL_DIR/data}"
LOCK_DIR="${LOCK_DIR:-$DATA_DIR/locks}"
LOG="${LOG:-$DATA_DIR/logs/cron.log}"
mkdir -p "$LOCK_DIR" "$(dirname "$LOG")"

log_line() {
  # $1 status, $2 exit code, $3 duration ms, $4 detail
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"ts":"%s","job":"%s","status":"%s","exit_code":%s,"duration_ms":%s,"detail":"%s"}\n' \
    "$ts" "$NAME" "$1" "$2" "$3" "${4//\"/\'}" >> "$LOG"
}

# ---- trading day gate
if [[ "$TRADING_DAY_ONLY" == "1" ]]; then
  if ! python3 "$SCRIPT_DIR/trading_day.py" --quiet; then
    log_line "skipped_non_trading_day" 0 0 "not an NSE trading day"
    echo "[$NAME] skipped: not an NSE trading day"
    exit 0
  fi
fi

# ---- lock (one instance per job)
LOCK_FILE="$LOCK_DIR/$NAME.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log_line "skipped_locked" 0 0 "another instance is running"
  echo "[$NAME] skipped: already running"
  exit 0
fi

# ---- run (bounded retries, hard timeout per attempt)
attempt=0
start_ms=$(date +%s%3N)
while [[ $attempt -lt $RETRIES ]]; do
  attempt=$((attempt + 1))
  t0=$(date +%s%3N)
  if timeout --signal=TERM --kill-after=10 "$TIMEOUT" "${CMD[@]}"; then
    code=0
  else
    code=$?
  fi
  t1=$(date +%s%3N)
  dur=$((t1 - t0))
  if [[ $code -eq 0 ]]; then
    log_line "ok" 0 "$dur" "attempt $attempt"
    echo "[$NAME] ok (attempt $attempt, ${dur}ms)"
    exit 0
  fi
  if [[ $code -eq 124 || $code -eq 137 ]]; then
    detail="timeout after ${TIMEOUT}s"
  else
    detail="exit code $code"
  fi
  log_line "failed" "$code" "$dur" "$detail (attempt $attempt)"
  echo "[$NAME] failed: $detail (attempt $attempt)" >&2
  if [[ $attempt -lt $RETRIES ]]; then
    sleep "$DELAY"
  fi
done

end_ms=$(date +%s%3N)
log_line "failed_final" 1 "$((end_ms - start_ms))" "no attempt succeeded"
echo "[$NAME] FAILED after $attempt attempt(s)" >&2
exit 1
