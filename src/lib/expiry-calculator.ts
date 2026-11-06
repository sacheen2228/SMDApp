// Expiry Date Calculator
// Computes weekly and monthly expiry dates per the CURRENT SEBI rules and the
// contracts the exchanges actually list.
//
// LIVE-VERIFIED CALENDAR (NSE contract-info + BSE chain, checked 2026-11-04):
//   NIFTY:      Weekly = Tuesday,            Monthly = last Tuesday
//   NIFTYNXT50: Weekly = Tuesday,            Monthly = last Tuesday
//   BANKNIFTY:  Monthly only = last Tuesday  (weekly discontinued, Sep-2025)
//   FINNIFTY:   Monthly only = last Tuesday  (weekly discontinued)
//   MIDCPNIFTY: Monthly only = last Tuesday  (weekly discontinued)
//   SENSEX:     Weekly = Thursday,           Monthly = last Thursday
//   BANKEX:     Monthly only = last Thursday (BSE weekly = SENSEX only)
//   NSE equity: Monthly = last Tuesday       (e.g. RELIANCE: 23-Nov-2026)
//   BSE equity: Monthly = last Thursday
//
// TWO FACTS THAT BREAK A HARDCODED WEEKDAY RULE:
//   1. An expiry that lands on an exchange holiday moves to the PREVIOUS
//      trading day — e.g. NSE's Oct/Nov-2026 monthlies are published as
//      23-Nov-2026 (Monday), not 24-Nov (Tuesday), and 25-Jan-2027, not
//      26-Jan (Republic Day). The published list is the authority.
//   2. The exchange publishes only the contracts it serves (the nearest
//      weeklies + the monthlies). A date that is not in that list is not a
//      tradable contract — asking for it returns EXPIRY_UNAVAILABLE.
//
// Therefore: the EXCHANGE LIST WINS whenever it is known (cached from the
// live chain fetch); the weekday rules below are the fallback only.
//
// Holiday shift → previous trading day

import { getLotSizeStrict } from '@/lib/symbol-config';

export type ExpiryType = 'weekly' | 'monthly';

// ─── Standardized Expiry data (Zero Hero AI contract) ────────────
// Consolidated expiry descriptor consumed by the Zero Hero UI / engine.
// Reuses getNearestExpiry / getExpiryType / isExpiryDay.
export interface StandardizedExpiry {
  instrument: string;
  exchange: 'NSE' | 'BSE';
  expiry_date: string;        // YYYY-MM-DD (local)
  expiry_type: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'FAR_MONTH' | 'NON_EXPIRY';
  days_to_expiry: number;
  is_expiry_today: boolean;
  is_monthly_expiry: boolean;
  is_weekly_expiry: boolean;
  is_quarterly_expiry: boolean;
  expiry_mode: 'ZERO_HERO' | 'STANDARD';
  option_liquidity: 'HIGH' | 'MEDIUM' | 'LOW';
  strategy_profile: 'EXPIRY' | 'NORMAL';
  session_type: 'EXPIRY' | 'REGULAR';
  /** The REAL contract lot — null when it is not known (never a guess). */
  lot_size: number | null;
  /** false → `lot_size` is null (the contract lot is unknown). */
  lot_size_known: boolean;
  tick_size: number;
}

const BSE_INSTRUMENTS = new Set(['SENSEX', 'BANKEX']);
const HIGH_LIQUIDITY = new Set([
  'NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY',
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN',
  'BHARTIARTL', 'ITC', 'KOTAKBANK', 'LT', 'AXISBANK', 'HINDUNILVR',
  'MARUTI', 'BAJFINANCE', 'ASIANPAINT',
]);

export function getStandardizedExpiry(symbol: string, referenceDate: Date = new Date()): StandardizedExpiry | null {
  if (!isFNO(symbol)) return null;
  const nearest = getNearestExpiry(symbol);
  if (!nearest) return null;

  const exchange: 'NSE' | 'BSE' = BSE_INSTRUMENTS.has(symbol.toUpperCase()) ? 'BSE' : 'NSE';
  // The REAL contract lot — null when it is not known (never a guess).
  const lotSize = getLotSizeStrict(symbol);
  const type = nearest.type; // 'weekly' | 'monthly'
  const daysToExpiry = nearest.daysToExpiry;
  const isExpiryToday = daysToExpiry === 0;

  const isQuarterly = type === 'monthly' && (nearest.dateObj.getMonth() + 1) % 3 === 0;
  const expiryType: StandardizedExpiry['expiry_type'] = isQuarterly ? 'QUARTERLY' : type === 'monthly' ? 'MONTHLY' : 'WEEKLY';

  const expLocal = new Date(nearest.dateObj.getFullYear(), nearest.dateObj.getMonth(), nearest.dateObj.getDate());
  const yyyy = expLocal.getFullYear();
  const mm = String(expLocal.getMonth() + 1).padStart(2, '0');
  const dd = String(expLocal.getDate()).padStart(2, '0');

  return {
    instrument: symbol,
    exchange,
    expiry_date: `${yyyy}-${mm}-${dd}`,
    expiry_type: expiryType,
    days_to_expiry: daysToExpiry,
    is_expiry_today: isExpiryToday,
    is_monthly_expiry: type === 'monthly' || isQuarterly,
    is_weekly_expiry: type === 'weekly',
    is_quarterly_expiry: isQuarterly,
    expiry_mode: (type === 'monthly' || type === 'weekly') ? 'ZERO_HERO' : 'STANDARD',
    option_liquidity: HIGH_LIQUIDITY.has(symbol) ? 'HIGH' : 'MEDIUM',
    strategy_profile: (type === 'monthly' || type === 'weekly') ? 'EXPIRY' : 'NORMAL',
    session_type: (type === 'monthly' || type === 'weekly') ? 'EXPIRY' : 'REGULAR',
    lot_size: lotSize,
    lot_size_known: lotSize !== null,
    tick_size: 0.05,
  };
}

export interface ExpiryInfo {
  date: string;          // "DD-MMM-YYYY" (Breeze format)
  dateObj: Date;
  type: ExpiryType;
  daysToExpiry: number;
  label: string;
}

// ─── The expiry calendar per symbol ───────────────────────────────
// weeklyWeekday: null → the symbol has NO weekly contracts.
// monthlyWeekday: the weekday of the MONTHLY expiry (the last such weekday
// of the month), shifted back to the previous trading day on a holiday.
interface ExpiryCalendar {
  weeklyWeekday: number | null;
  monthlyWeekday: number;
}

const TUESDAY = 2;
const THURSDAY = 4;

const EXPIRY_CALENDAR: Record<string, ExpiryCalendar> = {
  NIFTY:      { weeklyWeekday: TUESDAY, monthlyWeekday: TUESDAY },
  NIFTYNXT50: { weeklyWeekday: TUESDAY, monthlyWeekday: TUESDAY },
  BANKNIFTY:  { weeklyWeekday: null,      monthlyWeekday: TUESDAY },
  FINNIFTY:   { weeklyWeekday: null,      monthlyWeekday: TUESDAY },
  MIDCPNIFTY: { weeklyWeekday: null,      monthlyWeekday: TUESDAY },
  SENSEX:     { weeklyWeekday: THURSDAY, monthlyWeekday: THURSDAY },
  BANKEX:     { weeklyWeekday: null,      monthlyWeekday: THURSDAY },
};

// F&O equity stocks — MONTHLY only (weekly expiries exist for indices only).
// NSE stock monthlies are the last Tuesday; BSE stock monthlies the last Thursday.
const FNO_EQUITY_SYMBOLS = new Set([
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN',
  'BHARTIARTL', 'ITC', 'KOTAKBANK', 'LT',
]);

// All symbols that have F&O (options) contracts
const FNO_SYMBOLS = new Set([
  ...Object.keys(EXPIRY_CALENDAR),
  ...FNO_EQUITY_SYMBOLS,
]);

// ─── Is a symbol F&O (has weekly/monthly options)? ────────────────
export function isFNO(symbol: string): boolean {
  return FNO_SYMBOLS.has(symbol.toUpperCase());
}

// ─── Is a symbol an index? ────────────────────────────────────────
export function isIndex(symbol: string): boolean {
  return Object.keys(EXPIRY_CALENDAR).includes(symbol.toUpperCase());
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

/** Local (server/IST) calendar date as YYYY-MM-DD. */
function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Known NSE/BSE trading holidays 2025-2027 (subset — extend as needed).
// The 2026-11-10 / 2026-11-24 / 2027-01-26 entries are OBSERVED from the
// exchange's own contract list: NSE publishes the Oct/Nov-2026 monthly as
// 23-Nov-2026 and the Jan-2027 monthly as 25-Jan-2027 — i.e. those Tuesdays
// are non-trading days and the expiry sits on the previous trading day.
const NSE_HOLIDAYS = new Set([
  // 2025
  '2025-01-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14',
  '2025-04-18', '2025-05-01', '2025-06-27', '2025-08-15', '2025-10-02',
  '2025-10-21', '2025-10-22', '2025-11-05', '2025-12-25',
  // 2026
  '2026-01-26', '2026-03-10', '2026-03-30', '2026-04-02', '2026-04-14',
  '2026-05-01', '2026-08-15', '2026-09-14', '2026-10-02', '2026-11-10',
  '2026-11-24', '2026-12-25',
  // 2027
  '2027-01-26', '2027-03-06', '2027-04-14', '2027-08-15', '2027-10-02', '2027-12-25',
]);

export function isHoliday(d: Date): boolean {
  // LOCAL calendar date. toISOString() is UTC — on an IST server a local
  // midnight Date is 18:30 UTC the PREVIOUS day, so the UTC form checked
  // the wrong date (every holiday lookup was off by one day).
  return NSE_HOLIDAYS.has(toLocalIsoDate(d));
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

// ─── Exchange expiry list — THE authority ─────────────────────────
// The exchanges publish the contracts they actually serve. The list is cached
// when a live chain is fetched (the option-chain route pushes it here), and a
// direct refresh can be triggered for any symbol.
const EXCHANGE_EXPIRY_CACHE = new Map<string, { dates: string[]; ts: number }>();
const EXCHANGE_EXPIRY_TTL_MS = 10 * 60 * 1000;

/** Record the expiry dates the exchange just served for this symbol. */
export function setExchangeExpiries(symbol: string, dates: string[]): void {
  const clean = (dates || [])
    .map((d) => String(d || '').trim())
    .filter((d) => d && parseExchangeDate(d) !== null);
  if (!clean.length) return;
  EXCHANGE_EXPIRY_CACHE.set(symbol.toUpperCase(), { dates: clean, ts: Date.now() });
}

/** The cached exchange list (fresh only) — null when unknown/stale. */
export function getCachedExchangeExpiries(symbol: string): string[] | null {
  const hit = EXCHANGE_EXPIRY_CACHE.get(symbol.toUpperCase());
  if (!hit) return null;
  if (Date.now() - hit.ts > EXCHANGE_EXPIRY_TTL_MS) return null;
  return hit.dates;
}

/**
 * The ONE candidate expiry list a provider chain path may use: this module's
 * calendar (exchange-aware, holiday-shift aware — a holiday Tuesday shifts
 * BACK to the previous trading day) UNION the provider's own real contract
 * dates — normalized to Breeze format ("DD-MMM-YYYY"), dead sessions dropped,
 * strictly ascending.
 *
 * Providers must never ladder dates themselves. The old inline weekday rule
 * in icici-breeze/option-chain.ts invented Tue 10-Nov-2026 (a trading
 * holiday — that week settles Mon 09-Nov-2026), the UI auto-selected
 * expiries[0] and the option-chain tab looped on EXPIRY_UNAVAILABLE 400s.
 */
export function mergeExpiryCandidates(symbol: string, providerDates: string[] = []): string[] {
  const today = localToday();
  const out = new Set<string>();

  for (const raw of providerDates) {
    const d = parseExchangeDate(String(raw || "").trim());
    if (d) out.add(toBreezeDate(d));
  }
  for (const info of getAllExpiries(symbol)) out.add(info.date);

  const parse = (s: string) => parseExchangeDate(s);
  return Array.from(out)
    .filter((date) => {
      const d = parse(date);
      return !!d && d.getTime() >= today.getTime();
    })
    .sort((a, b) => parse(a)!.getTime() - parse(b)!.getTime());
}

/**
 * NOTE: no network call lives in this module. It is imported by client
 * components (ZeroHeroTerminal), so a Node-only SDK import here breaks the
 * browser bundle. The exchange list is refreshed SERVER-side by
 * `refreshNSEExpiryList()` in src/lib/nse-api.ts, which calls
 * `setExchangeExpiries()` here.
 */

/** Parse "09-Nov-2026" / "09 Nov 2026" / "2026-11-09" into a local Date. */
function parseExchangeDate(raw: string): Date | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/](\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS_SHORT.findIndex((x) => x.toLowerCase() === m![2].slice(0, 3).toLowerCase());
    if (mon < 0) return null;
    return new Date(+m[3], mon, +m[1]);
  }
  return null;
}

/**
 * Turn the exchange list into ExpiryInfo.
 * The MONTHLY contract is the LAST expiry of its calendar month (the monthly
 * expiry is always the last weekly of the month — the same contract).
 */
function classifyExchangeList(symbol: string, dates: string[]): ExpiryInfo[] {
  const today = localToday();
  const parsed = dates
    .map((d) => ({ raw: d, obj: parseExchangeDate(d) }))
    .filter((p): p is { raw: string; obj: Date } => p.obj !== null)
    .sort((a, b) => a.obj.getTime() - b.obj.getTime());

  const lastIndexOfMonth = new Map<string, number>();
  parsed.forEach((p, i) => {
    lastIndexOfMonth.set(`${p.obj.getFullYear()}-${p.obj.getMonth()}`, i);
  });

  return parsed.map((p, i) => {
    const key = `${p.obj.getFullYear()}-${p.obj.getMonth()}`;
    const type: ExpiryType = lastIndexOfMonth.get(key) === i ? 'monthly' : 'weekly';
    return {
      date: toBreezeDate(p.obj),
      dateObj: p.obj,
      type,
      daysToExpiry: daysBetween(today, p.obj),
      label: toLabel(p.obj),
    };
  });
}

function localToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// ─── Get expiry weekday for a symbol ──────────────────────────────
function getCalendar(symbol: string): ExpiryCalendar {
  const sym = symbol.toUpperCase();
  const known = EXPIRY_CALENDAR[sym];
  if (known) return known;
  // NSE F&O equity (monthly only) → last Tuesday. BSE equity → last Thursday.
  if (BSE_INSTRUMENTS.has(sym)) return { weeklyWeekday: null, monthlyWeekday: THURSDAY };
  return { weeklyWeekday: null, monthlyWeekday: TUESDAY };
}

function getWeeklyWeekday(symbol: string): number | null {
  return getCalendar(symbol).weeklyWeekday;
}

function getMonthlyWeekday(symbol: string): number {
  return getCalendar(symbol).monthlyWeekday;
}

// ─── Find the Nth occurrence of a weekday in a month ──────────────
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date | null {
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
function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const d = new Date(year, month + 1, 0); // last day of month
  while (d.getDay() !== weekday) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

// ─── Generate next N weekly expiry dates ──────────────────────────
// Weekly expiries exist for INDICES only — stock F&O is monthly-only.
export function getWeeklyExpiries(symbol: string, count: number = 10): ExpiryInfo[] {
  const exchange = getCachedExchangeExpiries(symbol);
  if (exchange && exchange.length) {
    return classifyExchangeList(symbol, exchange).filter((e) => e.type === 'weekly').slice(0, count);
  }
  const weekday = getWeeklyWeekday(symbol);
  if (weekday == null) return [];
  const today = localToday();
  const results: ExpiryInfo[] = [];

  const cursor = new Date(today);

  // Find the first upcoming occurrence of the weekday. A holiday does NOT
  // skip that week — the expiry moves BACK to the previous trading day
  // (NSE: Tuesday 10-Nov-2026 → Monday 09-Nov-2026).
  while (cursor.getDay() !== weekday) {
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
  const exchange = getCachedExchangeExpiries(symbol);
  if (exchange && exchange.length) {
    return classifyExchangeList(symbol, exchange).filter((e) => e.type === 'monthly').slice(0, count);
  }
  const weekday = getMonthlyWeekday(symbol);
  const today = localToday();
  const results: ExpiryInfo[] = [];

  let year = today.getFullYear();
  let month = today.getMonth();

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

  // Dedupe by date. The MONTHLY contract is also the last WEEKLY of the
  // month — the MONTHLY entry must win, otherwise the monthly expiry is
  // labelled "weekly" and every monthly-cycle rule (quarterly detection,
  // EXPIRY strategy profile) mis-fires.
  const byDate = new Map<string, ExpiryInfo>();
  for (const e of weekly) byDate.set(e.date, e);
  for (const e of monthly) {
    const existing = byDate.get(e.date);
    if (!existing || existing.type !== 'monthly') byDate.set(e.date, e);
  }

  // Sort by date ascending
  return Array.from(byDate.values()).sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
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
