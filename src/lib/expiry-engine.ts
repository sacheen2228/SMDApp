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

// NSE Weekly expiries: Thursdays (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY)
// NSE Monthly expiries: Last Thursday of month
// BSE SENSEX/BANKEX: Thursdays (weekly), Last Thursday (monthly)

const MONTHLY_EXPIRY_DAYS = ['THURSDAY']; // NSE monthly expiry day
const WEEKLY_EXPIRY_DAYS = ['THURSDAY'];  // NSE/BSE weekly expiry day

const HIGH_LIQUIDITY_INDICES = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY'];
const HIGH_LIQUIDITY_STOCKS = ['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN', 'BHARTIARTL', 'ITC', 'KOTAKBANK', 'LT', 'AXISBANK', 'HINDUNILVR', 'MARUTI', 'BAJFINANCE', 'ASIANPAINT'];

function getDayOfWeek(date: Date): string {
  const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  return days[date.getDay()];
}

function isMonthlyExpiry(date: Date): boolean {
  const day = getDayOfWeek(date);
  if (!MONTHLY_EXPIRY_DAYS.includes(day)) return false;
  
  // Last Thursday of month
  const nextWeek = new Date(date);
  nextWeek.setDate(date.getDate() + 7);
  return nextWeek.getMonth() !== date.getMonth();
}

function isWeeklyExpiry(date: Date): boolean {
  const day = getDayOfWeek(date);
  return WEEKLY_EXPIRY_DAYS.includes(day);
}

function isQuarterlyExpiry(date: Date): boolean {
  const month = date.getMonth() + 1;
  return [3, 6, 9, 12].includes(month) && isMonthlyExpiry(date);
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

function getExpiryType(date: Date): ExpiryType {
  if (isQuarterlyExpiry(date)) return 'QUARTERLY';
  if (isMonthlyExpiry(date)) return 'MONTHLY';
  if (isWeeklyExpiry(date)) return 'WEEKLY';
  return 'NON_EXPIRY';
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

  // Find next expiry date for this instrument
  const expiryDate = findNextExpiry(instrument, referenceDate);
  if (!expiryDate) return null;

  const daysToExpiry = Math.max(0, Math.ceil((expiryDate.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24)));
  const expiryType = getExpiryType(expiryDate);
  const isExpiryToday = daysToExpiry === 0;

  return {
    instrument,
    exchange,
    expiry_date: expiryDate.toISOString().split('T')[0],
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

function findNextExpiry(instrument: string, fromDate: Date): Date | null {
  const inst = getInstrument(instrument);
  if (!inst) return null;

  // For indices: weekly on Thursday, monthly last Thursday
  // For stocks: monthly last Thursday
  const isIndex = inst.type === 'INDEX';
  
  let checkDate = new Date(fromDate);
  checkDate.setHours(0, 0, 0, 0);

  // Check up to 60 days ahead
  for (let i = 0; i < 60; i++) {
    const day = getDayOfWeek(checkDate);
    
    if (isIndex) {
      // Index has weekly (Thursday) and monthly (last Thursday)
      if (day === 'THURSDAY') {
        if (isMonthlyExpiry(checkDate)) {
          return new Date(checkDate);
        }
        // Weekly expiry
        return new Date(checkDate);
      }
    } else {
      // Stock options: monthly expiry (last Thursday)
      if (day === 'THURSDAY' && isMonthlyExpiry(checkDate)) {
        return new Date(checkDate);
      }
    }
    
    checkDate.setDate(checkDate.getDate() + 1);
  }

  return null;
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

  const isIndex = inst.type === 'INDEX';
  const expiries: ExpiryData[] = [];
  
  let checkDate = new Date(referenceDate);
  checkDate.setHours(0, 0, 0, 0);

  for (let i = 0; i < 90; i++) {
    const day = getDayOfWeek(checkDate);
    
    if (isIndex) {
      if (day === 'THURSDAY') {
        const expiryType = getExpiryType(checkDate);
        const daysToExpiry = Math.max(0, Math.ceil((checkDate.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24)));
        
        expiries.push({
          instrument,
          exchange: inst.exchange,
          expiry_date: checkDate.toISOString().split('T')[0],
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
        });
      }
    } else {
      if (day === 'THURSDAY' && isMonthlyExpiry(checkDate)) {
        const expiryType = getExpiryType(checkDate);
        const daysToExpiry = Math.max(0, Math.ceil((checkDate.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24)));
        
        expiries.push({
          instrument,
          exchange: inst.exchange,
          expiry_date: checkDate.toISOString().split('T')[0],
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
        });
      }
    }
    
    checkDate.setDate(checkDate.getDate() + 1);
  }

  return expiries;
}