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
