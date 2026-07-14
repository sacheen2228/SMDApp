// lib/marketHours.ts
//
// Simple IST market-hours guard. Doesn't account for NSE holidays —
// add a holiday-date check here if you want to skip those too
// (a static list of this year's trading holidays is enough).

const OPEN_HOUR = 9, OPEN_MIN = 15;
const CLOSE_HOUR = 15, CLOSE_MIN = 30;

export function isMarketOpen(date: Date = new Date()): boolean {
  const ist = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const day = ist.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;

  const minutesNow = ist.getHours() * 60 + ist.getMinutes();
  const openMinutes = OPEN_HOUR * 60 + OPEN_MIN;
  const closeMinutes = CLOSE_HOUR * 60 + CLOSE_MIN;

  return minutesNow >= openMinutes && minutesNow <= closeMinutes;
}

// ─── Telegram alert send window ───────────────────────────────
// Alerts/digests must only go out during market hours:
// 09:10 - 15:20 IST, Monday-Friday. Anything outside this window
// (e.g. a mis-fired cron at 03:00) is suppressed so users are not
// pinged at night. Override with TELEGRAM_ALLOW_OFFHOURS=1 for tests.
const SEND_OPEN_HOUR = 9, SEND_OPEN_MIN = 10;
const SEND_CLOSE_HOUR = 15, SEND_CLOSE_MIN = 20;

export function isTelegramSendWindow(date: Date = new Date()): boolean {
  if (process.env.TELEGRAM_ALLOW_OFFHOURS === "1") return true;

  const ist = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const day = ist.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;

  const minutesNow = ist.getHours() * 60 + ist.getMinutes();
  const openMinutes = SEND_OPEN_HOUR * 60 + SEND_OPEN_MIN;
  const closeMinutes = SEND_CLOSE_HOUR * 60 + SEND_CLOSE_MIN;

  return minutesNow >= openMinutes && minutesNow <= closeMinutes;
}
