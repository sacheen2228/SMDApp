// ═══════════════════════════════════════════════════════════════════
// MODULE 6 — SESSION ENGINE
// Classifies the trading session phase from day-of-week + hour (IST).
// Drives posture: avoid fresh entries into illiquid closing minutes, etc.
// ═══════════════════════════════════════════════════════════════════

export type SessionPhase =
  | 'PRE_OPEN' | 'OPENING' | 'MORNING_RANGE' | 'MIDDAY'
  | 'LONDON_CLOSE' | 'POWER_HOUR' | 'CLOSING' | 'CLOSED';

export interface SessionReport {
  phase: SessionPhase;
  isActive: boolean;
  note: string;
}

export function classifySession(dayOfWeek: number, hour: number, minute = 0): SessionReport {
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return { phase: 'CLOSED', isActive: false, note: 'Weekend — market closed' };
  }
  const t = hour + minute / 60;
  if (t < 9.25) return { phase: 'PRE_OPEN', isActive: false, note: 'Pre-open' };
  if (t < 10) return { phase: 'OPENING', isActive: true, note: 'Opening drive — wide spreads' };
  if (t < 11.5) return { phase: 'MORNING_RANGE', isActive: true, note: 'Morning range' };
  if (t < 13) return { phase: 'MIDDAY', isActive: true, note: 'Midday lull' };
  if (t < 14.5) return { phase: 'LONDON_CLOSE', isActive: true, note: 'London close volatility' };
  if (t < 15.25) return { phase: 'POWER_HOUR', isActive: true, note: 'Power hour — best liquidity' };
  if (t <= 15.5) return { phase: 'CLOSING', isActive: true, note: 'Closing — avoid fresh entries' };
  return { phase: 'CLOSED', isActive: false, note: 'After hours' };
}
