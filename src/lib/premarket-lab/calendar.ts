// Exchange calendar + timestamp helpers for the research engine.
// Wraps session-config Date-based APIs; never invents trading days.

import { isTradingDay as cfgIsTradingDay, isHoliday as cfgIsHoliday } from "@/lib/expiry-liquidity/market-session-config";

function toDate(dateISO: string): Date {
  return new Date(dateISO + "T12:00:00+05:30");
}

export function isTradingDay(dateISO: string): boolean {
  try {
    return cfgIsTradingDay(toDate(dateISO));
  } catch {
    const d = toDate(dateISO);
    const wd = d.getUTCDay();
    return wd !== 0 && wd !== 6;
  }
}

export function isHoliday(dateISO: string): boolean {
  try {
    return cfgIsHoliday(toDate(dateISO));
  } catch {
    return false;
  }
}

export function prevTradingDay(dateISO: string): string | null {
  const d = toDate(dateISO);
  for (let i = 1; i <= 10; i++) {
    const t = new Date(d.getTime() - i * 86_400_000);
    const iso = t.toISOString().slice(0, 10);
    if (isTradingDay(iso) && !isHoliday(iso)) return iso;
  }
  return null;
}

export function nextTradingDay(dateISO: string): string | null {
  const d = toDate(dateISO);
  for (let i = 1; i <= 10; i++) {
    const t = new Date(d.getTime() + i * 86_400_000);
    const iso = t.toISOString().slice(0, 10);
    if (isTradingDay(iso) && !isHoliday(iso)) return iso;
  }
  return null;
}

/** Parse NSE "02-Nov-2026" or ISO to YYYY-MM-DD. */
export function parseNseDateToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const str = String(s).trim();
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(str);
  if (m) {
    const months: Record<string, number> = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };
    const mon = months[m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase()];
    if (mon === undefined) return null;
    const y = Number(m[3]);
    const d = Number(m[1]);
    return `${y}-${String(mon + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const d2 = new Date(str);
  if (isNaN(d2.getTime())) return null;
  return d2.toISOString().slice(0, 10);
}

export function istDateISO(now = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  return ist.toISOString().slice(0, 10);
}

/** Minutes since midnight IST. */
export function istMinutes(now = new Date()): number {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

export function isPreopenWindow(now = new Date()): boolean {
  const m = istMinutes(now);
  return m >= 9 * 60 && m < 9 * 60 + 15;
}

export function isPostOpen(now = new Date()): boolean {
  return istMinutes(now) >= 9 * 60 + 15;
}
