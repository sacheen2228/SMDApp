// lib/atm-straddle-range.ts
//
// ATM Straddle Range Engine
// ───────────────────────────────────────────────────────────────────
// The simplest, most robust expected-move estimate: the cost of an ATM
// straddle equals the market's priced-in move for the expiry. We use it
// as the EXPECTED INTRADAY RANGE (not a buy/sell signal).
//
//   ExpectedMove = ATM_CE_LTP + ATM_PE_LTP
//   Support      = ATMStrike - ExpectedMove
//   Resistance   = ATMStrike + ExpectedMove
//
// Levels are recomputed on every option-chain refresh and a short history
// is kept so we can later evaluate how often the day's price action stayed
// inside the projected range (range-containment accuracy).
//
// This is intentionally separate from the richer Institutional Expected Move
// Engine (dynamic multipliers). The straddle range is the baseline; the
// institutional engine layers SMC/AI on top.

import { calculateVWAP } from "./ml-engine";

export interface StraddleChainInput {
  symbol: string;
  spot: number;
  atmStrike: number;
  // ATM leg premiums (already resolved from the chain by the caller)
  atmCE: number;
  atmPE: number;
  // Full chain (SDMOptionStrike[]-like): { strike, ce?, pe? } where each leg
  // has ltp, oi, oiChg, volume, iv, delta, gamma, vega, theta.
  chain: Array<{
    strike: number;
    ce?: { ltp: number; oi: number; oiChg: number; volume: number; iv: number; delta?: number; gamma?: number; vega?: number; theta?: number } | null;
    pe?: { ltp: number; oi: number; oiChg: number; volume: number; iv: number; delta?: number; gamma?: number; vega?: number; theta?: number } | null;
  }>;
  pcr: number;
  maxPain: number;
  iv: number; // India VIX or avg IV
  // Recent volume for the underlying (for breakout volume check)
  recentAvgVolume?: number;
  currentVolume?: number;
  candles?: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
}

export interface BreakoutCheck {
  direction: "bullish" | "bearish" | "none";
  confirmed: boolean;
  reasons: string[];
  failedReasons: string[];
}

export interface ATMStraddleRange {
  symbol: string;
  spot: number;
  atmStrike: number;
  cePremium: number;
  pePremium: number;
  combinedPremium: number; // ExpectedMove
  expectedMove: number; // == combinedPremium
  support: number;
  resistance: number;
  distanceFromSpot: number; // spot - atmStrike (signed)
  spotVsSupport: number; // spot - support
  spotVsResistance: number; // resistance - spot
  pcr: number;
  maxPain: number;
  iv: number;
  vwap: number;
  confidence: number; // 0-100
  confidenceBreakdown: {
    oi: number;
    iv: number;
    pcr: number;
    volume: number;
  };
  breakout: BreakoutCheck;
  generatedAt: string;
}

// ─── Confidence sub-scores (each 0-100) ──────────────────────────────
function oiConfidence(chain: StraddleChainInput["chain"], atmStrike: number): number {
  // Strong OI build-up near ATM (writes defending the range) tightens the
  // straddle's meaning. Sparse OI far from ATM → less reliable.
  const atm = chain.find((s) => s.strike === atmStrike);
  if (!atm) return 50;
  const callOI = atm.ce?.oi ?? 0;
  const putOI = atm.pe?.oi ?? 0;
  const totalOI = callOI + putOI;
  if (totalOI <= 0) return 40;
  // More OI at ATM = market is writing this strike → range is well-defined.
  // Normalize loosely against a typical liquid index (e.g. 1-5 lakh contracts).
  const score = Math.min(100, 30 + (totalOI / 500000) * 70);
  return Math.round(score);
}

function ivConfidence(iv: number): number {
  // IV too low → little premium → thin range signal. IV very high → event
  // risk / unreliable. Sweet spot ~10-22 (index VIX).
  if (!iv || iv <= 0) return 35;
  if (iv < 8) return 45;
  if (iv <= 22) return Math.round(70 + (iv - 8) * 1.4); // 8→~70, 22→~90
  if (iv <= 35) return Math.round(90 - (iv - 22) * 2.3); // 22→90, 35→~60
  return 40;
}

function pcrConfidence(pcr: number): number {
  // Healthy PCR 0.8-1.3 → high confidence the straddle range is meaningful.
  if (!pcr || pcr <= 0) return 40;
  if (pcr >= 0.8 && pcr <= 1.3) return 90;
  if (pcr < 0.8) return Math.round(90 - (0.8 - pcr) * 120); // below 0.8 falls fast
  // pcr > 1.3
  return Math.round(90 - (pcr - 1.3) * 80);
}

function volumeConfidence(current: number | undefined, avg: number | undefined): number {
  if (!current || !avg || avg <= 0) return 50;
  const ratio = current / avg;
  // Volume confirming participation (1.2x-3x) boosts confidence.
  if (ratio >= 1.2 && ratio <= 3) return 90;
  if (ratio > 3) return 75; // very high vol = possible event, slightly less clean
  if (ratio >= 0.7) return 65;
  return 45;
}

// ─── Breakout confirmation (the 4 rules) ─────────────────────────────
function checkBreakout(
  input: StraddleChainInput,
  range: { support: number; resistance: number; spot: number; vwap: number }
): BreakoutCheck {
  const reasons: string[] = [];
  const failedReasons: string[] = [];
  const atm = input.chain.find((s) => s.strike === input.atmStrike);

  // Rule 4: price must close beyond the level, not just wick (use candle close).
  const lastClose = input.candles?.length
    ? input.candles[input.candles.length - 1].close
    : input.spot;
  const beyondResistance = lastClose > range.resistance;
  const beyondSupport = lastClose < range.support;

  // Rule 1: volume > 1.5x recent average
  const volRatio =
    input.currentVolume && input.recentAvgVolume ? input.currentVolume / input.recentAvgVolume : 1;
  const volumeOk = volRatio > 1.5;
  volumeOk ? reasons.push(`Volume ${volRatio.toFixed(2)}x avg (>1.5x)`) : failedReasons.push(`Volume only ${volRatio.toFixed(2)}x avg (need >1.5x)`);

  // Rule 3: PCR within healthy 0.8-1.3
  const pcrOk = input.pcr >= 0.8 && input.pcr <= 1.3;
  pcrOk ? reasons.push(`PCR ${input.pcr.toFixed(2)} in 0.8-1.3`) : failedReasons.push(`PCR ${input.pcr.toFixed(2)} outside 0.8-1.3`);

  // Rule 2: OI supports the move
  let oiOk = true;
  let oiNote = "";
  if (atm) {
    const callOI = atm.ce?.oi ?? 0;
    const putOI = atm.pe?.oi ?? 0;
    if (beyondResistance) {
      // Bullish breakout: call unwinding (falling call OI) + put writing (rising put OI)
      const callUnwinding = (atm.ce?.oiChg ?? 0) < 0;
      const putWriting = (atm.pe?.oiChg ?? 0) > 0;
      oiOk = callUnwinding || putWriting;
      oiNote = `callOIΔ ${(atm.ce?.oiChg ?? 0).toFixed(0)}, putOIΔ ${(atm.pe?.oiChg ?? 0).toFixed(0)}`;
    } else if (beyondSupport) {
      // Bearish breakout: put unwinding + call writing
      const putUnwinding = (atm.pe?.oiChg ?? 0) < 0;
      const callWriting = (atm.ce?.oiChg ?? 0) > 0;
      oiOk = putUnwinding || callWriting;
      oiNote = `putOIΔ ${(atm.pe?.oiChg ?? 0).toFixed(0)}, callOIΔ ${(atm.ce?.oiChg ?? 0).toFixed(0)}`;
    }
  }
  oiOk ? reasons.push(`OI supports move ${oiNote}`) : failedReasons.push(`OI does not support move ${oiNote}`);

  // Rule 4
  const closedBeyond =
    beyondResistance || beyondSupport
      ? reasons.push(`Price closed beyond level (${lastClose.toFixed(2)})`)
      : failedReasons.push(`Price only wicking (close ${lastClose.toFixed(2)} inside range)`);

  const confirmed = (beyondResistance || beyondSupport) && volumeOk && pcrOk && oiOk;

  let direction: BreakoutCheck["direction"] = "none";
  if (beyondResistance) direction = "bullish";
  else if (beyondSupport) direction = "bearish";

  return { direction, confirmed, reasons, failedReasons };
}

// ─── Main entry ─────────────────────────────────────────────────────
export function computeATMStraddleRange(input: StraddleChainInput): ATMStraddleRange {
  const expectedMove = (input.atmCE || 0) + (input.atmPE || 0);
  const support = input.atmStrike - expectedMove;
  const resistance = input.atmStrike + expectedMove;

  const vwap = input.candles?.length ? calculateVWAP(input.candles as any) : input.spot;

  const conf = {
    oi: oiConfidence(input.chain, input.atmStrike),
    iv: ivConfidence(input.iv),
    pcr: pcrConfidence(input.pcr),
    volume: volumeConfidence(input.currentVolume, input.recentAvgVolume),
  };
  // Weighted: OI 30, IV 25, PCR 25, Volume 20
  const confidence = Math.round(
    conf.oi * 0.3 + conf.iv * 0.25 + conf.pcr * 0.25 + conf.volume * 0.2
  );

  const breakout = checkBreakout(input, { support, resistance, spot: input.spot, vwap });

  return {
    symbol: input.symbol,
    spot: input.spot,
    atmStrike: input.atmStrike,
    cePremium: input.atmCE || 0,
    pePremium: input.atmPE || 0,
    combinedPremium: expectedMove,
    expectedMove,
    expectedMovePct: input.spot ? (expectedMove / input.spot) * 100 : 0,
    support,
    resistance,
    rangeWidthPct: input.spot ? ((resistance - support) / input.spot) * 100 : 0,
    distanceFromSpot: input.spot - input.atmStrike,
    spotVsSupport: input.spot - support,
    spotVsResistance: resistance - input.spot,
    pcr: input.pcr,
    maxPain: input.maxPain,
    iv: input.iv,
    vwap,
    confidence,
    confidenceBreakdown: conf,
    breakout,
    generatedAt: new Date().toISOString(),
  };
}

// ─── ATM resolution helper (used by API/UI) ─────────────────────────
export function resolveATM(
  spot: number,
  chain: StraddleChainInput["chain"]
): { strike: number; ce: number; pe: number } | null {
  if (!chain.length) return null;
  let nearest = chain[0];
  let best = Math.abs(chain[0].strike - spot);
  for (const s of chain) {
    const d = Math.abs(s.strike - spot);
    if (d < best) {
      best = d;
      nearest = s;
    }
  }
  return {
    strike: nearest.strike,
    ce: nearest.ce?.ltp ?? 0,
    pe: nearest.pe?.ltp ?? 0,
  };
}

// ─── Range-containment history (accuracy tracking) ─────────────────
// Kept in-memory per process; the audit sidecar / DB is the durable store.
interface RangeSnapshot {
  symbol: string;
  at: string;
  spot: number;
  atmStrike: number;
  support: number;
  resistance: number;
  contained: boolean | null; // null until end-of-day evaluation
}

const history = new Map<string, RangeSnapshot[]>();

export function recordRangeSnapshot(r: ATMStraddleRange): void {
  const arr = history.get(r.symbol) ?? [];
  arr.push({
    symbol: r.symbol,
    at: r.generatedAt,
    spot: r.spot,
    atmStrike: r.atmStrike,
    support: r.support,
    resistance: r.resistance,
    contained: null,
  });
  // Keep last 500 snapshots per symbol
  if (arr.length > 500) arr.shift();
  history.set(r.symbol, arr);
}

export function evaluateContainment(symbol: string, dayClose: number): {
  contained: boolean;
  total: number;
  containedCount: number;
  accuracyPct: number;
} {
  const arr = history.get(symbol) ?? [];
  let containedCount = 0;
  for (const s of arr) {
    s.contained = dayClose >= s.support && dayClose <= s.resistance;
    if (s.contained) containedCount++;
  }
  const total = arr.length;
  return {
    contained: arr.length ? arr[arr.length - 1].contained ?? false : false,
    total,
    containedCount,
    accuracyPct: total ? Math.round((containedCount / total) * 100) : 0,
  };
}

export function getRangeHistory(symbol: string): RangeSnapshot[] {
  return history.get(symbol) ?? [];
}
