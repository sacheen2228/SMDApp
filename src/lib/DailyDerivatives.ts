// SDM App - Daily Derivatives Tab
// Uses canonical data-layer (NSE primary, BSE primary, MOAPI fallback, NO_DATA)
// Includes: India VIX, PCR, Max Pain, OI Walls, ATM Greeks, Signals, Sentiment

import { getOptionChain as canonicalGetOptionChain } from "@/lib/data-layer/chains/option-chain";
import { calculateGreeks, parseExpiryDateLoose, impliedVolFromPremium } from "@/lib/greeks";
import { getNSEIndiaVIX } from "@/lib/nse-api";
import { resolveVix } from "@/lib/live-option-chain";
import { computeCandleCvdProxy, type CvdProxyResult } from "@/engines/orderflow/orderflow-engine";
import { toIsoExpiryDate } from "@/lib/breeze-historical";
import { readFuturesFlow, istDateStr } from "@/lib/market/futures-flow";
import { getFuturesSnapshot } from "@/lib/motilal/market";
import { fetchCandlesWithFallback } from "@/lib/market/candle-chain";
import { buildOptionPlan, selectStrike, assessTargets, type TargetReach } from "@/lib/option-plan";
import { buildSellerIntel, type SellerIntelReport } from "@/lib/seller-intelligence";
import { getLotSizeStrict } from "@/lib/symbol-config";
import { getCurrentSession } from "@/lib/market-session";

// ====================== TYPES ======================
export interface Candle {
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Side = "LONG" | "SHORT";
export type SetupType = "CROSSOVER" | "PULLBACK" | "BREAKOUT" | "RETEST" | "FAKEOUT" | "REVERSAL";

export interface Signal {
  index: number;
  time: number | string;
  type: SetupType;
  side: Side;
  entry: number;
  stop: number;
  targets: number[];
  strength: number;
  reason: string;
}

export interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  /** Where delta came from: the provider's own greeks, our BS(IV) computation, or unknown. */
  deltaSource?: "provider" | "bs" | null;
}

/**
 * One tradeable plan row: strike + option type + entry/SL/TP ladder built by
 * the canonical `buildOptionPlan` (rupee risk, TP1 2R / TP2 3R / TP3 4R,
 * stop capped at 35% of premium, 0 lots = honest NO TRADE).
 */
export interface TradePlanCard {
  optionType: "CE" | "PE";
  strike: number;
  entry: number;
  stopLoss: number;
  targets: number[];
  rr: number;
  lots: number;
  deployed: number;
  riskAmount: number;
  tradable: boolean;
  otmSteps: number;
  reason: string;
  /** Current market premium — `entry` is the FROZEN plan anchor, this ticks. */
  livePremium?: number;
  /** Newest candle setup for this side (BREAKOUT/RETEST/… @ spot) — WHY this direction. */
  setup?: string;
  /** Per-target achievability vs OI walls (spot must break the wall to print). */
  targetReach?: TargetReach[];
}

/** One factor's directional vote — visible reasoning, never a hidden weight. */
export interface DirectionVote {
  factor: string;
  vote: "CALL" | "PUT" | "NEUTRAL";
  detail: string;
}

/** Aggregated directional verdict from the deterministic factor votes. */
export interface DirectionBias {
  side: "CALL" | "PUT" | "NEUTRAL";
  callVotes: number;
  putVotes: number;
  /** majority share of the CAST votes (0 when no side has any vote) */
  confidence: number;
  votes: DirectionVote[];
}

export interface OptionStrike {
  strike: number;
  call?: {
    ltp: number;
    oi: number;
    oiChange: number;
    volume: number;
    bid: number;
    ask: number;
    greeks?: Greeks;
  };
  put?: {
    ltp: number;
    oi: number;
    oiChange: number;
    volume: number;
    bid: number;
    ask: number;
    greeks?: Greeks;
  };
}

/**
 * Map the canonical chain's `ce`/`pe` legs to the card's `call`/`put` shape.
 *
 * The data layer already computes PER-LEG Greeks (the provider's own values,
 * or Black-Scholes from the provider's IV — `deriveLegGreeks`) and labels
 * which one it was. They are carried through here so the card shows the LIVE
 * chain's numbers instead of re-deriving one ATM row from the premium.
 * A leg without greeks stays WITHOUT greeks — never a fabricated zero.
 */
export function mapChainStrikes(strikes: any[]): OptionStrike[] {
  const num = (x: any): number | null =>
    x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x);

  const leg = (raw: any) => {
    if (!raw) return undefined;
    const delta = num(raw.delta);
    const gamma = num(raw.gamma);
    const theta = num(raw.theta);
    const vega = num(raw.vega);
    const iv = num(raw.iv);
    const hasGreeks = delta != null || gamma != null || theta != null || vega != null;
    return {
      ltp: Number(raw.ltp) || 0,
      oi: Number(raw.oi) || 0,
      oiChange: Number(raw.oiChange ?? raw.oiChg) || 0,
      volume: Number(raw.volume) || 0,
      bid: Number(raw.bid) || 0,
      ask: Number(raw.ask) || 0,
      greeks: hasGreeks
        ? {
            delta: delta ?? 0,
            gamma: gamma ?? 0,
            theta: theta ?? 0,
            vega: vega ?? 0,
            iv: iv ?? 0,
            deltaSource: raw.deltaSource ?? null,
          }
        : undefined,
    };
  };

  return (strikes || []).map((s: any) => ({
    strike: Number(s.strike),
    call: leg(s.ce),
    put: leg(s.pe),
  }));
}

/**
 * ATM IV for the card — ONE unit out: PERCENT.
 *
 * Two sources arrive in different units, and until now BOTH were scaled by
 * 100 at the report assembly:
 *   - the live chain's `greeks.iv` is already PERCENT (16.86 = 16.86%)
 *   - `impliedVolFromPremium` returns a DECIMAL (0.1686 = 16.86%)
 * Normalising here means the report never scales again — the 9797df9
 * regression printed 1686% / 1967% whenever the chain shipped greeks.
 * `atmGreeks.iv` is pinned to the same unit as the headline number.
 */
export function resolveAtmIv(input: {
  atm?: OptionStrike | null;
  spot: number;
  T: number;
}): { atmIV: number; atmGreeks?: Greeks; atmGreeksSource: "provider" | "bs" | "implied" | null } {
  const { atm, spot, T } = input;

  // Chain greeks win — the live market's own numbers, already percent.
  if (atm?.call?.greeks) {
    return {
      atmIV: atm.call.greeks.iv || 0,
      atmGreeks: { ...atm.call.greeks },
      atmGreeksSource: atm.call.greeks.deltaSource === "provider" ? "provider" : "bs",
    };
  }

  // No chain greeks → BS-from-premium estimate, scaled to percent exactly once.
  if (atm?.call?.ltp && spot > 0) {
    const ivDecimal = impliedVolFromPremium(atm.call.ltp, spot, atm.strike, T, true) || 0;
    if (ivDecimal > 0) {
      const atmIV = +(ivDecimal * 100).toFixed(4);
      return {
        atmIV,
        atmGreeks: { ...calculateGreeks(spot, atm.strike, T, ivDecimal, true), iv: atmIV },
        atmGreeksSource: "implied",
      };
    }
  }

  return { atmIV: 0, atmGreeksSource: null };
}

/** IST offset from UTC: +5:30 (no DST). */
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/** IST calendar-day number for an instant (epoch days, timezone-independent). */
function istDayNumber(d: Date): number {
  return Math.floor((d.getTime() + IST_OFFSET_MS) / 86400000);
}

/**
 * Days to expiry as a CALENDAR-date difference in IST.
 *
 * The old `Math.ceil((expiry - now) / 86400000)` rounded a 7.06-day gap up
 * to 8 for every moment before 15:30 IST (expiry's own stamp), reported 1 on
 * expiry day instead of 0, and inflated Black-Scholes `T` by up to a day —
 * 46% too much time on a 2-day SENSEX contract. Calendar-date difference is
 * the number platforms show and stays stable across the session.
 */
export function daysToExpiryFor(expiry: Date | null | undefined, now: Date = new Date()): number {
  if (!expiry || isNaN(expiry.getTime())) return 0;
  return Math.max(0, istDayNumber(expiry) - istDayNumber(now));
}

/**
 * The shared session module's verdict, flattened onto the report.
 *
 * Without it the card could only see `candleCount: 0` on a non-trading day
 * and rendered "Engine warming up — 0/30 bars" all day, when no candle could
 * ever arrive. Fails soft: an unreadable session must never break the report.
 */
export function marketSessionSnapshot(): {
  session: string;
  label: string;
  description: string;
  isMarketOpen: boolean;
} {
  try {
    const s = getCurrentSession();
    return {
      session: s.session,
      label: s.label,
      description: s.description,
      isMarketOpen: s.isMarketOpen === true,
    };
  } catch {
    return { session: "unknown", label: "Session unknown", description: "", isMarketOpen: false };
  }
}

export interface OptionChainSnapshot {
  underlying: "NIFTY" | "SENSEX";
  expiry: string;
  spot: number;
  timestamp: string;
  totalCallOI: number;
  totalPutOI: number;
  pcr: number;
  maxPain: number;
  callWall: number;
  putWall: number;
  atmStrike: number;
  strikes: OptionStrike[];
}

export interface DailyDerivativesReport {
  underlying: "NIFTY" | "SENSEX";
  timestamp: string;
  spot: number;
  indiaVix: number;
  indiaVixChange: number;
  /** True when NSE VIX was unreachable and the 15.70 fallback was used. */
  indiaVixEstimated?: boolean;
  pcr: number;
  maxPain: number;
  callWall: number;
  putWall: number;
  totalCallOI: number;
  totalPutOI: number;
  atmStrike: number;
  atmIV: number;
  atmGreeks?: Greeks;
  /** Where the ATM Greeks came from: the provider's own, the data layer's BS(IV), or the card's implied-premium fallback. */
  atmGreeksSource?: "provider" | "bs" | "implied" | null;
  /**
   * The LIVE chain's per-strike Greeks (CE/PE) — the values the data layer
   * computed (provider greeks, or Black-Scholes from the provider's IV).
   * A leg the chain could not price carries no entry — never a zero.
   */
  greeks?: { strike: number; ce?: Greeks; pe?: Greeks }[];
  /** True when the chain came from a fallback provider (not the primary one). */
  chainFallbackUsed?: boolean;
  /** The provider's own chain timestamp (when the contract was priced). */
  chainTimestamp?: string;
  /** Where the VIX number came from: the exchange, the chain's ATM IV, or the stated estimate. */
  indiaVixSource?: "nse" | "atm-iv" | "estimate";
  topCallOI: { strike: number; oi: number; oiChange: number }[];
  topPutOI: { strike: number; oi: number; oiChange: number }[];
  expiry: string;
  daysToExpiry: number;
  latestSignals: Signal[];
  sentiment: "Extreme Greed" | "Bullish" | "Neutral" | "Bearish" | "Extreme Fear";
  sentimentScore: number;
  tradePlans: TradePlanCard[];
  /** When the frozen SL/TP ladder was generated — levels don't tick. */
  planAsOf?: string;
  preferredSide: "CALL" | "PUT" | null;
  directionBias: DirectionBias;
  candleSource: string;
  candleInterval: string;
  candleDegraded: string | null;
  candleCount: number;
  warmupBars: number;
  /**
   * The shared session module's verdict — lets the UI say "market closed
   * (weekend or exchange holiday)" instead of "Engine warming up — 0/30 bars"
   * on a day when no candles can ever arrive.
   */
  marketSession?: {
    session: string;
    label: string;
    description: string;
    isMarketOpen: boolean;
  };
  dataSource: string;
  freshness: string;
  /** Seller Intelligence — OI classification, DEX/GEX, invalidation zones, verdict. */
  sellerIntel?: SellerIntelReport;
  /** CVD from the nearest futures contract (real traded volume) — context only, never a trade vote. */
  cvd?: CvdProxyResult;
  /**
   * Relative volume of the last CLOSED futures bar vs its prior 20-bar average
   * — the honest half of the fake-breakout test (rel-vol + ΔOI). Null when
   * there is not enough history; never a fake 1.0.
   */
  futuresRelVol?: {
    /** current / average — ≥2x = conviction bar. */
    ratio: number;
    average: number;
    current: number;
    barTime?: number | string;
  } | null;
  /** Degraded read when the intraday futures source is down (MOAPI day volume, no OI). */
  cvdFallback?: {
    source: "moapi";
    contract: string;
    dayVolume: number;
    openInterest: number | null;
    asOf: string;
    note: string;
  };
}

// ====================== INDICATOR (kept pure) ======================
export interface Config {
  fast: number;
  slow: number;
  adxPeriod: number;
  adxMin: number;
  adxMinCross: number;
  atrPeriod: number;
  breakoutLookback: number;
  breakoutBufferAtr: number;
  minEmaGapAtr: number;
  pullbackSlowToleranceAtr: number;
  retestWindow: number;
  retestToleranceAtr: number;
  fakeoutWindow: number;
  /** DI may lag the EMA cross by 1-2 bars — bars allowed to confirm it. */
  crossConfirmBars: number;
  /** Structure break often lags the flip — bars allowed to claim a REVERSAL. */
  reversalConfirmBars: number;
  /** Established-trend run length (bars) required before a reversal qualifies. */
  reversalMinRun: number;
  /** Bars defining a consolidation range ahead of a breakout. */
  consolLookback: number;
  /** Range ≤ this × ATR over consolLookback ⇒ consolidation breakout. */
  consolMaxAtr: number;
  /** Sweep must penetrate this × ATR past the level to count as a trap. */
  fakeoutMinSweepAtr: number;
  stopAtrMult: number;
  rrTargets: number[];
  cooldownBars: number;
}

export const DEFAULTS: Config = {
  fast: 9,
  slow: 15,
  adxPeriod: 14,
  adxMin: 20,
  // Crosses fire at trend inception while ADX is still ramping — measured on
  // real 5m NIFTY: 0/3 raw crosses cleared ADX≥20 (18.2/12.4/19.9 at the cross
  // bar). 15 admits the near-misses, still blocks deep chop.
  adxMinCross: 15,
  atrPeriod: 14,
  breakoutLookback: 20,
  breakoutBufferAtr: 0.1,
  minEmaGapAtr: 0.15,
  pullbackSlowToleranceAtr: 0.5,
  retestWindow: 10,
  retestToleranceAtr: 0.3,
  fakeoutWindow: 3,
  crossConfirmBars: 2,
  reversalConfirmBars: 4,
  reversalMinRun: 5,
  consolLookback: 10,
  consolMaxAtr: 2.0,
  fakeoutMinSweepAtr: 0.1,
  stopAtrMult: 1.5,
  rrTargets: [1, 2, 3],
  cooldownBars: 3,
};

// First index at which the engine can emit a signal — the loop starts at
// max(slow, adx*2, atr, lookback)+1 (29 with DEFAULTS), so index 29 is the
// earliest bar a setup can fire on.
export function firstSignalIndex(cfg: Partial<Config> = {}): number {
  const o = { ...DEFAULTS, ...cfg };
  return Math.max(o.slow, o.adxPeriod * 2, o.atrPeriod, o.breakoutLookback) + 1;
}

// Bars the engine needs before ANY setup can fire — the first signal index
// PLUS the signal bar itself (30 with DEFAULTS). A fresh session has only
// ~12 bars at 10:00, so the report walks back over prior trading days until
// this is met and the UI shows an honest "warming up" state.
export function warmupBars(cfg: Partial<Config> = {}): number {
  return firstSignalIndex(cfg) + 1;
}

// YYYY-MM-DD in IST — never toISOString() (UTC: a day off before 05:30 IST).
// Shared with the agent snapshot: src/lib/market/futures-flow.ts → istDateStr.
const istDate = istDateStr;

// Skip Sat/Sun so empty weekend fetches never pollute session-health.
function isWeekendIst(dateStr: string): boolean {
  const wd = new Date(dateStr + "T12:00:00Z").getUTCDay();
  return wd === 0 || wd === 6;
}

export function ema(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

export function atr(c: Candle[], period: number): number[] {
  const n = c.length;
  const out = new Array(n).fill(NaN);
  if (n < period) return out;
  const tr = c.map((x, i) =>
    i === 0
      ? x.high - x.low
      : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close))
  );
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  out[period - 1] = sum / period;
  for (let i = period; i < n; i++) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

export function adx(c: Candle[], p: number) {
  const n = c.length;
  const plusDI = new Array(n).fill(NaN);
  const minusDI = new Array(n).fill(NaN);
  const adxArr = new Array(n).fill(NaN);
  let trS = 0, pS = 0, mS = 0, dxSum = 0;

  for (let i = 1; i < n; i++) {
    const up = c[i].high - c[i - 1].high;
    const dn = c[i - 1].low - c[i].low;
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close)
    );

    if (i <= p) {
      trS += tr; pS += pdm; mS += mdm;
    } else {
      trS = trS - trS / p + tr;
      pS = pS - pS / p + pdm;
      mS = mS - mS / p + mdm;
    }

    if (i >= p && trS > 0) {
      const pdi = (100 * pS) / trS;
      const mdi = (100 * mS) / trS;
      plusDI[i] = pdi;
      minusDI[i] = mdi;
      const denom = pdi + mdi;
      const dx = denom === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / denom;

      if (i < 2 * p - 1) dxSum += dx;
      else if (i === 2 * p - 1) adxArr[i] = (dxSum + dx) / p;
      else adxArr[i] = (adxArr[i - 1] * (p - 1) + dx) / p;
    }
  }
  return { adx: adxArr, plusDI, minusDI };
}

export function emaCrossAdxAtr(candles: Candle[], cfg: Partial<Config> = {}) {
  const o: Config = { ...DEFAULTS, ...cfg };
  const closes = candles.map((x) => x.close);
  const emaFast = ema(closes, o.fast);
  const emaSlow = ema(closes, o.slow);
  const atrArr = atr(candles, o.atrPeriod);
  const { adx: adxArr, plusDI, minusDI } = adx(candles, o.adxPeriod);
  const trend: ("UP" | "DOWN" | "NONE")[] = new Array(candles.length).fill("NONE");
  const signals: Signal[] = [];
  const lastSignalBar = new Map<string, number>();
  let pending: any[] = [];

  const build = (i: number, type: SetupType, side: Side, entry: number, stop: number, reason: string): Signal => {
    const risk = Math.abs(entry - stop);
    const dir = side === "LONG" ? 1 : -1;
    const di = Math.abs(plusDI[i] - minusDI[i]);
    const strength = Math.max(0, Math.min(100, Math.round(adxArr[i] * 1.5 + di * 1.0)));
    return {
      index: i,
      time: candles[i].time,
      type, side, entry, stop,
      targets: o.rrTargets.map((r) => entry + dir * risk * r),
      strength,
      reason,
    };
  };

  const push = (s: Signal) => {
    const key = `${s.type}:${s.side}`;
    const last = lastSignalBar.get(key);
    if (last !== undefined && s.index - last <= o.cooldownBars) return;
    lastSignalBar.set(key, s.index);
    signals.push(s);
  };

  const start = firstSignalIndex(o);

  // ── Structure seeds: fractal swings + trend-run bookkeeping (REVERSAL) ──
  // A pivot at bar j is confirmed by bar j+1 — seed only pivots whose
  // confirming bar is still before the signal loop, then continue in-loop.
  let swingHigh = -Infinity;
  let swingLow = Infinity;
  for (let j = 2; j < start - 1 && j + 1 < candles.length; j++) {
    if (candles[j].high >= candles[j - 1].high && candles[j].high >= candles[j + 1].high)
      swingHigh = candles[j].high;
    if (candles[j].low <= candles[j - 1].low && candles[j].low <= candles[j + 1].low)
      swingLow = candles[j].low;
  }
  let runDir: "UP" | "DOWN" | "NONE" = "NONE";
  let runLen = 0;
  // One claim per EMA flip: REVERSAL (structure) outranks CROSSOVER (DI).
  let pendingFlip: { dir: "UP" | "DN"; index: number; priorRun: number } | null = null;

  for (let i = start; i < candles.length; i++) {
    const k = candles[i];
    const a = atrArr[i];
    const f = emaFast[i], s = emaSlow[i];
    const pf = emaFast[i - 1], ps = emaSlow[i - 1];
    if ([a, f, s, pf, ps, adxArr[i], adxArr[i - 1]].some(Number.isNaN)) continue;

    // Confirm the fractal pivot at i-2 (bars i-3..i-1 are historical).
    if (i >= 3) {
      if (candles[i - 2].high >= candles[i - 3].high && candles[i - 2].high >= candles[i - 1].high)
        swingHigh = candles[i - 2].high;
      if (candles[i - 2].low <= candles[i - 3].low && candles[i - 2].low <= candles[i - 1].low)
        swingLow = candles[i - 2].low;
    }

    const adxOk = adxArr[i] >= o.adxMin;
    const gapOk = Math.abs(f - s) >= o.minEmaGapAtr * a;
    const up = f > s;
    const dn = f < s;
    trend[i] = up ? "UP" : dn ? "DOWN" : "NONE";
    // Capture BEFORE this bar's run update — a flip's priorRun is the length
    // of the established trend being reversed.
    const priorRun = runLen;
    if (trend[i] === runDir) runLen++;
    else {
      runDir = trend[i];
      runLen = trend[i] === "NONE" ? 0 : 1;
    }
    const diBull = plusDI[i] > minusDI[i];
    const diBear = minusDI[i] > plusDI[i];
    // DI turning = one-bar directional confirmation (Wilder-smoothed DI often
    // needs several bars to fully cross after a violent turn).
    const diTurningBull = plusDI[i] > plusDI[i - 1] && minusDI[i] < minusDI[i - 1];
    const diTurningBear = minusDI[i] > minusDI[i - 1] && plusDI[i] < plusDI[i - 1];
    const bullBar = k.close > k.open;
    const bearBar = k.close < k.open;
    const stopDist = o.stopAtrMult * a;
    // Crossovers use the lower adxMinCross floor (see DEFAULTS) — a cross is a
    // one-shot event at trend start; ADX≥20 there systematically misses it.
    const adxOkCross = adxArr[i] >= o.adxMinCross;

    pending = pending.filter(p => i - p.index <= o.retestWindow);

    let hh = -Infinity, ll = Infinity;
    let ch = -Infinity, cl = Infinity;
    for (let j = i - o.breakoutLookback; j < i; j++) {
      hh = Math.max(hh, candles[j].high);
      ll = Math.min(ll, candles[j].low);
      if (j >= i - o.consolLookback) {
        ch = Math.max(ch, candles[j].high);
        cl = Math.min(cl, candles[j].low);
      }
    }
    const buf = o.breakoutBufferAtr * a;
    const expansion = k.high - k.low >= 0.8 * a;
    const inConsol = ch - cl <= o.consolMaxAtr * a;

    // ── 1. Breakout / breakdown — the rolling range edge IS the S/R level ──
    if (up && gapOk && adxOk && diBull && k.close > hh + buf && bullBar && expansion) {
      push(build(i, "BREAKOUT", "LONG", k.close, k.close - stopDist,
        inConsol ? `Consolidation breakout above ${hh.toFixed(0)}` : `Breakout above ${hh.toFixed(0)}`));
      pending.push({ side: "LONG", level: hh, index: i });
    } else if (dn && gapOk && adxOk && diBear && k.close < ll - buf && bearBar && expansion) {
      push(build(i, "BREAKOUT", "SHORT", k.close, k.close + stopDist,
        inConsol ? `Consolidation breakdown below ${ll.toFixed(0)}` : `Breakdown below ${ll.toFixed(0)}`));
      pending.push({ side: "SHORT", level: ll, index: i });
    }

    // ── 2. Breakout retest & confirmation — consumes the pending level ──
    const retestTol = o.retestToleranceAtr * a;
    for (const p of [...pending]) {
      if (i <= p.index) continue;
      if (p.side === "LONG" && up && adxOkCross && diBull &&
          k.low <= p.level + retestTol && k.close > p.level) {
        push(build(i, "RETEST", "LONG", k.close, Math.min(k.low, p.level) - 0.25 * a,
          `Retest of ${p.level.toFixed(0)} held as support`));
        pending = pending.filter(x => x !== p);
        break;
      }
      if (p.side === "SHORT" && dn && adxOkCross && diBear &&
          k.high >= p.level - retestTol && k.close < p.level) {
        push(build(i, "RETEST", "SHORT", k.close, Math.max(k.high, p.level) + 0.25 * a,
          `Retest of ${p.level.toFixed(0)} rejected as resistance`));
        pending = pending.filter(x => x !== p);
        break;
      }
    }

    // ── 3. Flip tracking — one claim per flip, REVERSAL outranks CROSSOVER ──
    const crossUp = pf <= ps && f > s;
    const crossDn = pf >= ps && f < s;
    if (crossUp) pendingFlip = { dir: "UP", index: i, priorRun };
    else if (crossDn) pendingFlip = { dir: "DN", index: i, priorRun };
    else if (pendingFlip) {
      const backAgainst =
        (pendingFlip.dir === "UP" && trend[i] === "DOWN") ||
        (pendingFlip.dir === "DN" && trend[i] === "UP");
      if (backAgainst || i - pendingFlip.index > o.reversalConfirmBars) pendingFlip = null;
    }

    // ── 4. REVERSAL: established run + EMA flip + structure break + DI ──
    if (pendingFlip && trend[i] !== "NONE" &&
        i - pendingFlip.index <= o.reversalConfirmBars &&
        pendingFlip.priorRun >= o.reversalMinRun) {
      if (pendingFlip.dir === "DN" && trend[i] === "DOWN" &&
          Number.isFinite(swingLow) && k.close < swingLow &&
          (diBear || diTurningBear)) {
        push(build(i, "REVERSAL", "SHORT", k.close, k.high + 0.5 * a,
          `Reversal: close < swing low ${swingLow.toFixed(0)} after ${pendingFlip.priorRun}-bar run`));
        pendingFlip = null;
      } else if (pendingFlip.dir === "UP" && trend[i] === "UP" &&
          Number.isFinite(swingHigh) && k.close > swingHigh &&
          (diBull || diTurningBull)) {
        push(build(i, "REVERSAL", "LONG", k.close, k.low - 0.5 * a,
          `Reversal: close > swing high ${swingHigh.toFixed(0)} after ${pendingFlip.priorRun}-bar run`));
        pendingFlip = null;
      }
    }

    // ── 5. CROSSOVER: the flip's DI confirmation (skipped if REVERSAL claimed) ──
    if (pendingFlip && i - pendingFlip.index <= o.crossConfirmBars) {
      if (pendingFlip.dir === "UP" && trend[i] === "UP" && diBull && adxOkCross) {
        push(build(i, "CROSSOVER", "LONG", k.close, k.close - stopDist, `EMA9 crossed above EMA15`));
        pendingFlip = null;
      } else if (pendingFlip.dir === "DN" && trend[i] === "DOWN" && diBear && adxOkCross) {
        push(build(i, "CROSSOVER", "SHORT", k.close, k.close + stopDist, `EMA9 crossed below EMA15`));
        pendingFlip = null;
      }
    }

    // ── 6. PULLBACK / EMA rejection — trend-continuation dip into the zone ──
    const slowTol = o.pullbackSlowToleranceAtr * a;
    const body = Math.abs(k.close - k.open);
    const lowerWick = Math.min(k.open, k.close) - k.low;
    const upperWick = k.high - Math.max(k.open, k.close);
    if (up && gapOk && adxOk && diBull && !crossUp &&
        k.low <= f && k.close > f && k.close > s && k.low >= s - slowTol && bullBar) {
      const rejection = body > 0 && lowerWick >= 2 * body;
      push(build(i, "PULLBACK", "LONG", k.close, Math.min(k.low, s) - 0.25 * a,
        rejection ? `EMA rejection — wick reclaimed ${f.toFixed(0)}` : `Pullback to EMA zone`));
    } else if (dn && gapOk && adxOk && diBear && !crossDn &&
        k.high >= f && k.close < f && k.close < s && k.high <= s + slowTol && bearBar) {
      const rejection = body > 0 && upperWick >= 2 * body;
      push(build(i, "PULLBACK", "SHORT", k.close, Math.max(k.high, s) + 0.25 * a,
        rejection ? `EMA rejection — wick reclaimed ${f.toFixed(0)}` : `Pullback to EMA zone`));
    }

    // ── 7. FAKEOUT: bull/bear trap — sweep of the range edge closing back inside ──
    if (k.high >= hh + o.fakeoutMinSweepAtr * a && k.close < hh && bearBar) {
      const lastBo = lastSignalBar.get("BREAKOUT:LONG");
      if (lastBo === undefined || i - lastBo > o.fakeoutWindow) {
        push(build(i, "FAKEOUT", "SHORT", k.close, k.high + 0.25 * a,
          `Bull trap: swept ${hh.toFixed(0)} and closed back inside`));
      }
    } else if (k.low <= ll - o.fakeoutMinSweepAtr * a && k.close > ll && bullBar) {
      const lastBo = lastSignalBar.get("BREAKOUT:SHORT");
      if (lastBo === undefined || i - lastBo > o.fakeoutWindow) {
        push(build(i, "FAKEOUT", "LONG", k.close, k.low - 0.25 * a,
          `Bear trap: swept ${ll.toFixed(0)} and closed back inside`));
      }
    }
  }

  return { signals, trend };
}

// ====================== TRADE-PLAN SNAPSHOT ======================
// Levels are ANCHORED to the entry at generation time and served for
// PLAN_TTL_MS (or until spot drifts / the selected strike changes) so SL/TP
// don't jump on every 5-min poll — only `refreshPlan: true` (manual Refresh)
// or a material market move rebuilds the ladder. `livePremium` on each card
// keeps the ticking market price visible next to the frozen plan.
const PLAN_TTL_MS = 10 * 60_000;
const PLAN_SPOT_DRIFT = 0.0015; // 0.15% — a material move rebuilds early

interface PlanSnapshot {
  at: number;
  spot: number;
  bySide: Partial<Record<"CALL" | "PUT", TradePlanCard>>;
}
const planSnapshots = new Map<string, PlanSnapshot>();

// ====================== CVD — FUTURES (REAL VOLUME) ======================
// Index SPOT candles carry no volume (Breeze index intraday → volume 0, NSE
// chart-databyindex → close-only), so the CVD proxy had nothing to sign. The
// nearest index FUTURES contract carries real traded volume (verified live on
// 2026-11-20: NIFTY 23-Nov-2026 NFO → 76 bars, 5,277,025 contracts), so the
// card reads the futures leg. Buy/sell attribution is still candle-signed —
// no aggressor-side tape exists for these indices.
//
// ONE implementation, shared with the Grok agent snapshot:
// src/lib/market/futures-flow.ts (readFuturesFlow) — do not fork a second
// futures reader.
// MOAPI fallback — DEGRADED on purpose. Live-verified 2026-11-20:
//   - MO has no intraday endpoint (EOD report endpoints only) → it can never
//     rebuild the 5m CVD curve.
//   - MO publishes no futures OI (getLTP openInterest = 0; the NSEFO dump has
//     no OI field) → ΔOI is unavailable, not zero.
//   - What it DOES give is the real day volume of the futures contract
//     (NIFTY 23-Nov-2026: 5,327,920) → shown as a labelled fallback read.
const FUTURES_SNAPSHOT_TTL_MS = 60_000;
const futuresSnapshotCache = new Map<string, { ts: number; snapshot: Awaited<ReturnType<typeof getFuturesSnapshot>> }>();

async function computeMoFuturesFallback(
  symbol: string,
  expiryLabel?: string,
): Promise<DailyDerivativesReport["cvdFallback"]> {
  const key = `${symbol}:${expiryLabel ?? ""}`;
  const hit = futuresSnapshotCache.get(key);
  if (hit && Date.now() - hit.ts < FUTURES_SNAPSHOT_TTL_MS) {
    if (!hit.snapshot) return undefined;
    return {
      source: "moapi",
      contract: hit.snapshot.contract,
      dayVolume: hit.snapshot.dayVolume,
      openInterest: hit.snapshot.openInterest,
      asOf: hit.snapshot.asOf,
      note: "Intraday futures feed unavailable — MOAPI publishes day volume only (no intraday series, no OI).",
    };
  }

  let snapshot: Awaited<ReturnType<typeof getFuturesSnapshot>> = null;
  try {
    snapshot = await getFuturesSnapshot(symbol, expiryLabel);
  } catch (e: any) {
    console.warn(`[DailyDerivatives] MO futures snapshot unavailable for ${symbol}:`, e?.message);
  }
  futuresSnapshotCache.set(key, { ts: Date.now(), snapshot });
  if (!snapshot) return undefined;

  return {
    source: "moapi",
    contract: snapshot.contract,
    dayVolume: snapshot.dayVolume,
    openInterest: snapshot.openInterest,
    asOf: snapshot.asOf,
    note: "Intraday futures feed unavailable — MOAPI publishes day volume only (no intraday series, no OI).",
  };
}

// ====================== MAIN SERVICE ======================
export class DailyDerivativesService {
  constructor() {}

  private getSentiment(vix: number, pcr: number): { sentiment: DailyDerivativesReport["sentiment"]; score: number } {
    let score = 50;

    if (vix < 13) score += 20;
    else if (vix < 15) score += 10;
    else if (vix > 20) score -= 15;
    else if (vix > 18) score -= 8;

    if (pcr > 1.2) score += 15;
    else if (pcr > 1.0) score += 8;
    else if (pcr < 0.7) score -= 15;
    else if (pcr < 0.85) score -= 8;

    score = Math.max(0, Math.min(100, score));

    let sentiment: DailyDerivativesReport["sentiment"] = "Neutral";
    if (score >= 75) sentiment = "Extreme Greed";
    else if (score >= 60) sentiment = "Bullish";
    else if (score <= 25) sentiment = "Extreme Fear";
    else if (score <= 40) sentiment = "Bearish";

    return { sentiment, score };
  }

  /**
   * Deterministic directional verdict — 5 factor votes, each visible.
   * No hidden weights, no network: everything comes from the chain,
   * the candle signals and the VIX already fetched for this report.
   */
  private computeDirectionBias(args: {
    spot: number;
    pcr: number;
    maxPain: number;
    topCallOI: { oiChange: number }[];
    topPutOI: { oiChange: number }[];
    latestSignals: Signal[];
    sentimentScore: number;
  }): DirectionBias {
    const votes: DirectionVote[] = [];

    // 1. PCR band — put-heavy OI is bullish demand, call-heavy is bearish
    votes.push(
      args.pcr > 1
        ? { factor: "PCR", vote: "CALL", detail: `PCR ${args.pcr.toFixed(2)} — put-heavy (bullish)` }
        : args.pcr < 0.85
          ? { factor: "PCR", vote: "PUT", detail: `PCR ${args.pcr.toFixed(2)} — call-heavy (bearish)` }
          : { factor: "PCR", vote: "NEUTRAL", detail: `PCR ${args.pcr.toFixed(2)} — balanced` }
    );

    // 2. Max-pain position — spot above pain = put writers defend (bull), below = call writers press (bear)
    votes.push(
      args.spot > args.maxPain
        ? { factor: "Max Pain", vote: "CALL", detail: `spot ${args.spot.toFixed(0)} above MP ${args.maxPain} — upward pin` }
        : args.spot < args.maxPain
          ? { factor: "Max Pain", vote: "PUT", detail: `spot ${args.spot.toFixed(0)} below MP ${args.maxPain} — downward pin` }
          : { factor: "Max Pain", vote: "NEUTRAL", detail: `spot at MP ${args.maxPain}` }
    );

    // 3. OI shifts — net put OI build near/below spot = support; net call OI build = resistance
    const netPut = args.topPutOI.reduce((a, t) => a + (t.oiChange || 0), 0);
    const netCall = args.topCallOI.reduce((a, t) => a + (t.oiChange || 0), 0);
    votes.push(
      netPut > netCall
        ? { factor: "OI Shift", vote: "CALL", detail: `put ΔOI +${netPut.toLocaleString("en-IN")} vs call ΔOI ${netCall >= 0 ? "+" : ""}${netCall.toLocaleString("en-IN")} — support building` }
        : netCall > netPut
          ? { factor: "OI Shift", vote: "PUT", detail: `call ΔOI +${netCall.toLocaleString("en-IN")} vs put ΔOI ${netPut >= 0 ? "+" : ""}${netPut.toLocaleString("en-IN")} — resistance building` }
          : { factor: "OI Shift", vote: "NEUTRAL", detail: "top-strike OI flat" }
    );

    // 4. Candle signals (EMA9/15 + ADX/ATR) — newest setup from TODAY's
    //    session only; a setup from a prior day must not vote on today's bias.
    const today = istDate(0);
    const last = args.latestSignals.find(
      (s) =>
        new Date(s.time).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) ===
        today
    );
    votes.push(
      !last
        ? { factor: "Candles", vote: "NEUTRAL", detail: "no fresh setups" }
        : last.side === "LONG"
          ? { factor: "Candles", vote: "CALL", detail: `${last.type} LONG @ ${last.entry.toFixed(0)} (strength ${last.strength})` }
          : { factor: "Candles", vote: "PUT", detail: `${last.type} SHORT @ ${last.entry.toFixed(0)} (strength ${last.strength})` }
    );

    // 5. Sentiment (VIX + PCR composite)
    votes.push(
      args.sentimentScore >= 60
        ? { factor: "Sentiment", vote: "CALL", detail: `score ${args.sentimentScore}/100` }
        : args.sentimentScore <= 40
          ? { factor: "Sentiment", vote: "PUT", detail: `score ${args.sentimentScore}/100` }
          : { factor: "Sentiment", vote: "NEUTRAL", detail: `score ${args.sentimentScore}/100` }
    );

    const callVotes = votes.filter(v => v.vote === "CALL").length;
    const putVotes = votes.filter(v => v.vote === "PUT").length;
    const cast = callVotes + putVotes;
    const side: DirectionBias["side"] =
      callVotes > putVotes ? "CALL" : putVotes > callVotes ? "PUT" : "NEUTRAL";
    const confidence = cast > 0 ? Math.round((Math.max(callVotes, putVotes) / cast) * 100) : 0;

    return { side, callVotes, putVotes, confidence, votes };
  }

  async getDailyDerivativesReport(params: {
    underlying: "NIFTY" | "SENSEX";
    expiryISO?: string;
    daysToExpiry?: number;
    interval?: "5minute" | "15minute" | "30minute";
    /** Rebuild the frozen trade-plan ladder immediately (manual Refresh). */
    refreshPlan?: boolean;
  }): Promise<DailyDerivativesReport> {
    const { underlying, expiryISO, interval = "5minute" } = params;

    // 1. Get option chain from canonical data layer (NSE/BSE/MOAPI)
    const chainResult = await canonicalGetOptionChain(underlying, expiryISO);
    
    if (!chainResult.data) {
      console.error(`[DailyDerivatives] Chain fetch failed:`, chainResult.fallbackReason);
      throw new Error(chainResult.fallbackReason || "Failed to fetch option chain");
    }

    const chain = chainResult.data;
    const spot = chain.spot || 0;

    // Days to expiry — from the chain's own contract date, falling back to the
    // caller-supplied value only when the chain carries no parseable expiry.
    const expiryDate = parseExpiryDateLoose(chain.expiry || expiryISO);
    const daysToExpiry = params.daysToExpiry ?? daysToExpiryFor(expiryDate);

    // 2. Candles via the live capture chain (Breeze → MO → NSE index-only).
    //    SENSEX is a BSE index — the chain reports that capability skip honestly;
    //    never substitutes a different instrument or timeframe.
    //    Walk back over prior trading days until the engine has its warmup
    //    bars — a fresh session has only ~12 bars at 10:00 while EMA15+ADX×2
    //    needs 30 (first signal index 29 + the signal bar), which is why
    //    signals used to stay empty until noon.
    //    Weekends are skipped so empty results never pollute session-health.
    const need = warmupBars();
    const byTs = new Map<string, Candle>();
    let candleSource = "";
    let candleInterval = "";
    let candleDegraded: string | null = null;
    for (let back = 0; back <= 4; back++) {
      const day = istDate(back);
      if (isWeekendIst(day)) continue;
      const dayResult = await fetchCandlesWithFallback(underlying, day, interval);
      if (dayResult.candles?.length && !candleSource) {
        candleSource = dayResult.source;
        candleInterval = dayResult.intervalLabel;
        candleDegraded = dayResult.degraded ?? null;
      }
      for (const c of dayResult.candles || []) {
        byTs.set(c.timestamp, {
          time: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        });
      }
      if (byTs.size >= need) break;
    }
    const candles: Candle[] = [...byTs.values()].sort((a, b) =>
      String(a.time).localeCompare(String(b.time))
    );
    if (!candleSource) candleSource = "none";

    // 3. Indicator Signals (if we have candles)
    let latestSignals: Signal[] = [];
    let allSignals: Signal[] = [];
    if (candles.length > 0) {
      const { signals } = emaCrossAdxAtr(candles, { adxMin: 20 });
      allSignals = signals;
      latestSignals = signals.slice(-5).reverse();
    }

    // 4. Process option chain data — map canonical ce/pe legs to call/put,
    //    KEEPING the live per-leg Greeks the data layer computed.
    const strikes: OptionStrike[] = mapChainStrikes(chain.strikes || []);
    let totalCallOI = 0, totalPutOI = 0;

    for (const s of strikes) {
      if (s.call) totalCallOI += s.call.oi || 0;
      if (s.put) totalPutOI += s.put.oi || 0;
    }

    const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

    // Max Pain
    const allStrikes = strikes.map(s => s.strike).sort((a, b) => a - b);
    let maxPain = allStrikes[0] || 0;
    let minPain = Infinity;
    for (const strike of allStrikes) {
      let pain = 0;
      for (const s of strikes) {
        if (s.call) pain += Math.max(0, strike - s.strike) * (s.call.oi || 0);
        if (s.put) pain += Math.max(0, s.strike - strike) * (s.put.oi || 0);
      }
      if (pain < minPain) {
        minPain = pain;
        maxPain = strike;
      }
    }

    // Walls
    let callWall = 0, putWall = 0, maxC = 0, maxP = 0;
    for (const s of strikes) {
      if (s.call && (s.call.oi || 0) > maxC) { maxC = s.call.oi || 0; callWall = s.strike; }
      if (s.put && (s.put.oi || 0) > maxP) { maxP = s.put.oi || 0; putWall = s.strike; }
    }

    // ATM Strike
    const atmStrike = allStrikes.reduce((prev, curr) =>
      Math.abs(curr - spot) < Math.abs(prev - spot) ? curr : prev, allStrikes[0] || 0
    );

    // ATM Greeks — the LIVE chain's own numbers first (the provider's greeks,
    // or the data layer's BS(IV) computation — it labels which). Only when the
    // chain carries none does the card fall back to its own BS-from-premium
    // estimate, and that fallback is labelled so the UI can say so.
    // `resolveAtmIv` owns the unit: percent out, never scaled twice.
    const atm = strikes.find(s => s.strike === atmStrike);
    const T = Math.max((daysToExpiry || 0) / 365, 0.002);
    const { atmIV, atmGreeks, atmGreeksSource } = resolveAtmIv({ atm, spot, T });

    // Top OI
    const topCallOI = strikes
      .filter(s => s.call)
      .sort((a, b) => (b.call?.oi || 0) - (a.call?.oi || 0))
      .slice(0, 5)
      .map(s => ({ strike: s.strike, oi: s.call!.oi || 0, oiChange: s.call!.oiChange || 0 }));

    const topPutOI = strikes
      .filter(s => s.put)
      .sort((a, b) => (b.put?.oi || 0) - (a.put?.oi || 0))
      .slice(0, 5)
      .map(s => ({ strike: s.strike, oi: s.put!.oi || 0, oiChange: s.put!.oiChange || 0 }));

    // India VIX — the SHARED live policy (resolveVix): the exchange's own
    // INDIA VIX first, then the chain's ATM IV (real provider data, not an
    // estimate), and only then the stated 15.70 assumption. The source is
    // labelled so the UI never presents a fallback as the exchange number.
    const vixData = await getNSEIndiaVIX().catch(() => null);
    const vixResolved = resolveVix(
      { indiaVIX: vixData?.value ?? null },
      strikes.map((s) => ({
        strike: s.strike,
        ce: s.call ? { iv: s.call.greeks?.iv ?? null } : null,
        pe: s.put ? { iv: s.put.greeks?.iv ?? null } : null,
      })),
      spot,
    );
    const indiaVixSource: "nse" | "atm-iv" | "estimate" =
      vixData?.value != null ? "nse" : vixResolved.vix != null ? "atm-iv" : "estimate";
    const indiaVixEstimated = indiaVixSource !== "nse";
    const indiaVix = vixResolved.vix ?? 15.70;
    const indiaVixChange = vixData?.change ?? 0;

    const { sentiment, score } = this.getSentiment(indiaVix, pcr);

    // Directional verdict — 5 visible factor votes (PCR, max pain, OI shifts,
    // candle signals, sentiment). The ★ follows the majority; a split or
    // vote-less tape shows NO EDGE honestly instead of a coin-flip pick.
    const directionBias = this.computeDirectionBias({
      spot, pcr, maxPain, topCallOI, topPutOI, latestSignals, sentimentScore: score,
    });
    const preferredSide: "CALL" | "PUT" | null =
      directionBias.side === "NEUTRAL" ? null : directionBias.side;

    const tradePlans: TradePlanCard[] = [];
    const lotSize = getLotSizeStrict(underlying);
    let planAsOf: string | undefined;
    if (lotSize && spot > 0) {
      const chainRows = (chain.strikes || []).map((s: any) => ({
        strike: Number(s.strike),
        ce: s.ce,
        pe: s.pe,
      }));
      const selBySide = {
        CALL: selectStrike({ chain: chainRows, direction: "CALL", spot, lotSize }),
        PUT: selectStrike({ chain: chainRows, direction: "PUT", spot, lotSize }),
      };

      const buildCard = (sel: NonNullable<typeof selBySide.CALL>): TradePlanCard => {
        const plan = buildOptionPlan({
          symbol: underlying,
          optionType: sel.optionType,
          entryPremium: sel.entry,
          lotSize,
        });
        // The canonical engine flags `rr < minOptionRR` with raw float math —
        // a 1.9999999999999982 rounds to the 2.00 gate and would print a
        // false "will be blocked" warning. Drop that note when it rounds clean.
        const cleanNotes = (plan?.notes ?? []).filter(
          n => !(n.includes("below the gate's") && Math.round((plan?.rr ?? 0) * 100) / 100 >= 2)
        );
        // Newest candle setup for THIS side — why the direction has a tailwind
        // (same today-only rule the Candles bias vote uses).
        const wantSide = sel.optionType === "PE" ? "SHORT" : "LONG";
        const setupSig = latestSignals.find(
          s => s.side === wantSide &&
            new Date(s.time).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) === istDate(0)
        );
        const setup = setupSig
          ? `${setupSig.type} ${setupSig.side} @ ${setupSig.entry.toFixed(0)} (${setupSig.strength})`
          : undefined;
        // TP achievability: map each R-target to the spot it needs (delta) and
        // check the opposing OI ladder for a wall in that path.
        const reachDelta = sel.delta ??
          (atmGreeks ? (sel.optionType === "CE" ? atmGreeks.delta : atmGreeks.delta - 1) : null);
        const targetReach = assessTargets({
          optionType: sel.optionType,
          spot,
          entry: plan ? plan.entry : sel.entry,
          targets: plan?.targets ?? [],
          delta: reachDelta,
          deltaEstimated: sel.delta == null,
          chain: chainRows,
        });
        const blocked = targetReach.filter(t => !t.achievable).map(t => t.note).filter(Boolean);
        return {
          optionType: sel.optionType,
          strike: sel.strike,
          entry: plan ? plan.entry : sel.entry,
          stopLoss: plan?.stopLoss ?? 0,
          targets: plan?.targets ?? [],
          rr: plan?.rr ?? 0,
          lots: plan?.lots ?? 0,
          deployed: plan?.deployed ?? 0,
          riskAmount: plan?.riskAmount ?? 0,
          tradable: !!plan?.tradable,
          otmSteps: sel.otmSteps,
          livePremium: sel.entry,
          setup,
          targetReach,
          reason: plan
            ? `${sel.reason}${cleanNotes.length ? ` — ${cleanNotes.join(" · ")}` : ""}${blocked.length ? ` — ${blocked.join(" · ")}` : ""}`
            : `${sel.reason} — no valid SL/TP ladder`,
        };
      };

      const cached = planSnapshots.get(underlying);
      const ttlOk = !!cached && Date.now() - cached.at < PLAN_TTL_MS;
      const drift = cached && cached.spot > 0 ? Math.abs(spot - cached.spot) / cached.spot : Infinity;
      const driftOk = drift <= PLAN_SPOT_DRIFT;
      // Reuse only while every present side keeps its selected strike; a
      // side that appears fresh (was absent) forces a coherent rebuild.
      const strikesMatch =
        !!cached &&
        (["CALL", "PUT"] as const).every((d) => {
          const frozen = cached.bySide[d];
          const sel = selBySide[d];
          if (!frozen) return !sel;
          if (!sel) return true; // frozen survives a momentarily thin chain
          return sel.strike === frozen.strike;
        });
      const fmtPlanTime = (ms: number) =>
        new Date(ms).toLocaleTimeString("en-IN", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });

      if (!params.refreshPlan && cached && ttlOk && driftOk && strikesMatch) {
        // Frozen ladder — entry/SL/TP stay put; only the live premium ticks.
        planAsOf = fmtPlanTime(cached.at);
        for (const direction of ["CALL", "PUT"] as const) {
          const frozen = cached.bySide[direction];
          if (!frozen) continue;
          const sel = selBySide[direction];
          tradePlans.push(sel ? { ...frozen, livePremium: sel.entry } : frozen);
        }
      } else {
        const bySide: PlanSnapshot["bySide"] = {};
        for (const direction of ["CALL", "PUT"] as const) {
          const sel = selBySide[direction];
          if (!sel) continue;
          const card = buildCard(sel);
          bySide[direction] = card;
          tradePlans.push(card);
        }
        planSnapshots.set(underlying, { at: Date.now(), spot, bySide });
        planAsOf = fmtPlanTime(Date.now());
      }
      // Preferred side first (neutral bias → no preferred side → keep order)
      tradePlans.sort((a, b) => {
        if (preferredSide == null) return 0;
        return (a.optionType === (preferredSide === "PUT" ? "PE" : "CE") ? 0 : 1) -
          (b.optionType === (preferredSide === "PUT" ? "PE" : "CE") ? 0 : 1);
      });
    }

    // Expiry info
    const expiry = chain.expiry || expiryISO || "";
    const dte = daysToExpiry || 0;

    // Seller Intelligence — same chain fetch, zero extra network. VWAP and
    // day-open come from today's candles; only today's signals confirm
    // breakout/retest (a yesterday breakout must not confirm today's entry).
    const todayStr = istDate(0);
    const isTodayCandle = (t: number | string) =>
      new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) === todayStr;
    const todayCandles = candles.filter(c => isTodayCandle(c.time));
    const futuresFlow = await readFuturesFlow(underlying, todayStr);
    const futuresCvd = futuresFlow.cvd ?? null;
    // Already computed by readFuturesFlow (same candles, zero extra network) —
    // the DD card used to drop it while the knowledge block told the desk to
    // use it as the honest fake-breakout test.
    const futuresRelVol = futuresFlow.relativeVolume
      ? {
          ratio: futuresFlow.relativeVolume.ratio,
          average: futuresFlow.relativeVolume.average,
          current: futuresFlow.relativeVolume.current,
          barTime: futuresFlow.relativeVolume.barTime,
        }
      : null;
    const cvd =
      futuresCvd ?? computeCandleCvdProxy(todayCandles, { windowBars: 3, source: candleSource || "none" });
    const cvdFallback = futuresCvd
      ? undefined
      : await computeMoFuturesFallback(underlying, toIsoExpiryDate(expiry) ?? undefined);
    let vwap = 0;
    if (todayCandles.length > 0) {
      let pv = 0;
      let vol = 0;
      for (const c of todayCandles) {
        const tp = (c.high + c.low + c.close) / 3;
        const v = c.volume || 0;
        pv += tp * v;
        vol += v;
      }
      vwap = vol > 0 ? pv / vol : todayCandles.reduce((s, c) => s + c.close, 0) / todayCandles.length;
    }
    const dayOpen = todayCandles[0]?.open ?? candles[0]?.open ?? spot;
    const todaysSignals = allSignals.filter(s => isTodayCandle(s.time));
    const sellerIntel: SellerIntelReport = buildSellerIntel({
      symbol: underlying,
      expiry,
      spot,
      lotSize: lotSize ?? 0,
      strikes: (chain.strikes || []).map((s: any) => ({
        strike: Number(s.strike),
        ce: s.ce,
        pe: s.pe,
      })),
      // No VWAP yet (pre-market / no volume) → fall back to spot so neither
      // above-nor-below passes and the verdict stays WAIT honestly.
      vwap: vwap > 0 ? vwap : spot,
      dayOpen,
      latestSignals: todaysSignals,
    });

    return {
      underlying,
      timestamp: new Date().toISOString(),
      spot,
      indiaVix,
      indiaVixChange,
      indiaVixEstimated,
      pcr: +pcr.toFixed(3),
      maxPain,
      callWall,
      putWall,
      totalCallOI,
      totalPutOI,
      atmStrike,
      // resolveAtmIv already returns PERCENT — never scale a second time.
      atmIV: +atmIV.toFixed(2),
      atmGreeks,
      topCallOI,
      topPutOI,
      expiry,
      daysToExpiry: dte,
      latestSignals,
      sentiment,
      sentimentScore: score,
      tradePlans,
      planAsOf,
      preferredSide,
      directionBias,
      candleSource,
      candleInterval,
      candleDegraded,
      candleCount: candles.length,
      warmupBars: need,
      marketSession: marketSessionSnapshot(),
      dataSource: chainResult.source || "canonical",
      freshness: chain.freshness || "UNKNOWN",
      chainFallbackUsed: chainResult.fallbackUsed === true,
      // WHEN the chain was priced — the provider's own stamp first, then the
      // collection time. An undated payload stays undated.
      chainTimestamp: chain.asOf || chain.providerTimestamp || chain.timestamp || chain.fetchedAt || "",
      atmGreeksSource,
      indiaVixSource,
      greeks: strikes
        .filter((s) => s.call?.greeks || s.put?.greeks)
        .map((s) => ({ strike: s.strike, ce: s.call?.greeks, pe: s.put?.greeks })),
      sellerIntel,
      cvd,
      futuresRelVol,
      cvdFallback,
    };
  }

  formatDailyDerivativesReport(r: DailyDerivativesReport): string {
    return `
═══════════════════════════════════════════════════
          SDM DAILY DERIVATIVES REPORT
═══════════════════════════════════════════════════
Underlying     : ${r.underlying}
Spot           : ${r.spot.toFixed(2)}
Time           : ${new Date(r.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}

India VIX      : ${r.indiaVix.toFixed(2)}${r.indiaVixSource === "atm-iv" ? " (chain ATM IV — not the exchange number)" : r.indiaVixSource === "estimate" ? " (stated estimate)" : ""} (${r.indiaVixChange >= 0 ? "+" : ""}${r.indiaVixChange.toFixed(2)})
PCR            : ${r.pcr}
Max Pain       : ${r.maxPain}
Call Wall      : ${r.callWall}
Put Wall       : ${r.putWall}

ATM Strike     : ${r.atmStrike}
ATM IV         : ${r.atmIV}%
ATM Delta      : ${r.atmGreeks?.delta?.toFixed(3) || "-"}
ATM Theta      : ${r.atmGreeks?.theta?.toFixed(2) || "-"}

Sentiment      : ${r.sentiment} (Score: ${r.sentimentScore}/100)
Expiry         : ${r.expiry.split("T")[0]} (${r.daysToExpiry} days left)
Data Source    : ${r.dataSource} (${r.freshness})${r.chainFallbackUsed ? " [FALLBACK PROVIDER]" : ""}${r.chainTimestamp ? ` · priced ${r.chainTimestamp}` : ""}

── Top Call OI ──────────────────────────────
${r.topCallOI.map(t => `  ${t.strike} → OI: ${t.oi.toLocaleString()} | ΔOI: ${t.oiChange}`).join("\n")}

── Top Put OI ───────────────────────────────
${r.topPutOI.map(t => `  ${t.strike} → OI: ${t.oi.toLocaleString()} | ΔOI: ${t.oiChange}`).join("\n")}

── Latest Signals ───────────────────────────
${r.latestSignals.length === 0 ? "  No recent signals (candles not available)" :
  r.latestSignals.map(s => `  [${s.type}] ${s.side} @ ${s.entry.toFixed(0)} | Strength: ${s.strength}`).join("\n")}

── Trade Plans (SL/TP ladder, TP 2R/3R/4R) ──
Direction       : ${r.directionBias.side === "NEUTRAL" ? "NO EDGE" : `GO ${r.directionBias.side === "CALL" ? "CE" : "PE"}`} (${r.directionBias.callVotes} CE vs ${r.directionBias.putVotes} PE, ${r.directionBias.confidence}% conf)
${r.directionBias.votes.map(v => `  ${v.vote === "NEUTRAL" ? "·" : "✓"} [${v.factor}] ${v.vote} — ${v.detail}`).join("\n")}
${r.tradePlans.length === 0 ? "  No tradable contract found" :
  r.tradePlans.map(p => `  ${p.optionType} ${p.strike}${r.preferredSide != null && p.optionType === (r.preferredSide === "PUT" ? "PE" : "CE") ? " ★" : ""} | Entry: ${p.entry} | SL: ${p.stopLoss} | TP: ${p.targets.join(" / ") || "-"} | ${p.lots} lot${p.lots === 1 ? "" : "s"} ₹${Math.round(p.deployed).toLocaleString("en-IN")}${p.tradable ? "" : " — NOT TRADABLE"}`).join("\n")}
Futures RelVol  : ${r.futuresRelVol ? `${r.futuresRelVol.ratio.toFixed(2)}x (last closed bar vs 20-bar avg) — ${r.futuresRelVol.ratio >= 2 ? "conviction bar" : "context"}` : "unavailable (never a fabricated 1.0)"} · context only, never a trade vote
Candles         : ${r.candleCount} @ ${r.candleInterval} (${r.candleSource}${r.candleDegraded ? ` — ${r.candleDegraded}` : ""})${r.candleCount < r.warmupBars ? ` — warming up ${r.candleCount}/${r.warmupBars} bars` : ""}
═══════════════════════════════════════════════════
`;
  }
}

export default DailyDerivativesService;