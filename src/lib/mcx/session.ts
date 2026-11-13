// MCX Commodity Module — Session Engine
// MCX trading hours: 9:00 AM - 11:30/11:55 PM IST (varies by commodity)
// DO NOT reuse NSE hours — MCX has completely different session structure

import type { MCXCommodity, MCXSessionState } from './types';
import { MCX_CONTRACT_SPECS } from './instrument-master';
import { NSE_HOLIDAYS } from '../expiry-calculator';

export interface MCXSessionInfo {
  state: MCXSessionState;
  isActive: boolean;
  isPreMarket: boolean;
  isDaySession: boolean;
  isEveningSession: boolean;
  minutesRemaining: number;
  confidenceMultiplier: number;
  allowedActions: string[];
  description: string;
  /** True only inside the executable signal window (17:30-22:00 IST). */
  isSignalWindow: boolean;
  /** Whether a NEW trade signal may be raised right now. */
  signalsAllowed: boolean;
  /** True on a weekend or an MCX holiday. */
  isTradingDay: boolean;
}

// ── MCX holidays ─────────────────────────────────────────────────────────────
// Canonical MCX holiday set for the session engine. The base is the repo's
// NSE holiday list (already the single source of truth for exchange closures);
// MCX runs its own calendar that differs at the margins, so the officially
// verified MCX-specific FULL closures are appended below and this list is the
// one place to update them. (The Diwali Laxmi-Pujan special evening session is
// handled by hermes/scheduler.ts, not by a full-closure entry here.)
const MCX_SPECIFIC_HOLIDAYS: string[] = [
  '2026-01-01', // New Year — MCX full closure (carried over from hermes/scheduler)
]; // YYYY-MM-DD full closures unique to MCX
export const MCX_HOLIDAYS: Set<string> = new Set<string>([
  ...NSE_HOLIDAYS,
  ...MCX_SPECIFIC_HOLIDAYS,
]);

// ── Executable signal window (IST) ───────────────────────────────────────────
// Signals are only raised 17:30-22:00 IST (the liquid evening window). Outside
// it the module still shows live data but will not originate a NEW trade.
export const MCX_SIGNAL_WINDOW = { start: 17 * 60 + 30, end: 22 * 60 }; // 17:30 - 22:00

// ── Session end time — US daylight-saving aware ──────────────────────────────
// MCX evening trade ends 23:30 IST normally, but 23:55 while US daylight time
// is in effect (the international reference markets stay open later).
const MCX_END_STANDARD = '23:30';
const MCX_END_US_DST = '23:55';

/** Nth Sunday of a month (UTC date granularity), n = 1-based. */
function nthSundayUTC(year: number, monthIndex: number, n: number): number {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const firstDow = first.getUTCDay(); // 0 = Sunday
  const offset = (7 - firstDow) % 7; // days to first Sunday
  const dayOfMonth = 1 + offset + (n - 1) * 7;
  return Date.UTC(year, monthIndex, dayOfMonth);
}

/** US daylight time (2nd Sun Mar → 1st Sun Nov), date-granular. */
export function isUsDaylightTime(date: Date): boolean {
  const year = date.getUTCFullYear();
  const start = nthSundayUTC(year, 2, 2); // March (index 2), 2nd Sunday
  const end = nthSundayUTC(year, 10, 1); // November (index 10), 1st Sunday
  const t = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return t >= start && t < end;
}

/** Effective MCX end time (HH:MM IST) for a date. */
export function getMCXEndTimeIST(date: Date, specEndTime?: string): string {
  if (isUsDaylightTime(date)) return MCX_END_US_DST;
  return specEndTime || MCX_END_STANDARD;
}

// MCX session phases
const MCX_PHASES: Record<MCXSessionState, { start: number; end: number; description: string; confidence: number }> = {
  MCX_SESSION_CLOSED: { start: 0, end: 540, description: 'MCX Closed (Before 9:00 AM)', confidence: 0 },
  MCX_SESSION_PRE_OPEN: { start: 540, end: 555, description: 'MCX Pre-Market (9:00-9:15)', confidence: 0.3 },
  // MCX has no separate opening-auction phase after the 9:00-9:15 pre-open;
  // this key is retained for type completeness (unreachable by design).
  MCX_SESSION_OPENING: { start: 555, end: 555, description: 'MCX Opening', confidence: 0.5 },
  MCX_SESSION_DAY_ACTIVE: { start: 555, end: 1020, description: 'MCX Day Session (9:15-5:00 PM)', confidence: 0.8 },
  MCX_SESSION_EVENING_ACTIVE: { start: 1020, end: 1410, description: 'MCX Evening Session (5:00 PM-11:30 PM)', confidence: 0.7 },
  MCX_SESSION_CLOSING: { start: 1410, end: 1430, description: 'MCX Closing (11:30-11:50 PM)', confidence: 0.5 },
  MCX_SESSION_POST_CLOSE: { start: 1430, end: 1440, description: 'MCX Post-Close', confidence: 0 },
};

// Convert IST time to minutes since midnight (timezone-independent)
function toMinutesIST(date: Date): number {
  const ist = new Date(date.getTime() + 5.5 * 3600000); // UTC+5:30
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

// IST calendar date key (YYYY-MM-DD) — UTC getters after the +5:30 shift, so it
// is correct on any server timezone (never toISOString()).
function istDateKey(date: Date): string {
  const ist = new Date(date.getTime() + 5.5 * 3600000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ── Is MCX trading today? (weekend + holiday aware) ──
export function isMCXTradingDay(date: Date = new Date()): boolean {
  const ist = new Date(date.getTime() + 5.5 * 3600000);
  const day = ist.getUTCDay(); // IST weekday
  if (day === 0 || day === 6) return false;
  return !MCX_HOLIDAYS.has(istDateKey(date));
}

/** True inside the executable signal window (17:30-22:00 IST). */
export function isMCXSignalWindow(date: Date = new Date()): boolean {
  const minutes = toMinutesIST(date);
  return minutes >= MCX_SIGNAL_WINDOW.start && minutes < MCX_SIGNAL_WINDOW.end;
}

// ── Get current MCX session state ──
export function getMCXSession(symbol?: MCXCommodity): MCXSessionInfo {
  const now = new Date();
  const minutes = toMinutesIST(now);
  const tradingDay = isMCXTradingDay(now);

  // Non-trading day (weekend or MCX holiday)
  if (!tradingDay) {
    return {
      state: 'MCX_SESSION_CLOSED',
      isActive: false,
      isPreMarket: false,
      isDaySession: false,
      isEveningSession: false,
      minutesRemaining: 0,
      confidenceMultiplier: 0,
      allowedActions: [],
      description: 'MCX Closed (Weekend/Holiday)',
      isSignalWindow: false,
      signalsAllowed: false,
      isTradingDay: false,
    };
  }

  // Check commodity-specific end time (US-DST aware)
  const spec = symbol ? MCX_CONTRACT_SPECS[symbol] : null;
  const endTimeStr = getMCXEndTimeIST(now, spec?.tradingEndTime);
  const [endH, endM] = endTimeStr.split(':').map(Number);
  const endMinutes = endH * 60 + endM;

  // Determine session phase
  let state: MCXSessionState = 'MCX_SESSION_CLOSED';
  for (const [key, phase] of Object.entries(MCX_PHASES)) {
    if (minutes >= phase.start && minutes < phase.end) {
      state = key as MCXSessionState;
      break;
    }
  }

  // Override for commodity-specific end time
  if (state === 'MCX_SESSION_EVENING_ACTIVE' && minutes >= endMinutes - 20) {
    state = 'MCX_SESSION_CLOSING';
  } else if (state === 'MCX_SESSION_CLOSING' && minutes >= endMinutes) {
    state = 'MCX_SESSION_POST_CLOSE';
  }

  const phase = MCX_PHASES[state];
  const isActive = state === 'MCX_SESSION_DAY_ACTIVE' || state === 'MCX_SESSION_EVENING_ACTIVE';
  const isDaySession = state === 'MCX_SESSION_DAY_ACTIVE';
  const isEveningSession = state === 'MCX_SESSION_EVENING_ACTIVE';
  const minutesRemaining = Math.max(0, endMinutes - minutes);

  const isSignalWindow = isActive && isMCXSignalWindow(now);

  const allowedActions: string[] = [];
  if (isSignalWindow) {
    allowedActions.push('TRADE', 'SCANNER', 'LIVE_DATA');
  } else if (isActive) {
    allowedActions.push('SCANNER', 'LIVE_DATA');
  } else if (state === 'MCX_SESSION_PRE_OPEN') {
    allowedActions.push('SCANNER');
  } else if (state === 'MCX_SESSION_CLOSING') {
    allowedActions.push('LIVE_DATA', 'SQUARE_OFF');
  }

  return {
    state,
    isActive,
    isPreMarket: state === 'MCX_SESSION_PRE_OPEN',
    isDaySession,
    isEveningSession,
    minutesRemaining,
    confidenceMultiplier: phase.confidence,
    allowedActions,
    description: phase.description,
    isSignalWindow,
    signalsAllowed: isSignalWindow,
    isTradingDay: true,
  };
}

// ── Check if MCX is currently active ──
export function isMCXActive(symbol?: MCXCommodity): boolean {
  return getMCXSession(symbol).isActive;
}

// ── Get MCX session description for UI ──
export function getMCXSessionLabel(state: MCXSessionState): string {
  switch (state) {
    case 'MCX_SESSION_CLOSED': return 'CLOSED';
    case 'MCX_SESSION_PRE_OPEN': return 'PRE-MARKET';
    case 'MCX_SESSION_OPENING': return 'OPENING';
    case 'MCX_SESSION_DAY_ACTIVE': return 'LIVE';
    case 'MCX_SESSION_EVENING_ACTIVE': return 'LIVE';
    case 'MCX_SESSION_CLOSING': return 'CLOSING';
    case 'MCX_SESSION_POST_CLOSE': return 'CLOSED';
    default: return 'UNKNOWN';
  }
}

// ── Get MCX session color for UI ──
export function getMCXSessionColor(state: MCXSessionState): string {
  switch (state) {
    case 'MCX_SESSION_DAY_ACTIVE':
    case 'MCX_SESSION_EVENING_ACTIVE': return '#26a69a'; // green
    case 'MCX_SESSION_OPENING': return '#ffa726'; // orange
    case 'MCX_SESSION_CLOSING': return '#ff9800'; // amber
    case 'MCX_SESSION_PRE_OPEN': return '#64b5f6'; // blue
    default: return '#78909c'; // grey
  }
}
