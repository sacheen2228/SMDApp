// Session-Aware Scheduler — knows NSE/MCX timings, holidays, expiry days
// Controls when monitors should run and when to sleep
// No unnecessary polling when market is closed

// ─── Session Types ────────────────────────────────────────────────
export type MarketSession =
  | 'PRE_MARKET'        // 06:00-09:15 NSE / before MCX open
  | 'MARKET_OPEN'       // 09:15-15:30 NSE
  | 'POST_MARKET'       // 15:30-16:00 NSE
  | 'MCX_SESSION'       // 09:00-23:30 MCX (varies by commodity)
  | 'OVERNIGHT_RESEARCH' // After all markets close
  | 'WEEKEND'
  | 'HOLIDAY';

export type MarketId = 'NSE' | 'MCX' | 'BSE';

// ─── NSE 2026 Holidays ───────────────────────────────────────────
const NSE_HOLIDAYS_2026 = new Set([
  '2026-01-26', // Republic Day
  '2026-03-10', // Holi
  '2026-03-30', // Eid
  '2026-04-02', // Ram Navami
  '2026-04-14', // Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-08-15', // Independence Day
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Gandhi Jayanti
  '2026-11-11', // Diwali Balipratipada
  '2026-12-25', // Christmas
]);

// MCX has additional holidays (commodity-specific)
const MCX_HOLIDAYS_2026 = new Set([
  ...NSE_HOLIDAYS_2026,
  '2026-01-01', // New Year
  '2026-11-03', // Diwali (Laxmi Pujan) - special MCX session
]);

// ─── MCX Session Times (IST) ─────────────────────────────────────
// MCX has two sessions: morning (09:00-23:30) and special hours
const MCX_OPEN_HOUR = 9;   // 09:00 IST
const MCX_CLOSE_HOUR = 23; // 23:30 IST (last order 23:15)
const MCX_CLOSE_MINUTE = 30;

// ─── NSE Session Times (IST) ─────────────────────────────────────
const NSE_PRE_MARKET_HOUR = 6;
const NSE_OPEN_HOUR = 9;
const NSE_OPEN_MINUTE = 15;
const NSE_CLOSE_HOUR = 15;
const NSE_CLOSE_MINUTE = 30;
const NSE_POST_MARKET_HOUR = 16;

// ─── Time Helpers ─────────────────────────────────────────────────
function getISTDate(now?: Date): Date {
  const d = now || new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  return new Date(d.getTime() + istOffset);
}

function getISTHour(ist: Date): number {
  return ist.getUTCHours();
}

function getISTMinute(ist: Date): number {
  return ist.getUTCMinutes();
}

function formatDateKey(ist: Date): string {
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDayOfWeek(ist: Date): number {
  return ist.getUTCDay();
}

// ─── Expiry Detection ─────────────────────────────────────────────
export function isExpiryDay(now?: Date): { nse: boolean; sensex: boolean } {
  const ist = getISTDate(now);
  const day = getDayOfWeek(ist);

  // Current SEBI rules: NIFTY/indices expire Tuesday, SENSEX Thursday
  return {
    nse: day === 2, // Tuesday for NIFTY/indices
    sensex: day === 4, // Thursday for SENSEX
  };
}

// ─── Days to Expiry ───────────────────────────────────────────────
export function daysToNextExpiry(now?: Date): number {
  const ist = getISTDate(now);
  const day = getDayOfWeek(ist);

  // Next Tuesday expiry
  let daysToTue = (2 - day + 7) % 7;
  if (daysToTue === 0 && getISTHour(ist) >= NSE_CLOSE_HOUR) {
    daysToTue = 7; // Already past close, next Tuesday
  }
  return daysToTue || 7;
}

// ─── Get Current Session ──────────────────────────────────────────
export function getCurrentSession(now?: Date): {
  session: MarketSession;
  activeMarkets: MarketId[];
  minutesRemaining: number;
  isExpiry: boolean;
  isHoliday: boolean;
} {
  const ist = getISTDate(now);
  const hour = getISTHour(ist);
  const minute = getISTMinute(ist);
  const dateKey = formatDateKey(ist);
  const day = getDayOfWeek(ist);
  const isWeekend = day === 0 || day === 6;
  const isNSEHoliday = NSE_HOLIDAYS_2026.has(dateKey);
  const isMCXHoliday = MCX_HOLIDAYS_2026.has(dateKey);
  const expiry = isExpiryDay(now);

  // Holiday
  if (isWeekend || isNSEHoliday) {
    // Check if MCX has special session (Diwali evening session)
    if (dateKey === '2026-11-03') {
      // MCX Diwali special: 18:00-23:30
      if (hour >= 18 && hour < 23) {
        return {
          session: 'MCX_SESSION',
          activeMarkets: ['MCX'],
          minutesRemaining: (23 - hour) * 60 + (MCX_CLOSE_MINUTE - minute),
          isExpiry: false,
          isHoliday: true,
        };
      }
    }
    return {
      session: isWeekend ? 'WEEKEND' : 'HOLIDAY',
      activeMarkets: [],
      minutesRemaining: 0,
      isExpiry: false,
      isHoliday: true,
    };
  }

  // NSE Pre-market: 06:00-09:15
  if (hour >= NSE_PRE_MARKET_HOUR && hour < NSE_OPEN_HOUR) {
    return {
      session: 'PRE_MARKET',
      activeMarkets: hour >= MCX_OPEN_HOUR ? ['MCX'] : [],
      minutesRemaining: (NSE_OPEN_HOUR - hour) * 60 + (NSE_OPEN_MINUTE - minute),
      isExpiry: expiry.nse,
      isHoliday: false,
    };
  }

  // NSE Market Open: 09:15-15:30
  if (
    (hour === NSE_OPEN_HOUR && minute >= NSE_OPEN_MINUTE) ||
    (hour > NSE_OPEN_HOUR && hour < NSE_CLOSE_HOUR) ||
    (hour === NSE_CLOSE_HOUR && minute < NSE_CLOSE_MINUTE)
  ) {
    const remaining = (NSE_CLOSE_HOUR - hour) * 60 + (NSE_CLOSE_MINUTE - minute);
    const activeMarkets: MarketId[] = ['NSE'];
    if (hour >= MCX_OPEN_HOUR && !isMCXHoliday) activeMarkets.push('MCX');
    return {
      session: 'MARKET_OPEN',
      activeMarkets,
      minutesRemaining: remaining,
      isExpiry: expiry.nse,
      isHoliday: false,
    };
  }

  // NSE Post-market: 15:30-16:00
  if (hour === NSE_CLOSE_HOUR && minute >= NSE_CLOSE_MINUTE) {
    return {
      session: 'POST_MARKET',
      activeMarkets: !isMCXHoliday ? ['MCX'] : [],
      minutesRemaining: (NSE_POST_MARKET_HOUR - hour) * 60 - minute,
      isExpiry: false,
      isHoliday: false,
    };
  }
  if (hour === NSE_POST_MARKET_HOUR && minute === 0) {
    return {
      session: 'POST_MARKET',
      activeMarkets: !isMCXHoliday ? ['MCX'] : [],
      minutesRemaining: 0,
      isExpiry: false,
      isHoliday: false,
    };
  }

  // After NSE close but MCX still open: 16:00-23:30
  if (hour > NSE_POST_MARKET_HOUR && !isMCXHoliday) {
    if (hour < MCX_CLOSE_HOUR || (hour === MCX_CLOSE_HOUR && minute < MCX_CLOSE_MINUTE)) {
      return {
        session: 'MCX_SESSION',
        activeMarkets: ['MCX'],
        minutesRemaining: (MCX_CLOSE_HOUR - hour) * 60 + (MCX_CLOSE_MINUTE - minute),
        isExpiry: false,
        isHoliday: false,
      };
    }
  }

  // Before NSE pre-market but after midnight
  if (hour < NSE_PRE_MARKET_HOUR) {
    if (!isMCXHoliday && hour >= MCX_OPEN_HOUR) {
      return {
        session: 'MCX_SESSION',
        activeMarkets: ['MCX'],
        minutesRemaining: (MCX_CLOSE_HOUR - hour) * 60 + (MCX_CLOSE_MINUTE - minute),
        isExpiry: false,
        isHoliday: false,
      };
    }
    return {
      session: 'OVERNIGHT_RESEARCH',
      activeMarkets: [],
      minutesRemaining: (NSE_PRE_MARKET_HOUR - hour) * 60 + (0 - minute),
      isExpiry: false,
      isHoliday: false,
    };
  }

  // Default: overnight
  return {
    session: 'OVERNIGHT_RESEARCH',
    activeMarkets: [],
    minutesRemaining: 0,
    isExpiry: false,
    isHoliday: false,
  };
}

// ─── Poll Intervals by Session ────────────────────────────────────
export function getPollInterval(session: MarketSession, type: 'signals' | 'monitor' | 'health'): number {
  const intervals: Record<MarketSession, Record<string, number>> = {
    PRE_MARKET: { signals: 300_000, monitor: 60_000, health: 120_000 },
    MARKET_OPEN: { signals: 30_000, monitor: 5_000, health: 30_000 },
    POST_MARKET: { signals: 300_000, monitor: 30_000, health: 120_000 },
    MCX_SESSION: { signals: 60_000, monitor: 10_000, health: 60_000 },
    OVERNIGHT_RESEARCH: { signals: 600_000, monitor: 300_000, health: 300_000 },
    WEEKEND: { signals: 900_000, monitor: 600_000, health: 600_000 },
    HOLIDAY: { signals: 900_000, monitor: 600_000, health: 600_000 },
  };
  return intervals[session]?.[type] ?? 60_000;
}

// ─── Should Monitor? ──────────────────────────────────────────────
export function shouldMonitorSignals(session: MarketSession): boolean {
  return session === 'MARKET_OPEN' || session === 'MCX_SESSION' || session === 'PRE_MARKET';
}

export function shouldMonitorTrades(session: MarketSession): boolean {
  return session === 'MARKET_OPEN' || session === 'MCX_SESSION';
}

export function shouldRunHealthCheck(session: MarketSession): boolean {
  return true; // Always run health checks
}

export function shouldRunResearch(session: MarketSession): boolean {
  return session === 'OVERNIGHT_RESEARCH' || session === 'WEEKEND' || session === 'HOLIDAY' || session === 'PRE_MARKET';
}

// ─── Session Label ────────────────────────────────────────────────
export function formatSessionLabel(session: MarketSession): string {
  const labels: Record<MarketSession, string> = {
    PRE_MARKET: '📈 Pre-Market',
    MARKET_OPEN: '🟢 Market Open',
    POST_MARKET: '📊 Post-Market',
    MCX_SESSION: '🛢️ MCX Session',
    OVERNIGHT_RESEARCH: '🌙 Overnight Research',
    WEEKEND: '📅 Weekend',
    HOLIDAY: '🏖️ Holiday',
  };
  return labels[session] || session;
}
