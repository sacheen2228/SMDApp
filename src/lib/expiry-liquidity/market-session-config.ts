// ─── Market Session Configuration ─────────────────────────────────────
// Centralized session timings for CAS, F&O, and cash segments.
// Single source of truth — no hardcoded timings anywhere else.

export interface SessionWindow {
  start: number;    // minutes from midnight IST
  end: number;      // minutes from midnight IST
  label: string;
  description: string;
}

export interface MarketSessionConfig {
  exchange: string;
  segment: 'CASH' | 'FNO' | 'INDEX';
  instrumentType: 'INDEX' | 'FNO_STOCK' | 'CASH_STOCK' | 'CASH_NON_FNO';
  sessions: {
    continuousTrading: SessionWindow;
    casReference: SessionWindow;      // 15:00-15:15
    casTransition: SessionWindow;     // 15:15-15:20
    casOrderEntry: SessionWindow;     // 15:20-15:25
    casLimitOnly: SessionWindow;      // 15:25-15:30
    casMatching: SessionWindow;       // 15:30-15:35
    derivativesOpen: SessionWindow;   // 15:35-15:40 (F&O continues)
    postClose: SessionWindow;         // 15:50-16:00
  };
  expiryRules: {
    weeklyWeekday: number;    // 0=Sun...6=Sat
    monthlyLastWeekday: number;
    holidayShift: 'PREVIOUS_TRADING_DAY';
  };
  holidayCalendar: string[]; // ISO dates
}

// ─── Default NSE Session Config ──────────────────────────────────────
// All times in minutes from midnight IST

const MINUTES_PER_HOUR = 60;
const MINUTES_15_00 = 15 * MINUTES_PER_HOUR;     // 900
const MINUTES_15_15 = 15 * MINUTES_PER_HOUR + 15; // 915
const MINUTES_15_20 = 15 * MINUTES_PER_HOUR + 20; // 920
const MINUTES_15_25 = 15 * MINUTES_PER_HOUR + 25; // 925
const MINUTES_15_30 = 15 * MINUTES_PER_HOUR + 30; // 930
const MINUTES_15_35 = 15 * MINUTES_PER_HOUR + 35; // 935
const MINUTES_15_40 = 15 * MINUTES_PER_HOUR + 40; // 940
const MINUTES_15_50 = 15 * MINUTES_PER_HOUR + 50; // 950
const MINUTES_16_00 = 16 * MINUTES_PER_HOUR;     // 960

export const NSE_SESSION_CONFIG: MarketSessionConfig = {
  exchange: 'NSE',
  segment: 'FNO',
  instrumentType: 'INDEX',
  sessions: {
    continuousTrading: {
      start: 9 * 60 + 15,  // 09:15
      end: MINUTES_15_15,   // 15:15
      label: 'Continuous Trading',
      description: 'Regular continuous matching session',
    },
    casReference: {
      start: MINUTES_15_00,  // 15:00
      end: MINUTES_15_15,    // 15:15
      label: 'CAS Reference Window',
      description: 'VWAP of this window becomes CAS reference price',
    },
    casTransition: {
      start: MINUTES_15_15,  // 15:15
      end: MINUTES_15_20,    // 15:20
      label: 'CAS Transition',
      description: 'No new orders accepted during transition',
    },
    casOrderEntry: {
      start: MINUTES_15_20,  // 15:20
      end: MINUTES_15_25,    // 15:25
      label: 'CAS Order Entry',
      description: 'Market + limit orders accepted. Indicative price live.',
    },
    casLimitOnly: {
      start: MINUTES_15_25,  // 15:25
      end: MINUTES_15_30,    // 15:30
      label: 'CAS Limit Only',
      description: 'Limit orders only. Random close 15:28-15:30.',
    },
    casMatching: {
      start: MINUTES_15_30,  // 15:30
      end: MINUTES_15_35,    // 15:35
      label: 'CAS Matching',
      description: 'Equilibrium price = official closing price.',
    },
    derivativesOpen: {
      start: MINUTES_15_00,  // 15:00
      end: MINUTES_15_40,    // 15:40
      label: 'Derivatives Trading',
      description: 'Index & stock F&O continue until 15:40.',
    },
    postClose: {
      start: MINUTES_15_50,  // 15:50
      end: MINUTES_16_00,    // 16:00
      label: 'Post-Close Session',
      description: 'Cash trades at CAS/closing price.',
    },
  },
  expiryRules: {
    weeklyWeekday: 2,  // Tuesday (NIFTY/FINNIFTY)
    monthlyLastWeekday: 2,  // Last Tuesday
    holidayShift: 'PREVIOUS_TRADING_DAY',
  },
  holidayCalendar: [
    // 2025-2026 holidays (extend as needed)
    '2025-01-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14',
    '2025-04-18', '2025-05-01', '2025-06-27', '2025-08-15', '2025-10-02',
    '2025-10-21', '2025-10-22', '2025-11-05', '2025-12-25',
    '2026-01-26', '2026-03-10', '2026-03-30', '2026-04-02', '2026-04-14',
    '2026-05-01', '2026-08-15', '2026-10-02', '2026-11-11', '2026-12-25',
  ],
};

// ─── Helper: Get Current IST Minutes ─────────────────────────────────
export function getISTMinutes(): number {
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

// ─── Check if Holiday ────────────────────────────────────────────────
export function isHoliday(date: Date = new Date()): boolean {
  const iso = date.toISOString().split('T')[0];
  return NSE_SESSION_CONFIG.holidayCalendar.includes(iso);
}

// ─── Check if Weekend ────────────────────────────────────────────────
export function isWeekend(date: Date = new Date()): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

// ─── Check if Trading Day ────────────────────────────────────────────
export function isTradingDay(date: Date = new Date()): boolean {
  return !isWeekend(date) && !isHoliday(date);
}

// ─── Get Session State ──────────────────────────────────────────────
export type SessionPhase =
  | 'PRE_OPEN'
  | 'OPENING'
  | 'TREND_FORM'
  | 'PRIMARY'
  | 'LOW_LIQ'
  | 'AFTERNOON'
  | 'CAS_REFERENCE'
  | 'CAS_TRANSITION'
  | 'CAS_ORDER_ENTRY'
  | 'CAS_LIMIT_ONLY'
  | 'CAS_MATCHING'
  | 'DERIVATIVES_OPEN'
  | 'POST_CLOSE'
  | 'CLOSED';

export interface SessionState {
  phase: SessionPhase;
  label: string;
  description: string;
  minutesRemaining: number;
  isCasActive: boolean;
  isDerivativesOpen: boolean;
  confidenceMultiplier: number;
  allowedActions: ('BUY_CALL' | 'BUY_PUT' | 'WAIT')[];
  notes: string[];
}

function minutesToStr(m: number): string {
  const h = Math.floor(m / 60).toString().padStart(2, '0');
  const min = (m % 60).toString().padStart(2, '0');
  return `${h}:${min}`;
}

export function getCurrentSession(instrumentType: 'INDEX' | 'FNO_STOCK' | 'CASH_STOCK' | 'CASH_NON_FNO' = 'INDEX'): SessionState {
  const minutes = getISTMinutes();
  const c = NSE_SESSION_CONFIG.sessions;

  // Helper to compute remaining minutes in current phase
  const remaining = (end: number) => Math.max(0, end - minutes);

  // Before 09:15
  if (minutes < 9 * 60 + 15) {
    return {
      phase: 'PRE_OPEN',
      label: 'Pre-Market',
      description: 'Market not open yet. No live data available.',
      minutesRemaining: (9 * 60 + 15) - minutes,
      isCasActive: false,
      isDerivativesOpen: false,
      confidenceMultiplier: 0,
      allowedActions: ['WAIT'],
      notes: ['Market opens at 09:15 IST', 'Pre-open auction runs 09:00-09:15'],
    };
  }

  // 09:15 - 09:30
  if (minutes < 9 * 60 + 30) {
    return {
      phase: 'OPENING',
      label: 'Opening Volatility',
      description: 'High volatility. Avoid early entries.',
      minutesRemaining: remaining(9 * 60 + 30),
      isCasActive: false,
      isDerivativesOpen: false,
      confidenceMultiplier: 0.4,
      allowedActions: ['WAIT'],
      notes: ['Opening gap moves often reversed', 'Wait for 15-min candle'],
    };
  }

  // 09:30 - 10:30
  if (minutes < 10 * 60 + 30) {
    return {
      phase: 'TREND_FORM',
      label: 'Trend Formation',
      description: 'Market establishing direction.',
      minutesRemaining: remaining(10 * 60 + 30),
      isCasActive: false,
      isDerivativesOpen: false,
      confidenceMultiplier: 0.8,
      allowedActions: ['BUY_CALL', 'BUY_PUT', 'WAIT'],
      notes: ['First clear trend of the day', 'Volume confirmation important'],
    };
  }

  // 10:30 - 12:30
  if (minutes < 12 * 60 + 30) {
    return {
      phase: 'PRIMARY',
      label: 'Primary Window',
      description: 'Best trading window. Highest liquidity.',
      minutesRemaining: remaining(12 * 60 + 30),
      isCasActive: false,
      isDerivativesOpen: true,
      confidenceMultiplier: 1.0,
      allowedActions: ['BUY_CALL', 'BUY_PUT', 'WAIT'],
      notes: ['Highest probability setups', 'Best liquidity'],
    };
  }

  // 12:30 - 13:45
  if (minutes < 13 * 60 + 45) {
    return {
      phase: 'LOW_LIQ',
      label: 'Low Liquidity',
      description: 'Reduced liquidity. Lunch hours.',
      minutesRemaining: remaining(13 * 60 + 45),
      isCasActive: false,
      isDerivativesOpen: true,
      confidenceMultiplier: 0.65,
      allowedActions: ['BUY_CALL', 'BUY_PUT', 'WAIT'],
      notes: ['Wider spreads possible', 'Reduce position size'],
    };
  }

  // 13:45 - 15:00
  if (minutes < c.continuousTrading.end) {
    return {
      phase: 'AFTERNOON',
      label: 'Afternoon Session',
      description: 'Trend continuation or reversal window.',
      minutesRemaining: remaining(c.continuousTrading.end),
      isCasActive: false,
      isDerivativesOpen: true,
      confidenceMultiplier: 0.85,
      allowedActions: ['BUY_CALL', 'BUY_PUT', 'WAIT'],
      notes: ['Position unwinding begins', 'Strong moves possible'],
    };
  }

  // 15:00 - 15:15 (CAS Reference / Derivatives still open)
  if (minutes < c.casReference.end) {
    if (instrumentType === 'INDEX' || instrumentType === 'FNO_STOCK') {
      return {
        phase: 'CAS_REFERENCE',
        label: 'CAS Reference Window',
        description: 'VWAP 15:00-15:15 = CAS reference. Derivatives still open.',
        minutesRemaining: remaining(c.casReference.end),
        isCasActive: true,
        isDerivativesOpen: true,
        confidenceMultiplier: 0.3,
        allowedActions: ['WAIT'],
        notes: ['Reference price = VWAP 15:00-15:15', 'Derivatives open until 15:40'],
      };
    } else {
      return {
        phase: 'CAS_REFERENCE',
        label: 'CAS Reference Window',
        description: 'VWAP 15:00-15:15 = CAS reference price.',
        minutesRemaining: remaining(c.casReference.end),
        isCasActive: true,
        isDerivativesOpen: false,
        confidenceMultiplier: 0.3,
        allowedActions: ['WAIT'],
        notes: ['Reference price = VWAP 15:00-15:15', 'Continuous trading ends at 15:15'],
      };
    }
  }

  // 15:15 - 15:20 (CAS Transition)
  if (minutes < c.casTransition.end) {
    return {
      phase: 'CAS_TRANSITION',
      label: 'CAS Transition',
      description: 'No orders accepted. Open limits carried into auction.',
      minutesRemaining: remaining(c.casTransition.end),
      isCasActive: true,
      isDerivativesOpen: instrumentType !== 'CASH_NON_FNO',
      confidenceMultiplier: 0,
      allowedActions: ['WAIT'],
      notes: ['No orders 15:15-15:20', '±3% band vs reference'],
    };
  }

  // 15:20 - 15:25 (CAS Order Entry)
  if (minutes < c.casOrderEntry.end) {
    return {
      phase: 'CAS_ORDER_ENTRY',
      label: 'CAS Order Entry',
      description: 'Auction order entry. Indicative price live.',
      minutesRemaining: remaining(c.casOrderEntry.end),
      isCasActive: true,
      isDerivativesOpen: instrumentType !== 'CASH_NON_FNO',
      confidenceMultiplier: 0.2,
      allowedActions: ['WAIT'],
      notes: ['Market + limit orders', 'Indicative equilibrium price live'],
    };
  }

  // 15:25 - 15:30 (CAS Limit Only)
  if (minutes < c.casLimitOnly.end) {
    return {
      phase: 'CAS_LIMIT_ONLY',
      label: 'CAS Limit Only',
      description: 'Limit orders only. Random close 15:28-15:30.',
      minutesRemaining: remaining(c.casLimitOnly.end),
      isCasActive: true,
      isDerivativesOpen: instrumentType !== 'CASH_NON_FNO',
      confidenceMultiplier: 0.2,
      allowedActions: ['WAIT'],
      notes: ['Limit orders only', 'Random close 15:28-15:30'],
    };
  }

  // 15:30 - 15:35 (CAS Matching)
  if (minutes < c.casMatching.end) {
    return {
      phase: 'CAS_MATCHING',
      label: 'CAS Matching',
      description: 'Equilibrium price = official closing price.',
      minutesRemaining: remaining(c.casMatching.end),
      isCasActive: true,
      isDerivativesOpen: instrumentType !== 'CASH_NON_FNO',
      confidenceMultiplier: 0,
      allowedActions: ['WAIT'],
      notes: ['Equilibrium = closing price', 'Fallback: ref -> LTP -> prev close'],
    };
  }

  // 15:35 - 15:40 (Derivatives still open for INDEX/FNO_STOCK)
  if (minutes < c.derivativesOpen.end) {
    if (instrumentType === 'INDEX' || instrumentType === 'FNO_STOCK') {
      return {
        phase: 'DERIVATIVES_OPEN',
        label: 'Derivatives Extended',
        description: 'F&O trading continues until 15:40.',
        minutesRemaining: remaining(c.derivativesOpen.end),
        isCasActive: false,
        isDerivativesOpen: true,
        confidenceMultiplier: 0.3,
        allowedActions: ['WAIT'],
        notes: ['Manage exits carefully', 'Volatility spikes common'],
      };
    }
    return {
      phase: 'CLOSED',
      label: 'Market Closed',
      description: 'CAS complete. Stock closed.',
      minutesRemaining: 0,
      isCasActive: false,
      isDerivativesOpen: false,
      confidenceMultiplier: 0,
      allowedActions: ['WAIT'],
      notes: ['Closing price set by CAS'],
    };
  }

  // 15:40 - 15:50
  if (minutes < c.postClose.start) {
    return {
      phase: 'CLOSED',
      label: 'Market Closed',
      description: 'Derivatives closed. Post-close pending.',
      minutesRemaining: 0,
      isCasActive: false,
      isDerivativesOpen: false,
      confidenceMultiplier: 0,
      allowedActions: ['WAIT'],
      notes: ['Next session 09:15 IST'],
    };
  }

  // 15:50 - 16:00 (Post Close)
  if (minutes < c.postClose.end) {
    return {
      phase: 'POST_CLOSE',
      label: 'Post-Close',
      description: 'Cash trades at CAS/closing price.',
      minutesRemaining: remaining(c.postClose.end),
      isCasActive: false,
      isDerivativesOpen: false,
      confidenceMultiplier: 0,
      allowedActions: ['WAIT'],
      notes: ['Cash at closing price', 'No F&O positions'],
    };
  }

  return {
    phase: 'CLOSED',
    label: 'Market Closed',
    description: 'Market closed. Use EOD data for review.',
    minutesRemaining: 0,
    isCasActive: false,
    isDerivativesOpen: false,
    confidenceMultiplier: 0,
    allowedActions: ['WAIT'],
    notes: ['No live trading possible', 'Next session 09:15 IST'],
  };
}

// ─── Is Expiry Day Check ────────────────────────────────────────────
export function isExpiryDayForSymbol(
  symbol: string,
  date: Date = new Date()
): boolean {
  // This should integrate with expiry-calculator.ts
  // For now, return false - will integrate with existing expiry-calculator
  return false;
}

// ─── Get Config ─────────────────────────────────────────────────────
export function getSessionConfig(): MarketSessionConfig {
  return NSE_SESSION_CONFIG;
}