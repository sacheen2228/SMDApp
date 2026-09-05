// MCX Commodity Module — Session Engine
// MCX trading hours: 9:00 AM - 11:30/11:55 PM IST (varies by commodity)
// DO NOT reuse NSE hours — MCX has completely different session structure

import type { MCXCommodity, MCXSessionState } from './types';
import { MCX_CONTRACT_SPECS } from './instrument-master';

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
}

// MCX session phases
const MCX_PHASES: Record<MCXSessionState, { start: number; end: number; description: string; confidence: number }> = {
  MCX_SESSION_CLOSED: { start: 0, end: 540, description: 'MCX Closed (Before 9:00 AM)', confidence: 0 },
  MCX_SESSION_PRE_OPEN: { start: 540, end: 540, description: 'MCX Pre-Market', confidence: 0.3 },
  MCX_SESSION_OPENING: { start: 540, end: 555, description: 'MCX Opening (9:00-9:15)', confidence: 0.5 },
  MCX_SESSION_DAY_ACTIVE: { start: 555, end: 1020, description: 'MCX Day Session (9:15-5:00 PM)', confidence: 0.8 },
  MCX_SESSION_EVENING_ACTIVE: { start: 1020, end: 1410, description: 'MCX Evening Session (5:00 PM-11:30 PM)', confidence: 0.7 },
  MCX_SESSION_CLOSING: { start: 1410, end: 1430, description: 'MCX Closing (11:30-11:50 PM)', confidence: 0.5 },
  MCX_SESSION_POST_CLOSE: { start: 1430, end: 1440, description: 'MCX Post-Close', confidence: 0 },
};

// Convert IST time to minutes since midnight
function toMinutesIST(date: Date): number {
  // Get IST time (UTC+5:30)
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
  const istMs = utcMs + 5.5 * 3600000;
  const istDate = new Date(istMs);
  return istDate.getHours() * 60 + istDate.getMinutes();
}

// ── Get current MCX session state ──
export function getMCXSession(symbol?: MCXCommodity): MCXSessionInfo {
  const now = new Date();
  const minutes = toMinutesIST(now);
  const day = now.getDay(); // 0=Sun, 6=Sat

  // Weekend check
  if (day === 0 || day === 6) {
    return {
      state: 'MCX_SESSION_CLOSED',
      isActive: false,
      isPreMarket: false,
      isDaySession: false,
      isEveningSession: false,
      minutesRemaining: 0,
      confidenceMultiplier: 0,
      allowedActions: [],
      description: 'MCX Closed (Weekend)',
    };
  }

  // Check commodity-specific end time
  const spec = symbol ? MCX_CONTRACT_SPECS[symbol] : null;
  const endTimeStr = spec?.tradingEndTime || '23:30';
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

  const allowedActions: string[] = [];
  if (isActive) {
    allowedActions.push('TRADE', 'SCANNER', 'LIVE_DATA');
  } else if (state === 'MCX_SESSION_OPENING') {
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
