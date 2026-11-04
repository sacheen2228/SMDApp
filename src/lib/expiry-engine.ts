// DEPRECATED: superseded by getStandardizedExpiry() in src/lib/expiry-calculator.ts.
// Kept on disk until production consolidation is verified.

// Expiry Engine - Standardized expiry data for all instruments
// Provides expiry dates, types, and metadata for NSE/BSE derivatives

import { getInstrument } from '@/stores/useTerminalStore';

export type ExpiryType = 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'FAR_MONTH' | 'NON_EXPIRY';

export interface ExpiryData {
  instrument: string;
  exchange: 'NSE' | 'BSE';
  expiry_date: string;           // YYYY-MM-DD
  expiry_type: ExpiryType;
  days_to_expiry: number;
  is_expiry_today: boolean;
  is_monthly_expiry: boolean;
  is_weekly_expiry: boolean;
  is_quarterly_expiry: boolean;
  expiry_mode: 'ZERO_HERO' | 'STANDARD';
  option_liquidity: 'HIGH' | 'MEDIUM' | 'LOW';
  strategy_profile: 'EXPIRY' | 'NORMAL';
  session_type: 'EXPIRY' | 'REGULAR';
  lot_size: number;
  tick_size: number;
}

export interface ExpiryCalendar {
  [instrument: string]: ExpiryData[];
}

// The expiry CALENDAR lives in expiry-calculator (ONE source of truth):
// the exchange's own contract list when it is known, otherwise the SEBI
// weekday rules (NSE indices Tuesday / BSE Thursday, monthlies last of that
// weekday, holiday-shifted back to the previous trading day).
// This module keeps the terminal metadata (exchange, lot size, liquidity)
// and only reads the DATES from the calculator — it must never re-derive
// them (the old copy here assumed "Thursday for everything" and formatted
// the date with toISOString(), which is a day EARLY on an IST server).
import {
  getAllExpiries as getCalculatorExpiries,
  getNearestExpiry,
  type ExpiryType as CalculatorExpiryType,
} from './expiry-calculator';

const HIGH_LIQUIDITY_INDICES = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY'];
const HIGH_LIQUIDITY_STOCKS = ['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN', 'BHARTIARTL', 'ITC', 'KOTAKBANK', 'LT', 'AXISBANK', 'HINDUNILVR', 'MARUTI', 'BAJFINANCE', 'ASIANPAINT'];

/** LOCAL calendar date as YYYY-MM-DD (toISOString() is UTC — a day early). */
function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function isQuarterlyExpiry(date: Date): boolean {
  const month = date.getMonth() + 1;
  return [3, 6, 9, 12].includes(month);
}

function getLotSize(instrument: string): number {
  const inst = getInstrument(instrument);
  return inst?.lotSize || 75;
}

function getTickSize(instrument: string): number {
  // Most index options: 0.05, Stock options: 0.05
  return 0.05;
}

function getOptionLiquidity(instrument: string): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (HIGH_LIQUIDITY_INDICES.includes(instrument)) return 'HIGH';
  if (HIGH_LIQUIDITY_STOCKS.includes(instrument)) return 'HIGH';
  // Could add more logic based on OI/Volume
  return 'MEDIUM';
}

function getExpiryType(type: CalculatorExpiryType, date: Date): ExpiryType {
  if (type === 'monthly') return isQuarterlyExpiry(date) ? 'QUARTERLY' : 'MONTHLY';
  return 'WEEKLY';
}

function getStrategyProfile(expiryType: ExpiryType): 'EXPIRY' | 'NORMAL' {
  if (expiryType === 'WEEKLY' || expiryType === 'MONTHLY' || expiryType === 'QUARTERLY') {
    return 'EXPIRY';
  }
  return 'NORMAL';
}

function getExpiryMode(expiryType: ExpiryType): 'ZERO_HERO' | 'STANDARD' {
  if (expiryType === 'WEEKLY' || expiryType === 'MONTHLY') {
    return 'ZERO_HERO';
  }
  return 'STANDARD';
}

function getSessionType(expiryType: ExpiryType, daysToExpiry: number): 'EXPIRY' | 'REGULAR' {
  if (expiryType === 'WEEKLY' || expiryType === 'MONTHLY' || expiryType === 'QUARTERLY') {
    return 'EXPIRY';
  }
  return 'REGULAR';
}

export function getExpiryData(instrument: string, referenceDate: Date = new Date()): ExpiryData | null {
  const inst = getInstrument(instrument);
  if (!inst) return null;

  const exchange = inst.exchange;
  const lotSize = inst.lotSize;
  const tickSize = getTickSize(instrument);

  // The next contract the exchange serves for this instrument.
  const nearest = getNearestExpiry(instrument);
  if (!nearest) return null;

  const expiryDate = nearest.dateObj;
  const daysToExpiry = nearest.daysToExpiry;
  const expiryType = getExpiryType(nearest.type, expiryDate);
  const isExpiryToday = daysToExpiry === 0;

  return {
    instrument,
    exchange,
    expiry_date: toLocalIsoDate(expiryDate),
    expiry_type: expiryType,
    days_to_expiry: daysToExpiry,
    is_expiry_today: isExpiryToday,
    is_monthly_expiry: expiryType === 'MONTHLY' || expiryType === 'QUARTERLY',
    is_weekly_expiry: expiryType === 'WEEKLY',
    is_quarterly_expiry: expiryType === 'QUARTERLY',
    expiry_mode: getExpiryMode(expiryType),
    option_liquidity: getOptionLiquidity(instrument),
    strategy_profile: getStrategyProfile(expiryType),
    session_type: getSessionType(expiryType, daysToExpiry),
    lot_size: lotSize,
    tick_size: tickSize,
  };
}

export function getExpiryCalendar(instruments: string[], referenceDate: Date = new Date()): ExpiryCalendar {
  const calendar: ExpiryCalendar = {};
  
  for (const instrument of instruments) {
    const data = getExpiryData(instrument, referenceDate);
    if (data) {
      calendar[instrument] = [data];
    }
  }
  
  return calendar;
}

export function getAllExpiriesForInstrument(instrument: string, referenceDate: Date = new Date()): ExpiryData[] {
  const inst = getInstrument(instrument);
  if (!inst) return [];

  // The dates come from the calculator (exchange list / SEBI rules) — this
  // module only adds the terminal metadata.
  return getCalculatorExpiries(instrument).map((e) => {
    const expiryType = getExpiryType(e.type, e.dateObj);
    const daysToExpiry = e.daysToExpiry;
    return {
      instrument,
      exchange: inst.exchange,
      expiry_date: toLocalIsoDate(e.dateObj),
      expiry_type: expiryType,
      days_to_expiry: daysToExpiry,
      is_expiry_today: daysToExpiry === 0,
      is_monthly_expiry: expiryType === 'MONTHLY' || expiryType === 'QUARTERLY',
      is_weekly_expiry: expiryType === 'WEEKLY',
      is_quarterly_expiry: expiryType === 'QUARTERLY',
      expiry_mode: getExpiryMode(expiryType),
      option_liquidity: getOptionLiquidity(instrument),
      strategy_profile: getStrategyProfile(expiryType),
      session_type: getSessionType(expiryType, daysToExpiry),
      lot_size: inst.lotSize,
      tick_size: getTickSize(instrument),
    };
  });
}
