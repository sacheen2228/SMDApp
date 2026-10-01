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
// Alerts/digests must only go out during market hours.
// 09:10–15:30 IST Mon–Fri so TIGER (polls until 15:30) can still deliver
// TP/SL hits in the last 10 minutes. Override with TELEGRAM_ALLOW_OFFHOURS=1.
const SEND_OPEN_HOUR = 9, SEND_OPEN_MIN = 10;
const SEND_CLOSE_HOUR = 15, SEND_CLOSE_MIN = 30;

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

/** Milliseconds until the next send window opens (0 if already open). */
export function msUntilTelegramSendWindow(date: Date = new Date()): number {
  if (isTelegramSendWindow(date)) return 0;
  const ist = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const day = ist.getDay();
  const minutesNow = ist.getHours() * 60 + ist.getMinutes();
  const openMinutes = SEND_OPEN_HOUR * 60 + SEND_OPEN_MIN;

  // Same weekday, before open today → wait until open
  if (day !== 0 && day !== 6 && minutesNow < openMinutes) {
    const waitMin = openMinutes - minutesNow;
    return waitMin * 60_000;
  }
  // After close / weekend → next weekday 09:10 IST
  const next = new Date(date);
  next.setMinutes(0, 0, 0);
  next.setHours(SEND_OPEN_HOUR, SEND_OPEN_MIN, 0, 0);
  // Advance to next open day (local IST-ish via same calendar day math)
  let addDays = 1;
  if (day === 5) addDays = 3; // Fri → Mon
  else if (day === 6) addDays = 2; // Sat → Mon
  else if (day === 0) addDays = 1;
  else if (minutesNow >= openMinutes) addDays = 1;
  else addDays = 0;
  next.setDate(next.getDate() + addDays);
  // If we landed on weekend, push to Monday
  while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
  const delta = next.getTime() - date.getTime();
  return Math.max(0, delta);
}
