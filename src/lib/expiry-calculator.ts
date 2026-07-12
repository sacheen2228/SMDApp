// Expiry Date Calculator
// Computes weekly and monthly expiry dates per SEBI rules:
//   NIFTY:      Weekly = every Tuesday,    Monthly = last Tuesday
//   BANKNIFTY:  Weekly = every Thursday,   Monthly = last Thursday
//   FINNIFTY:   Weekly = every Tuesday,    Monthly = last Tuesday
//   MIDCPNIFTY: Weekly = every Wednesday,  Monthly = last Wednesday
//   NIFTYNXT50: Weekly = every Tuesday,    Monthly = last Tuesday
//   SENSEX:     Weekly = every Thursday,   Monthly = last Thursday
//   BANKEX:     Weekly = every Thursday,   Monthly = last Thursday
//   F&O Equity: Weekly = per-stock weekday, Monthly = last weekday of month
//   NSE Equity: Monthly = last Tuesday
//   BSE Equity: Monthly = last Thursday
// Holiday shift → previous trading day

export type ExpiryType = 'weekly' | 'monthly';

export interface ExpiryInfo {
  date: string;          // "DD-MMM-YYYY" (Breeze format)
  dateObj: Date;
  type: ExpiryType;
  daysToExpiry: number;
  label: string;
}

// Per-symbol weekly expiry weekday (0=Sun ... 6=Sat)
// Index F&O weekly expiries after the Jul-2025 SEBI revision
const FNO_WEEKLY_WEEKDAY: Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6> = {
  NIFTY: 2,
  FINNIFTY: 2,
  NIFTYNXT50: 2,
  BANKNIFTY: 4,
  SENSEX: 4,
  BANKEX: 4,
  MIDCPNIFTY: 3,
};

// F&O equity stocks — weekly expiry weekday (subset; extend as needed)
const FNO_EQUITY_WEEKDAY: Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6> = {
  RELIANCE: 4,
  TCS: 4,
  INFY: 4,
  HDFCBANK: 4,
  ICICIBANK: 4,
  SBIN: 4,
  BHARTIARTL: 4,
  ITC: 4,
  KOTAKBANK: 4,
  LT: 4,
};

// All symbols that have F&O (options) contracts
const FNO_SYMBOLS = new Set([
  ...Object.keys(FNO_WEEKLY_WEEKDAY),
  ...Object.keys(FNO_EQUITY_WEEKDAY),
]);

// ─── Is a symbol F&O (has weekly/monthly options)? ────────────────
export function isFNO(symbol: string): boolean {
  return FNO_SYMBOLS.has(symbol.toUpperCase());
}

// ─── Is a symbol an index? ────────────────────────────────────────
export function isIndex(symbol: string): boolean {
  return Object.keys(FNO_WEEKLY_WEEKDAY).includes(symbol.toUpperCase());
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toBreezeDate(d: Date): string {
  const day = d.getDate().toString().padStart(2, '0');
  const month = MONTHS_SHORT[d.getMonth()];
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

function toLabel(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

function daysBetween(a: Date, b: Date): number {
  const msPerDay = 86400000;
  return Math.ceil((b.getTime() - a.getTime()) / msPerDay);
}

// Known NSE/BSE trading holidays 2025-2026 (subset — extend as needed)
const NSE_HOLIDAYS = new Set([
  // 2025
  '2025-01-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14',
  '2025-04-18', '2025-05-01', '2025-06-27', '2025-08-15', '2025-10-02',
  '2025-10-21', '2025-10-22', '2025-11-05', '2025-12-25',
  // 2026
  '2026-01-26', '2026-03-10', '2026-03-30', '2026-04-02', '2026-04-14',
  '2026-05-01', '2026-08-15', '2026-10-02', '2026-11-11', '2026-12-25',
]);

function isHoliday(d: Date): boolean {
  const iso = d.toISOString().split('T')[0];
  return NSE_HOLIDAYS.has(iso);
}

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

function isTradingDay(d: Date): boolean {
  return !isWeekend(d) && !isHoliday(d);
}

// Shift to previous trading day if holiday/weekend
function shiftToPrevTradingDay(d: Date): Date {
  const result = new Date(d);
  while (!isTradingDay(result)) {
    result.setDate(result.getDate() - 1);
  }
  return result;
}

// ─── Get expiry weekday for a symbol ──────────────────────────────
function getExpiryWeekday(symbol: string): 1 | 2 | 3 | 4 | 5 {
  const sym = symbol.toUpperCase();
  const wd = FNO_WEEKLY_WEEKDAY[sym] ?? FNO_EQUITY_WEEKDAY[sym];
  if (wd != null && wd >= 1 && wd <= 5) return wd as 1 | 2 | 3 | 4 | 5;
  // Default: Tuesday for other NSE equities, Thursday for BSE
  return sym === 'SENSEX' || sym === 'BANKEX' ? 4 : 2;
}

// ─── Find the Nth occurrence of a weekday in a month ──────────────
function nthWeekdayOfMonth(year: number, month: number, weekday: 1 | 2 | 3 | 4 | 5, n: number): Date | null {
  const d = new Date(year, month, 1);
  // Find first occurrence of weekday
  while (d.getDay() !== weekday) {
    d.setDate(d.getDate() + 1);
    if (d.getMonth() !== month) return null;
  }
  // Advance to nth occurrence
  d.setDate(d.getDate() + (n - 1) * 7);
  if (d.getMonth() !== month) return null;
  return d;
}

// ─── Find last occurrence of a weekday in a month ─────────────────
function lastWeekdayOfMonth(year: number, month: number, weekday: 1 | 2 | 3 | 4 | 5): Date {
  const d = new Date(year, month + 1, 0); // last day of month
  while (d.getDay() !== weekday) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

// ─── Generate next N weekly expiry dates ──────────────────────────
export function getWeeklyExpiries(symbol: string, count: number = 10): ExpiryInfo[] {
  const weekday = getExpiryWeekday(symbol);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const results: ExpiryInfo[] = [];

  const cursor = new Date(today);

  // Find first upcoming weekday
  while (cursor.getDay() !== weekday || !isTradingDay(cursor)) {
    cursor.setDate(cursor.getDate() + 1);
  }

  while (results.length < count) {
    const expiry = shiftToPrevTradingDay(new Date(cursor));
    // If shifted to a past date, skip to next week
    if (expiry < today) {
      cursor.setDate(cursor.getDate() + 7);
      continue;
    }

    results.push({
      date: toBreezeDate(expiry),
      dateObj: new Date(expiry),
      type: 'weekly',
      daysToExpiry: daysBetween(today, expiry),
      label: toLabel(expiry),
    });

    cursor.setDate(cursor.getDate() + 7);
  }

  return results;
}

// ─── Generate next N monthly expiry dates ─────────────────────────
export function getMonthlyExpiries(symbol: string, count: number = 6): ExpiryInfo[] {
  const weekday = getExpiryWeekday(symbol);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const results: ExpiryInfo[] = [];

  let year = now.getFullYear();
  let month = now.getMonth();

  while (results.length < count) {
    let expiry = lastWeekdayOfMonth(year, month, weekday);
    expiry = shiftToPrevTradingDay(expiry);

    // Skip if already past
    if (expiry >= today) {
      results.push({
        date: toBreezeDate(expiry),
        dateObj: new Date(expiry),
        type: 'monthly',
        daysToExpiry: daysBetween(today, expiry),
        label: toLabel(expiry),
      });
    }

    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
  }

  return results;
}

// ─── Get all expiries (weekly + monthly, deduped) ─────────────────
export function getAllExpiries(symbol: string): ExpiryInfo[] {
  const weekly = getWeeklyExpiries(symbol, 15);
  const monthly = getMonthlyExpiries(symbol, 6);

  const all = [...weekly, ...monthly];

  // Dedupe by date string
  const seen = new Set<string>();
  const deduped: ExpiryInfo[] = [];
  for (const e of all) {
    if (!seen.has(e.date)) {
      seen.add(e.date);
      deduped.push(e);
    }
  }

  // Sort by date ascending
  deduped.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());

  return deduped;
}

// ─── Get nearest expiry (next upcoming) ───────────────────────────
export function getNearestExpiry(symbol: string): ExpiryInfo | null {
  const all = getAllExpiries(symbol);
  return all.find(e => e.daysToExpiry >= 0) || null;
}

// ─── Determine if a given date is weekly or monthly expiry ────────
export function getExpiryType(symbol: string, expiryDate: string): ExpiryType {
  const monthly = getMonthlyExpiries(symbol, 12);
  if (monthly.some(m => m.date === expiryDate)) return 'monthly';
  return 'weekly';
}

// ─── Get next monthly expiry from today ───────────────────────────
export function getNextMonthlyExpiry(symbol: string): ExpiryInfo | null {
  const monthly = getMonthlyExpiries(symbol, 6);
  return monthly.find(e => e.daysToExpiry >= 0) || null;
}

// ─── Get next weekly expiry from today ────────────────────────────
export function getNextWeeklyExpiry(symbol: string): ExpiryInfo | null {
  const weekly = getWeeklyExpiries(symbol, 10);
  return weekly.find(e => e.daysToExpiry >= 0) || null;
}

// ─── Format list for Breeze SDK ───────────────────────────────────
export function getExpiryDatesForSDK(symbol: string): string[] {
  return getAllExpiries(symbol).map(e => e.date);
}

// ─── Is today (or a given date) an expiry day for this symbol? ─────
export function isExpiryDay(symbol: string, date: Date = new Date()): boolean {
  if (!isFNO(symbol)) return false;
  const all = getAllExpiries(symbol);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return all.some(e =>
    e.dateObj.getFullYear() === target.getFullYear() &&
    e.dateObj.getMonth() === target.getMonth() &&
    e.dateObj.getDate() === target.getDate()
  );
}

// ─── Get the expiry type for a given date (null if not expiry) ─────
export function getExpiryTypeForDate(symbol: string, date: Date = new Date()): ExpiryType | null {
  if (!isFNO(symbol)) return null;
  const all = getAllExpiries(symbol);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const hit = all.find(e =>
    e.dateObj.getFullYear() === target.getFullYear() &&
    e.dateObj.getMonth() === target.getMonth() &&
    e.dateObj.getDate() === target.getDate()
  );
  return hit ? hit.type : null;
}
