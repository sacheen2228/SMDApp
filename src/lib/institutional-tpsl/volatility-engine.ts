// ═══════════════════════════════════════════════════════════════════
// MODULE 2 — VOLATILITY ENGINE
// Estimates EXPECTED INDEX MOVEMENT from the UNDERLYING only.
//   • ATR is computed from underlying OHLC (never from option premiums).
//   • ATR is a forecast of index movement, NOT a stop or target.
//   • IV/VIX regime is classified (LOW / NORMAL / HIGH / EXTREME).
//   • Volatility Risk Premium (IV − realized) is exposed for context.
//
// Per the design: ATR must never directly determine TP. It feeds the
// expected-index-move, which the Premium Projection module consumes to
// translate into premium space — one factor among several.
// ═══════════════════════════════════════════════════════════════════

import { Candle } from './types';

export type IVRegime = 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';

export interface VolatilityReport {
  atr: number;                 // underlying daily ATR (index points)
  atrPct: number;              // atr / spot
  iv: number;                  // implied vol, percent
  vix: number;
  ivRegime: IVRegime;
  expectedIndexMove: number;   // index points over the trade horizon (dte)
  expectedIndexMovePct: number;
  volRiskPremium: number;      // IV% − realized% (positive = rich)
  source: 'candles' | 'provided' | 'iv-fallback';
  regimeLabel: string;
}

/** Simple ATR (SMA of true range). Underlying OHLC only. */
export function computeATR(candles: { high: number; low: number; close: number }[], period = 14): number {
  if (!candles || candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    trs.push(tr);
  }
  const n = Math.min(period, trs.length);
  if (n === 0) return 0;
  return trs.slice(-n).reduce((a, b) => a + b, 0) / n;
}

export function classifyIVRegime(ivPct: number, vix: number): IVRegime {
  const v = vix > 0 ? vix : ivPct;
  if (v < 11) return 'LOW';
  if (v < 17) return 'NORMAL';
  if (v < 25) return 'HIGH';
  return 'EXTREME';
}

export interface VolatilityInput {
  spot: number;
  dte: number;
  iv: number;                 // percent
  vix?: number;
  atr?: number;               // precomputed daily ATR (e.g. getDailyATR)
  underlyingDaily?: { high: number; low: number; close: number }[]; // raw daily candles
}

export function analyzeVolatility(input: VolatilityInput): VolatilityReport {
  const { spot, dte, iv, vix = 0 } = input;
  const ivPct = iv > 0 ? iv : (vix > 0 ? vix : 15);

  // ATR: provided → candles → IV-implied proxy
  let atr = 0;
  let source: VolatilityReport['source'] = 'iv-fallback';
  if (input.atr && input.atr > 0) {
    atr = input.atr;
    source = 'provided';
  } else if (input.underlyingDaily && input.underlyingDaily.length >= 15) {
    atr = computeATR(input.underlyingDaily, 14);
    source = 'candles';
  } else {
    atr = spot * (ivPct / 100) / Math.sqrt(252);
  }

  const atrPct = spot > 0 ? atr / spot : 0;
  const regime = classifyIVRegime(ivPct, vix);

  // Expected index move over the horizon = daily ATR scaled by √days.
  const horizon = Math.max(1, dte);
  const expectedIndexMove = atr * Math.sqrt(horizon);
  const expectedIndexMovePct = spot > 0 ? expectedIndexMove / spot : 0;

  // Realized vol (annualized) vs IV → volatility risk premium.
  const realizedPct = atrPct * Math.sqrt(252) * 100;
  const volRiskPremium = ivPct - realizedPct;

  return {
    atr, atrPct, iv: ivPct, vix,
    ivRegime: regime,
    expectedIndexMove,
    expectedIndexMovePct,
    volRiskPremium,
    source,
    regimeLabel: regime,
  };
}
