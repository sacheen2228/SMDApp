// ═══════════════════════════════════════════════════════════════════
// MODULE 4 — EXPIRY MODEL
// Weekly and Monthly expiries use SEPARATE projection logic.
//   Weekly: Mon / Tue / Wed / Thu(expiry) each behave independently.
//   Monthly: >10d / 5–10d / Last Week / Expiry Day each differ.
//
// Produces behaviour modifiers (slFactor, tpFactor, thetaDecay,
// projectionStyle) consumed by the Risk and TP engines. No TP/SL value
// is computed here — only the expiry-appropriate posture.
// ═══════════════════════════════════════════════════════════════════

import { ExpiryKind } from './types';

export type ProjectionStyle = 'SCALP' | 'SWING' | 'CARRY';

export interface ExpiryReport {
  kind: ExpiryKind;
  dayOfWeek: number;            // 0=Sun..6=Sat
  profile: string;              // e.g. WEEKLY_MONDAY
  slFactor: number;             // multiplier on base SL distance (tighter < 1)
  tpFactor: number;             // multiplier on premium-projection target
  thetaDecay: number;           // 0..1 erosion sensitivity (higher near expiry)
  holdHorizonDays: number;      // expected hold
  projectionStyle: ProjectionStyle;
  note: string;
}

export interface ExpiryInput {
  kind: ExpiryKind;
  dayOfWeek: number;            // 0..6
  dte: number;                  // days to expiry (>=1)
  isExpiryDay?: boolean;
}

export function analyzeExpiry(input: ExpiryInput): ExpiryReport {
  const { kind, dayOfWeek, dte } = input;
  const isExpiryDay = input.isExpiryDay ?? ((kind === 'WEEKLY' && dayOfWeek === 4) || dte <= 1);

  if (kind === 'WEEKLY') {
    // Weekly options expire Thursday (day 4).
    switch (dayOfWeek) {
      case 1: // Monday
        return {
          kind, dayOfWeek, profile: 'WEEKLY_MONDAY',
          slFactor: 1.0, tpFactor: 1.20, thetaDecay: 0.15, holdHorizonDays: 3,
          projectionStyle: 'CARRY',
          note: 'Fresh weekly — carry for multi-day directional move, wider stop.',
        };
      case 2: // Tuesday
        return {
          kind, dayOfWeek, profile: 'WEEKLY_TUESDAY',
          slFactor: 1.0, tpFactor: 1.10, thetaDecay: 0.30, holdHorizonDays: 2,
          projectionStyle: 'SWING',
          note: 'Mid-weekly — swing trade, moderate theta.',
        };
      case 3: // Wednesday
        return {
          kind, dayOfWeek, profile: 'WEEKLY_WEDNESDAY',
          slFactor: 0.90, tpFactor: 1.0, thetaDecay: 0.55, holdHorizonDays: 1,
          projectionStyle: 'SWING',
          note: 'Late-weekly — tighten stop, theta accelerating.',
        };
      case 4: // Thursday (expiry)
      default:
        return {
          kind, dayOfWeek, profile: 'WEEKLY_THURSDAY',
          slFactor: 0.75, tpFactor: 0.85, thetaDecay: 0.90, holdHorizonDays: 0,
          projectionStyle: 'SCALP',
          note: 'Expiry day — scalp only, tight stop, fast exit.',
        };
    }
  }

  // Monthly
  if (dte > 10) {
    return {
      kind, dayOfWeek, profile: 'MONTHLY_FAR',
      slFactor: 1.10, tpFactor: 1.30, thetaDecay: 0.05, holdHorizonDays: Math.min(15, dte),
      projectionStyle: 'CARRY',
      note: 'Far monthly — carry for larger structural move, widest stop.',
    };
  }
  if (dte > 4) {
    return {
      kind, dayOfWeek, profile: 'MONTHLY_MID',
      slFactor: 1.0, tpFactor: 1.15, thetaDecay: 0.30, holdHorizonDays: Math.min(8, dte),
      projectionStyle: 'SWING',
      note: 'Mid monthly — swing trade, balanced theta.',
    };
  }
  if (!isExpiryDay) {
    return {
      kind, dayOfWeek, profile: 'MONTHLY_LASTWEEK',
      slFactor: 0.90, tpFactor: 1.0, thetaDecay: 0.60, holdHorizonDays: Math.min(4, dte),
      projectionStyle: 'SWING',
      note: 'Last week of monthly — tighten stop, theta elevated.',
    };
  }
  return {
    kind, dayOfWeek, profile: 'MONTHLY_EXPIRY',
    slFactor: 0.70, tpFactor: 0.80, thetaDecay: 0.95, holdHorizonDays: 0,
    projectionStyle: 'SCALP',
    note: 'Monthly expiry day — scalp only, very tight stop.',
  };
}
