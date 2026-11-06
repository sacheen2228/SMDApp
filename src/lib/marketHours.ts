// lib/marketHours.ts
//
// IST market-hours guard. All date math is done in IST derived from epoch ms
// (IST = UTC+5:30, no DST), never via server-local setHours or toLocaleString.
// This makes behaviour identical regardless of the server's timezone.

// IST offset from UTC: +5:30 = 19800000 ms
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/** NSE trading holidays (YYYY-MM-DD). Read from NSE_HOLIDAYS env var
 *  (comma-separated); never hardcoded — do not invent dates. */
export function getNSEHolidays(): string[] {
  const raw = process.env.NSE_HOLIDAYS || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Exported snapshot of NSE holidays (evaluated at module load). */
export const NSE_HOLIDAYS: string[] = getNSEHolidays();

/** Convert epoch ms to IST date components using UTC methods on the
 *  offset-adjusted timestamp. Returns { year, month, day, weekday, hour, minute }
 *  where weekday: 0=Sunday, 6=Saturday. */
function istPartsFromEpoch(epochMs: number) {
  const istMs = epochMs + IST_OFFSET_MS;
  const d = new Date(istMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(), // 0-11
    day: d.getUTCDate(),
    weekday: d.getUTCDay(), // 0=Sunday, 6=Saturday
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

function istDateString(epochMs: number): string {
  const p = istPartsFromEpoch(epochMs);
  const m = String(p.month + 1).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${m}-${dd}`;
}

function isHoliday(epochMs: number): boolean {
  const ds = istDateString(epochMs);
  return getNSEHolidays().includes(ds);
}

function isWeekend(weekday: number): boolean {
  return weekday === 0 || weekday === 6;
}

export function isTradingDay(date: Date = new Date()): boolean {
  if (process.env.TELEGRAM_ALLOW_OFFHOURS === "1") return true;
  const p = istPartsFromEpoch(date.getTime());
  return !isWeekend(p.weekday) && !isHoliday(date.getTime());
}

const OPEN_HOUR = 9;
const OPEN_MIN = 15;
const CLOSE_HOUR = 15;
const CLOSE_MIN = 30;

const OPEN_MINUTES = OPEN_HOUR * 60 + OPEN_MIN; // 555
const CLOSE_MINUTES = CLOSE_HOUR * 60 + CLOSE_MIN; // 930

export function isMarketOpen(date: Date = new Date()): boolean {
  if (!isTradingDay(date)) return false;
  const p = istPartsFromEpoch(date.getTime());
  const minutesNow = p.hour * 60 + p.minute;
  return minutesNow >= OPEN_MINUTES && minutesNow <= CLOSE_MINUTES;
}

// ─── Telegram alert send window ───────────────────────────────
// Alerts/digests must only go out during market hours.
// 09:10–15:30 IST Mon–Fri so TIGER (polls until 15:30) can still deliver
// TP/SL hits in the last 10 minutes. Override with TELEGRAM_ALLOW_OFFHOURS=1.
const SEND_OPEN_HOUR = 9;
const SEND_OPEN_MIN = 10;
const SEND_CLOSE_HOUR = 15;
const SEND_CLOSE_MIN = 30;

const SEND_OPEN_MINUTES = SEND_OPEN_HOUR * 60 + SEND_OPEN_MIN; // 550
const SEND_CLOSE_MINUTES = SEND_CLOSE_HOUR * 60 + SEND_CLOSE_MIN; // 930

export function isTelegramSendWindow(date: Date = new Date()): boolean {
  if (process.env.TELEGRAM_ALLOW_OFFHOURS === "1") return true;
  if (!isTradingDay(date)) return false;
  const p = istPartsFromEpoch(date.getTime());
  const minutesNow = p.hour * 60 + p.minute;
  return minutesNow >= SEND_OPEN_MINUTES && minutesNow <= SEND_CLOSE_MINUTES;
}

/** Milliseconds until the next send window opens (0 if already open).
 *  Skips weekends and holidays. Looks ahead up to 21 days. */
export function msUntilTelegramSendWindow(date: Date = new Date()): number {
  if (isTelegramSendWindow(date)) return 0;

  const start = date.getTime();
  const maxLookahead = 21 * 24 * 60 * 60 * 1000; // 21 days

  // Check each minute from now until we find an open window
  // (step by minute for precision, capped at 21 days)
  const oneMinute = 60_000;
  const end = start + maxLookahead;
  for (let t = start + oneMinute; t <= end; t += oneMinute) {
    if (isTelegramSendWindow(new Date(t))) {
      return t - start;
    }
  }
  return maxLookahead;
}