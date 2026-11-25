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
  /** Honest hold window from EMA / OI / greeks / stop (never a fabricated exit clock). */
  holdingTime?: string;
  /** Why that window — EMA trend, ΔOI, theta, stop geometry (UI tooltip). */
  holdingReasons?: string[];
  /** TAKE / WAIT / NO — deterministic per-card verdict (evaluatePlanTrade). */
  decision?: TradeDecision;
  /** Short badge label: "TAKE", "WAIT", "NO TRADE". */
  decisionLabel?: string;
  /** Why that verdict — every hard/soft check that fired (UI tooltip). */
  decisionReasons?: string[];
  /** Pro confluence: evidence GROUPS voting for this side / total cast. */
  confluenceAligned?: number;
  confluenceCast?: number;
  /** Book read for the selected leg — GOOD / WIDE / UNVERIFIED (no book = unverified). */
  liquidityState?: LiquidityState;
  /** % of mid — null when the book was missing (never invented). */
  liquiditySpreadPct?: number | null;
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
  /** Hysteresis status of the ★ — "pending" means an opposing vote is stacking, not yet flipped. */
  preferredStatus?: "confirmed" | "pending" | "none";
  /** Opposing side waiting to clear the flip gate (null when none). */
  preferredPending?: "CALL" | "PUT" | null;
  directionBias: DirectionBias;
  /**
   * Chop / sideways regime — live EMA whipsaw + ADX + range + RVOL.
   * `null` when candles are unavailable (never a fabricated "trending").
   */
  chopRegime?: ChopAssessment | null;
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

  return { signals, trend, lastBar: readLastEmaBar(candles, o) };
}

/**
 * Live EMA9/15 + ADX/ATR state at the last closed bar — the inputs the
 * hold-time calculator needs (trend side, strength, gap vs ATR).
 * null when the series is too short to have a valid last bar.
 */
export interface EmaBarState {
  trend: "UP" | "DOWN" | "NONE";
  adx: number;
  plusDI: number;
  minusDI: number;
  emaFast: number;
  emaSlow: number;
  atr: number;
  /** |fast − slow| / ATR — how expanded the cross is (0 = flat cross). */
  gapAtr: number;
}

function readLastEmaBar(candles: Candle[], o: Config): EmaBarState | null {
  const n = candles.length;
  if (n < 2) return null;
  const closes = candles.map((x) => x.close);
  const emaFast = ema(closes, o.fast);
  const emaSlow = ema(closes, o.slow);
  const atrArr = atr(candles, o.atrPeriod);
  const { adx: adxArr, plusDI, minusDI } = adx(candles, o.adxPeriod);
  const i = n - 1;
  const f = emaFast[i], s = emaSlow[i], a = atrArr[i];
  if ([f, s, a, adxArr[i]].some((x) => !Number.isFinite(x))) return null;
  const trend: EmaBarState["trend"] = f > s ? "UP" : f < s ? "DOWN" : "NONE";
  return {
    trend,
    adx: adxArr[i],
    plusDI: Number.isFinite(plusDI[i]) ? plusDI[i] : 0,
    minusDI: Number.isFinite(minusDI[i]) ? minusDI[i] : 0,
    emaFast: f,
    emaSlow: s,
    atr: a,
    gapAtr: a > 0 ? Math.abs(f - s) / a : 0,
  };
}

// ═══════════════════════════════════════════════════════════════════
// CHOP / SIDEWAYS REGIME — "don't get trapped in a range"
//
// Trend setups (breakout / pullback / retest) die in chop: EMA whipsaws
// stop you both ways while theta bleeds the premium. Deterministic pure
// score from the SAME candles the signal engine already read — no extra
// network. Hard conditions short-circuit; otherwise a 0-100 score ≥50
// marks the regime CHOP.
// ═══════════════════════════════════════════════════════════════════

export interface ChopAssessment {
  chop: boolean;
  /** 0-100 — higher = more range-bound. */
  score: number;
  /** Why (or why not) — UI tooltip + verdict reasons. */
  reasons: string[];
  /** Live last-bar vs avg volume (null when volume history unavailable). */
  rvol?: number | null;
}

/** EMA9/15 sign-flip count over the last `lookback` bars (whipsaw proxy). */
export function countEmaCrosses(
  candles: Candle[],
  lookback = 30,
  fast = 9,
  slow = 15,
): number {
  if (candles.length < Math.max(fast, slow) + 2) return 0;
  const closes = candles.map((c) => c.close);
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const start = Math.max(Math.max(fast, slow), candles.length - lookback);
  let crosses = 0;
  let prevSign = 0;
  for (let i = start; i < candles.length; i++) {
    const d = ef[i] - es[i];
    if (!Number.isFinite(d) || d === 0) continue;
    const sign = d > 0 ? 1 : -1;
    if (prevSign !== 0 && sign !== prevSign) crosses += 1;
    prevSign = sign;
  }
  return crosses;
}

/**
 * Last bar's volume ÷ the average of the prior `lookback` bars.
 * Null when history is too thin or the average is zero — never a fake 1.0.
 */
export function lastBarRvol(candles: Candle[], lookback = 20): number | null {
  if (candles.length < lookback + 1) return null;
  const last = candles[candles.length - 1].volume;
  if (!Number.isFinite(last) || last <= 0) return null;
  let sum = 0;
  let n = 0;
  for (let i = candles.length - 1 - lookback; i < candles.length - 1; i++) {
    const v = candles[i].volume;
    if (Number.isFinite(v) && v > 0) {
      sum += v;
      n += 1;
    }
  }
  if (n < Math.floor(lookback / 2)) return null;
  const avg = sum / n;
  return avg > 0 ? last / avg : null;
}

/**
 * Classify the tape as TRENDING / CHOP from EMA state + raw candles + live volume.
 *
 * Hard CHOP (any one):
 *   • ≥3 EMA crosses in 30 bars AND ADX < 22    (whipsaw with no trend)
 *   • ADX < 15 AND gapAtr < 0.15                (dead tape, flat cross)
 *   • trend NONE AND gapAtr < 0.10              (fast≈slow, no expansion)
 *   • RVOL < 0.50 AND ADX < 22                  (nobody trading + no trend)
 *
 * Otherwise score soft factors (ADX, gap, crosses, close-flips, range/ATR,
 * **live RVOL**) — score ≥ 50 = CHOP. Thin volume traps breakout attempts
 * in a range; a conviction bar (RVOL ≥1.5) is the expansion tell.
 */
export function assessChop(input: {
  ema?: EmaBarState | null;
  candles?: Candle[];
  lookback?: number;
  /** Last-bar relative volume — pass futures-flow RVOL or lastBarRvol(). */
  rvol?: number | null;
}): ChopAssessment {
  const ema = input.ema ?? null;
  const candles = input.candles ?? [];
  const lb = input.lookback ?? 30;
  const reasons: string[] = [];
  const rvol =
    input.rvol != null && Number.isFinite(input.rvol) ? input.rvol : null;

  const crosses = candles.length > 0 ? countEmaCrosses(candles, lb) : 0;
  const adx = ema?.adx ?? NaN;
  const gap = ema?.gapAtr ?? NaN;
  const trend = ema?.trend ?? null;

  // Close-to-close direction flip rate over the lookback (extra whipsaw cue).
  let flips = 0;
  const slice = candles.slice(-lb);
  for (let i = 1; i < slice.length; i++) {
    const a = slice[i - 1].close;
    const b = slice[i].close;
    if (a === b) continue;
    const dir = b > a ? 1 : -1;
    if (i >= 2) {
      const pa = slice[i - 2].close;
      const pdir = a > pa ? 1 : a < pa ? -1 : 0;
      if (pdir !== 0 && dir !== pdir) flips += 1;
    }
  }
  const flipRate = slice.length > 2 ? flips / (slice.length - 2) : 0;

  // Range compression: (max−min of highs/lows) over lookback ÷ ATR.
  let rangeAtr: number | null = null;
  if (slice.length >= 5 && ema && ema.atr > 0) {
    let hi = -Infinity;
    let lo = Infinity;
    for (const c of slice) {
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
    }
    rangeAtr = (hi - lo) / ema.atr;
  }

  // ── Hard CHOP short-circuits ──
  if (crosses >= 3 && Number.isFinite(adx) && adx < 22) {
    reasons.push(
      `${crosses} EMA9/15 crosses in ${lb} bars + ADX ${adx.toFixed(0)} < 22 — whipsaw, no trend`,
    );
    if (rvol != null) reasons.push(`RVOL ${rvol.toFixed(2)}x`);
    return { chop: true, score: Math.max(70, 50 + crosses * 5), reasons, rvol };
  }
  if (
    Number.isFinite(adx) && adx < 15 &&
    Number.isFinite(gap) && gap < 0.15
  ) {
    reasons.push(
      `ADX ${adx.toFixed(0)} < 15 + EMA gap ${gap.toFixed(2)}×ATR — dead tape`,
    );
    if (rvol != null) reasons.push(`RVOL ${rvol.toFixed(2)}x`);
    return { chop: true, score: 75, reasons, rvol };
  }
  if (trend === "NONE" && Number.isFinite(gap) && gap < 0.10) {
    reasons.push(
      `flat EMA cross (gap ${gap.toFixed(2)}×ATR) — no expansion, range-bound`,
    );
    if (rvol != null) reasons.push(`RVOL ${rvol.toFixed(2)}x`);
    return { chop: true, score: 70, reasons, rvol };
  }
  // Nobody in the tape + no trend = the classic sideways trap.
  if (rvol != null && rvol < 0.5 && Number.isFinite(adx) && adx < 22) {
    reasons.push(
      `RVOL ${rvol.toFixed(2)}x < 0.50 + ADX ${adx.toFixed(0)} < 22 — dead volume, no participants`,
    );
    return { chop: true, score: 80, reasons, rvol };
  }

  // ── Soft score ──
  let score = 0;
  if (Number.isFinite(adx)) {
    if (adx < 18) { score += 30; reasons.push(`ADX ${adx.toFixed(0)} < 18 — weak trend`); }
    else if (adx < 22) { score += 18; reasons.push(`ADX ${adx.toFixed(0)} < 22 — soft trend`); }
    else if (adx >= 28) { score -= 10; reasons.push(`ADX ${adx.toFixed(0)} ≥ 28 — trending`); }
  }
  if (Number.isFinite(gap)) {
    if (gap < 0.12) { score += 20; reasons.push(`EMA gap ${gap.toFixed(2)}×ATR — compressed`); }
    else if (gap < 0.2) { score += 10; reasons.push(`EMA gap ${gap.toFixed(2)}×ATR — tight`); }
    else if (gap >= 0.35) { score -= 10; reasons.push(`EMA gap ${gap.toFixed(2)}×ATR — expanded`); }
  }
  if (crosses >= 4) { score += 25; reasons.push(`${crosses} EMA crosses / ${lb} bars — heavy whipsaw`); }
  else if (crosses >= 3) { score += 15; reasons.push(`${crosses} EMA crosses / ${lb} bars`); }
  if (flipRate >= 0.55) { score += 15; reasons.push(`close flips ${(flipRate * 100).toFixed(0)}% of bars — two-way tape`); }
  else if (flipRate >= 0.4) { score += 8; reasons.push(`close flips ${(flipRate * 100).toFixed(0)}% of bars`); }
  if (rangeAtr != null) {
    if (rangeAtr < 3.5) { score += 20; reasons.push(`range ${rangeAtr.toFixed(1)}×ATR over ${lb} bars — boxed in`); }
    else if (rangeAtr < 5) { score += 10; reasons.push(`range ${rangeAtr.toFixed(1)}×ATR — modest swing`); }
    else if (rangeAtr >= 8) { score -= 10; reasons.push(`range ${rangeAtr.toFixed(1)}×ATR — wide trend walk`); }
  }
  if (trend === "NONE") { score += 10; reasons.push("EMA9/15 flat"); }

  // Live volume — the participation tell a range never shows in price alone.
  if (rvol != null) {
    if (rvol < 0.6) {
      score += 25;
      reasons.push(`RVOL ${rvol.toFixed(2)}x — dead volume, breakout attempts will fail`);
    } else if (rvol < 0.85) {
      score += 15;
      reasons.push(`RVOL ${rvol.toFixed(2)}x — thin tape, easy to get trapped`);
    } else if (rvol < 1.0) {
      score += 8;
      reasons.push(`RVOL ${rvol.toFixed(2)}x — below average participation`);
    } else if (rvol >= 1.5) {
      score -= 18;
      reasons.push(`RVOL ${rvol.toFixed(2)}x — conviction volume, expansion likely`);
    } else if (rvol >= 1.15) {
      score -= 8;
      reasons.push(`RVOL ${rvol.toFixed(2)}x — healthy participation`);
    }
  }

  score = Math.max(0, Math.min(100, score));
  const chop = score >= 50;
  if (!chop && reasons.length === 0) {
    reasons.push("no chop signature — expansion present");
  }
  if (chop) reasons.unshift(`chop score ${score}/100 — sideways regime`);
  else reasons.unshift(`chop score ${score}/100 — trending enough`);
  return { chop, score, reasons, rvol };
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

// ═══════════════════════════════════════════════════════════════════
// PREFERRED-SIDE HYSTERESIS — stop the ★ flipping PE↔CE every poll
//
// problem: directionBias is recomputed from live PCR / max-pain / OI /
// candles every refresh. A single OI-shift tick or a new candle setup
// flips the majority and the ★ JUMPS to the other card mid-session.
//
// rule (mirrors signal-persistence for the main SDM card):
//   • the FIRST directional vote confirms immediately (no cold-start wait);
//   • the SAME side keeps the ★ (no flicker);
//   • an OPPOSING side is only PENDING until it appears ≥2 consecutive
//     polls AND survives ≥2 minutes — only then does the ★ flip;
//   • NEUTRAL holds the confirmed side (a quiet tape must not clear the ★);
//   • symbols are independent (NIFTY ≠ SENSEX).
// ═══════════════════════════════════════════════════════════════════

export interface PreferredLock {
  confirmed: "CALL" | "PUT" | null;
  pending: "CALL" | "PUT" | null;
  pendingSince: number;
  pendingCount: number;
}

export interface PreferredSideResult {
  side: "CALL" | "PUT" | null;
  status: "confirmed" | "pending" | "none";
  pending: "CALL" | "PUT" | null;
}

const PREF_MIN_CONFIRMATIONS = 2;
const PREF_MIN_PERSIST_MS = 2 * 60_000;
const preferredLocks = new Map<string, PreferredLock>();

function blankPreferredLock(): PreferredLock {
  return { confirmed: null, pending: null, pendingSince: 0, pendingCount: 0 };
}

/**
 * Resolve the ★ side with flip-hysteresis. `raw` is the live majority
 * (null = NEUTRAL). Pure state machine — no network, no chain.
 */
export function resolvePreferredSide(
  symbol: string,
  raw: "CALL" | "PUT" | null,
  nowMs: number = Date.now(),
): PreferredSideResult {
  let lock = preferredLocks.get(symbol);
  if (!lock) {
    lock = blankPreferredLock();
    preferredLocks.set(symbol, lock);
  }

  // NEUTRAL holds the confirmed side — never clears the ★ on a quiet tape.
  if (raw == null) {
    lock.pending = null;
    lock.pendingCount = 0;
    if (lock.confirmed) {
      return { side: lock.confirmed, status: "confirmed", pending: null };
    }
    return { side: null, status: "none", pending: null };
  }

  // First directional vote confirms immediately (cold start).
  if (lock.confirmed == null) {
    lock.confirmed = raw;
    lock.pending = null;
    lock.pendingCount = 0;
    return { side: raw, status: "confirmed", pending: null };
  }

  // Same side as confirmed → keep it, clear any pending streak.
  if (raw === lock.confirmed) {
    lock.pending = null;
    lock.pendingCount = 0;
    return { side: lock.confirmed, status: "confirmed", pending: null };
  }

  // Opposing side — accumulate pending; flip only past count + persistence.
  if (lock.pending !== raw) {
    lock.pending = raw;
    lock.pendingSince = nowMs;
    lock.pendingCount = 1;
  } else {
    lock.pendingCount += 1;
  }

  const persistOk = nowMs - lock.pendingSince >= PREF_MIN_PERSIST_MS;
  const countOk = lock.pendingCount >= PREF_MIN_CONFIRMATIONS;
  if (persistOk && countOk) {
    lock.confirmed = raw;
    lock.pending = null;
    lock.pendingCount = 0;
    return { side: raw, status: "confirmed", pending: null };
  }

  return { side: lock.confirmed, status: "pending", pending: lock.pending };
}

/** Test hook — clear the per-symbol ★ locks. */
export function __resetPreferredLocksForTests(): void {
  preferredLocks.clear();
}

/** Test hook — clear frozen plan ladders. */
export function __resetPlanSnapshotsForTests(): void {
  planSnapshots.clear();
}

// ═══════════════════════════════════════════════════════════════════
// PLAN TRADE VERDICT — "should I take this trade?" on every card
//
// Deterministic pure function (no network, no clock). Fail-closed:
//   NO   — the ladder is untradable (0 lots, bad R:R, stop on wrong side)
//   WAIT — soft blockers (against ★ bias, TP1 walled, opposite seller vote)
//   TAKE — tradable + not soft-blocked (aligned or neutral bias, TP1 clear)
// Hold window stays a separate field — verdict answers ENTRY, hold answers EXIT.
// ═══════════════════════════════════════════════════════════════════

export type TradeDecision = "TAKE" | "WAIT" | "NO";

export interface PlanTradeInput {
  optionType: "CE" | "PE";
  tradable: boolean;
  lots: number;
  rr: number;
  entry: number;
  stopLoss: number;
  /** Confirmed ★ side (null = neutral / none). */
  preferredSide?: "CALL" | "PUT" | null;
  preferredStatus?: "confirmed" | "pending" | "none";
  /** Per-target wall reach from assessTargets. */
  targetReach?: TargetReach[];
  /** Seller Intelligence aggregate vote (BUY_CE / BUY_PE / WAIT). */
  sellerSignal?: "BUY_CE" | "BUY_PE" | "WAIT" | null;
  /** Market open — closed session can never be TAKE. */
  marketOpen?: boolean;
  /** Selected leg's live |delta| — lottery tickets wait. */
  delta?: number | null;
  /** Selected leg's θ/day — heavy decay shortens conviction. */
  theta?: number | null;
  /** Selected leg's ΔOI today — heavy unwinding waits. */
  oiChange?: number | null;
  /** Last-bar EMA9/15 state — trend against the option side waits. */
  ema?: EmaBarState | null;
  /** Futures/candle CVD verdict — opposing flow waits (context soft-vote). */
  cvdVerdict?: string | null;
  /** Chop/sideways regime — range-bound tape traps trend entries. */
  chop?: boolean;
  /** Chop score + reasons for the verdict tooltip. */
  chopAssessment?: ChopAssessment | null;
  /**
   * Seller Intelligence context (same chain fetch) — retest gate, dealer
   * GEX bias, net DEX, VWAP/breakout. Live fields only; nulls never block.
   */
  sellerCtx?: {
    requiresRetest?: boolean;
    entryConfirmed?: boolean;
    score?: number;
    direction?: string;
    dealerBias?: string;
    dealerRegime?: string;
    netDex?: number | null;
    gammaFlip?: number | null;
    spot?: number;
    vwap?: number | null;
    priceAboveVwap?: boolean | null;
    breakoutConfirmed?: boolean;
  } | null;
  /** Selected leg bid — liquidity gate (0/missing = no book → UNVERIFIED). */
  bid?: number | null;
  /** Selected leg ask — wide spread eats the edge before TP1. */
  ask?: number | null;
  /** Chain freshness (LIVE / FRESH / DELAYED / STALE) — decides if an unverified book blocks. */
  chainFreshness?: string | null;
}

export interface ConfluenceChannel {
  name: string;
  vote: "CALL" | "PUT";
}

/**
 * Evidence GROUP — correlated indicators collapse into ONE group.
 *
 * dealer GEX + net DEX + seller intel all come from the SAME chain snapshot;
 * EMA + VWAP are both price structure. Counting them as separate votes
 * overstated the evidence, so the gate counts groups, not indicators.
 */
export type EvidenceGroupName =
  | "Price structure"
  | "Options positioning"
  | "Order flow"
  | "Directional bias";

export interface ConfluenceGroup {
  name: EvidenceGroupName;
  /** The raw indicator votes inside this group (diagnostics / tooltip). */
  members: ConfluenceChannel[];
  /** The group's side — null when the group has no data or is conflicted. */
  vote: "CALL" | "PUT" | null;
  state: "ALIGNED" | "CONFLICTED" | "NO_DATA";
}

export interface ConfluenceResult {
  /** Evidence GROUPS voting FOR the option side. */
  aligned: number;
  /** Groups with any directional view (incl. conflicted — they cast, they do not align). */
  cast: number;
  groups: ConfluenceGroup[];
  /** Flat member votes (diagnostics only — never counted as separate evidence). */
  channels: ConfluenceChannel[];
  /** Pro gate: how many aligned groups are required. */
  required: number;
  pass: boolean;
}

/** Chain qualities that count as "a book should exist" for the liquidity gate. */
const LIVE_CHAIN_QUALITIES = new Set(["LIVE", "FRESH"]);

/** Pro gate: how many independent evidence groups must align before TAKE. */
export const REQUIRED_CONFLUENCE_GROUPS = 3;

/** Spread % of mid that is too wide to enter (exit cost eats TP1). */
export const MAX_SPREAD_PCT = 8;

export type LiquidityState = "GOOD" | "WIDE" | "UNVERIFIED";

export interface LiquidityRead {
  state: LiquidityState;
  /** % of mid — null when the book is missing (never invented). */
  spreadPct: number | null;
  bid: number | null;
  ask: number | null;
}

/**
 * What to do when the leg has NO book.
 *   "wait" — fail closed: an unverified book is not a tradable book.
 *   "warn" — reduced confidence: keep the verdict, flag the caveat.
 * A missing book is NEVER treated as good liquidity.
 */
export const LIQUIDITY_UNVERIFIED_POLICY: "wait" | "warn" = "wait";

/**
 * Liquidity read for one option leg.
 *
 * A missing / zero / crossed book is UNVERIFIED — no spread is invented and
 * the contract is never assumed liquid. Only a real book can be GOOD or WIDE.
 */
export function evaluateLegLiquidity(
  bid?: number | null,
  ask?: number | null,
): LiquidityRead {
  const b = typeof bid === "number" && Number.isFinite(bid) ? bid : null;
  const a = typeof ask === "number" && Number.isFinite(ask) ? ask : null;
  if (b == null || a == null || b <= 0 || a <= 0 || a <= b) {
    return { state: "UNVERIFIED", spreadPct: null, bid: b, ask: a };
  }
  const mid = (b + a) / 2;
  const spreadPct = ((a - b) / mid) * 100;
  return {
    state: spreadPct > MAX_SPREAD_PCT ? "WIDE" : "GOOD",
    spreadPct,
    bid: b,
    ask: a,
  };
}

const CONFLUENCE_GROUPS: Array<{ name: EvidenceGroupName; members: string[] }> = [
  { name: "Price structure", members: ["EMA", "VWAP"] },
  { name: "Options positioning", members: ["dealer GEX", "net DEX", "seller intel"] },
  { name: "Order flow", members: ["CVD"] },
  { name: "Directional bias", members: ["★ bias"] },
];

/**
 * Independent directional confirmations for the selected option side, counted
 * by EVIDENCE GROUP (not by raw indicator).
 *
 * Research gate (institutional options checklists): 3+ independent sources of
 * evidence must agree before entry. Correlated indicators are one source:
 *   - Price structure     — EMA9/15 trend + VWAP side
 *   - Options positioning — dealer GEX + net DEX + seller intel (one chain)
 *   - Order flow          — futures CVD
 *   - Directional bias    — the ★ bias
 * A group whose members disagree (GEX bearish vs net DEX positive) abstains:
 * conflicting evidence is not a vote. NEUTRAL / missing never votes.
 */
export function computeConfluence(input: PlanTradeInput): ConfluenceResult {
  const isCE = input.optionType === "CE";
  const side = isCE ? "CALL" : "PUT";
  const votes = new Map<string, "CALL" | "PUT">();

  const put = (name: string, vote: "CALL" | "PUT" | null) => {
    if (vote) votes.set(name, vote);
  };

  put("★ bias", input.preferredSide ?? null);

  const cvd = (input.cvdVerdict || "").toUpperCase();
  put(
    "CVD",
    cvd.includes("BULL") ? "CALL" : cvd.includes("BEAR") ? "PUT" : null,
  );

  const emaTrend = input.ema?.trend;
  put("EMA", emaTrend === "UP" ? "CALL" : emaTrend === "DOWN" ? "PUT" : null);

  put(
    "seller intel",
    input.sellerSignal === "BUY_CE"
      ? "CALL"
      : input.sellerSignal === "BUY_PE"
        ? "PUT"
        : null,
  );

  const dealer = (input.sellerCtx?.dealerBias || "").toUpperCase();
  put(
    "dealer GEX",
    dealer === "BULLISH" ? "CALL" : dealer === "BEARISH" ? "PUT" : null,
  );

  const sc = input.sellerCtx;
  if (sc?.priceAboveVwap != null && sc.vwap != null && sc.vwap > 0) {
    put("VWAP", sc.priceAboveVwap ? "CALL" : "PUT");
  }

  if (sc?.netDex != null && Number.isFinite(sc.netDex) && sc.netDex !== 0) {
    put("net DEX", sc.netDex > 0 ? "CALL" : "PUT");
  }

  const channels: ConfluenceChannel[] = [];
  const groups: ConfluenceGroup[] = [];

  for (const spec of CONFLUENCE_GROUPS) {
    const members: ConfluenceChannel[] = [];
    for (const name of spec.members) {
      const vote = votes.get(name);
      if (!vote) continue;
      members.push({ name, vote });
    }
    channels.push(...members);

    const sides = new Set(members.map((m) => m.vote));
    if (members.length === 0) {
      groups.push({ name: spec.name, members, vote: null, state: "NO_DATA" });
    } else if (sides.size > 1) {
      // Internal conflict — the group abstains instead of picking a side.
      groups.push({ name: spec.name, members, vote: null, state: "CONFLICTED" });
    } else {
      groups.push({
        name: spec.name,
        members,
        vote: members[0].vote,
        state: "ALIGNED",
      });
    }
  }

  const aligned = groups.filter((g) => g.vote === side).length;
  const cast = groups.filter((g) => g.state !== "NO_DATA").length;
  return {
    aligned,
    cast,
    groups,
    channels,
    required: REQUIRED_CONFLUENCE_GROUPS,
    pass: aligned >= REQUIRED_CONFLUENCE_GROUPS,
  };
}

export interface PlanTradeResult {
  decision: TradeDecision;
  label: string;
  reasons: string[];
  /** Present when the pro confluence gate ran (≥3-group check). */
  confluence?: ConfluenceResult;
  /** GOOD / WIDE / UNVERIFIED book read for the selected leg. */
  liquidity?: LiquidityRead;
}

export function evaluatePlanTrade(input: PlanTradeInput): PlanTradeResult {
  const reasons: string[] = [];
  const isCE = input.optionType === "CE";
  const side = isCE ? "CALL" : "PUT";

  // Evidence + liquidity are computed FIRST so every card exposes them —
  // including the hard-NO cards (the UI badge shows what the tape said).
  const confluence = computeConfluence(input);
  const liquidity = evaluateLegLiquidity(input.bid, input.ask);
  const chainIsLive = LIVE_CHAIN_QUALITIES.has(
    (input.chainFreshness || "").toUpperCase(),
  );

  // ── Hard NO — fail closed ──
  if (input.marketOpen === false) {
    reasons.push("market closed");
    return { decision: "NO", label: "NO TRADE", reasons, confluence, liquidity };
  }
  if (!input.tradable || input.lots < 1) {
    reasons.push(
      input.lots < 1 && input.entry > 0
        ? `0 lots — 1 lot costs more than the per-trade budget`
        : "no valid SL/TP ladder",
    );
    return { decision: "NO", label: "NO TRADE", reasons, confluence, liquidity };
  }
  if (!(input.rr >= 1.5)) {
    reasons.push(`R:R ${input.rr.toFixed(2)} < 1.5 gate`);
    return { decision: "NO", label: "NO TRADE", reasons, confluence, liquidity };
  }
  if (!(input.entry > 0) || !(input.stopLoss > 0)) {
    reasons.push("missing entry or stop");
    return { decision: "NO", label: "NO TRADE", reasons, confluence, liquidity };
  }
  // Stop must be on the correct side (long CE/PE: stop < entry).
  if (input.stopLoss >= input.entry) {
    reasons.push("stop not below entry");
    return { decision: "NO", label: "NO TRADE", reasons, confluence, liquidity };
  }

  // ── Soft WAIT — entry conditions not clean ──
  const wait: string[] = [];

  const preferred = input.preferredSide ?? null;
  const prefConfirmed = input.preferredStatus === "confirmed" || input.preferredStatus == null;
  if (preferred && prefConfirmed && preferred !== side) {
    wait.push(`against ★ ${preferred === "PUT" ? "PE" : "CE"} bias`);
  }
  if (
    input.preferredStatus === "pending" &&
    input.preferredSide &&
    preferred !== side
  ) {
    // This side is the pending challenger — wait for the ★ to flip.
    wait.push("★ still on the other side (pending)");
  }

  // TP1 walled shut — the first exit cannot print until the wall breaks.
  const reach = input.targetReach ?? [];
  const tp1 = reach[0];
  if (tp1 && !tp1.achievable) {
    wait.push(
      tp1.note
        ? `TP1 blocked — ${tp1.note}`
        : "TP1 blocked by OI wall",
    );
  } else if (reach.length > 0 && reach.every((t) => !t.achievable)) {
    wait.push("all TPs blocked by OI walls");
  }

  const seller = input.sellerSignal ?? null;
  if (seller === "BUY_CE" && !isCE) wait.push("seller intel votes BUY_CE");
  if (seller === "BUY_PE" && isCE) wait.push("seller intel votes BUY_PE");
  // seller "WAIT" is the DEFAULT when OI is mixed — it flips every poll and
  // must NOT block an otherwise-clean ladder (only a hard opposite vote does).

  // ── Greeks / EMA / leg-OI quality (same live inputs the hold window uses) ──
  const absDelta = input.delta != null && Number.isFinite(input.delta)
    ? Math.abs(input.delta)
    : null;
  if (absDelta != null && absDelta > 0 && absDelta < 0.3) {
    wait.push(`lottery delta ${absDelta.toFixed(2)} < 0.30 — OTM noise, not an edge`);
  }

  const ema = input.ema ?? null;
  if (ema) {
    const wantUp = isCE;
    const against =
      (wantUp && ema.trend === "DOWN") || (!wantUp && ema.trend === "UP");
    if (against) {
      wait.push(
        `EMA9/15 ${ema.trend} against ${isCE ? "CE" : "PE"} — trend opposes the long`,
      );
    }
  }

  const oiChg = input.oiChange;
  if (oiChg != null && Number.isFinite(oiChg) && oiChg <= -5000) {
    wait.push(
      `leg unwinding ΔOI ${Math.round(oiChg).toLocaleString("en-IN")} — sellers exiting this side`,
    );
  }

  // Heavy θ (≥4% of premium/day) erodes the ladder before TP1 — wait unless
  // the premium is tiny (absolute ₹/day on a cheap option is noise).
  const theta = input.theta;
  const entryPx = input.entry;
  if (
    theta != null &&
    Number.isFinite(theta) &&
    entryPx > 0 &&
    Math.abs(theta) / entryPx >= 0.04 &&
    entryPx >= 50
  ) {
    wait.push(
      `θ ${theta.toFixed(1)}/day = ${((Math.abs(theta) / entryPx) * 100).toFixed(1)}% of premium — decay outruns TP1`,
    );
  }

  // CVD soft-vote — opposing aggressive flow waits; neutral/unavailable never blocks.
  const cvd = (input.cvdVerdict || "").toUpperCase();
  const cvdBull = cvd === "BULLISH" || cvd === "BULLISH_DIVERGENCE";
  const cvdBear = cvd === "BEARISH" || cvd === "BEARISH_DIVERGENCE";
  if (isCE && cvdBear) wait.push(`CVD ${cvd} — flow against CE`);
  if (!isCE && cvdBull) wait.push(`CVD ${cvd} — flow against PE`);

  // Chop / sideways — trend setups get whipsawed both ways while θ bleeds.
  if (input.chop) {
    const top = input.chopAssessment?.reasons?.[0];
    wait.push(
      top && /chop/i.test(top)
        ? top
        : "chop / sideways regime — wait for expansion, don't fight the range",
    );
  }

  // ── Seller Intelligence context (DEX/GEX/VWAP/retest) ──
  const sc = input.sellerCtx ?? null;
  if (sc?.requiresRetest) {
    wait.push("seller intel AWAITING_RETEST — entry not confirmed yet");
  }
  const dealer = (sc?.dealerBias || "").toUpperCase();
  if (dealer === "BEARISH" && isCE) {
    wait.push(
      `dealer ${sc?.dealerRegime || ""} bias BEARISH — GEX flow against CE`.replace(/\s+/g, " "),
    );
  }
  if (dealer === "BULLISH" && !isCE) {
    wait.push(
      `dealer ${sc?.dealerRegime || ""} bias BULLISH — GEX flow against PE`.replace(/\s+/g, " "),
    );
  }
  // VWAP side-gate: long options prefer price above VWAP (CE) / below (PE).
  // Only when the read is available — a missing VWAP never blocks.
  if (sc?.priceAboveVwap != null && sc.vwap != null && sc.vwap > 0) {
    if (isCE && sc.priceAboveVwap === false) {
      wait.push(`price ${sc.spot?.toFixed(0)} below VWAP ${sc.vwap.toFixed(0)} — against CE`);
    }
    if (!isCE && sc.priceAboveVwap === true) {
      wait.push(`price ${sc.spot?.toFixed(0)} above VWAP ${sc.vwap.toFixed(0)} — against PE`);
    }
  }

  // ── Liquidity — a missing book is UNVERIFIED, never "good" ──
  if (liquidity.state === "WIDE") {
    wait.push(
      `spread ${liquidity.spreadPct!.toFixed(1)}% of mid > ${MAX_SPREAD_PCT}% — exit cost eats TP1`,
    );
  } else if (liquidity.state === "UNVERIFIED") {
    const note = chainIsLive
      ? "liquidity UNVERIFIED — no bid/ask book on a LIVE chain (spread not assumed)"
      : "liquidity UNVERIFIED — no bid/ask book (spread not assumed)";
    // On a LIVE chain a book must exist — its absence is a real blocker
    // (fail closed). On a non-live chain the session/freshness rules already
    // govern the verdict, so the caveat is recorded, never invented away.
    if (LIQUIDITY_UNVERIFIED_POLICY === "wait" && chainIsLive) {
      wait.push(note);
    } else {
      reasons.push(note);
    }
  }

  // ── Pro confluence gate — ≥3 independent evidence GROUPS must agree ──
  // Correlated indicators (GEX/DEX/seller, EMA/VWAP) count once. A group
  // whose members disagree abstains. Sparse tapes never fabricate a vote.
  if (!confluence.pass) {
    const need = confluence.required - confluence.aligned;
    wait.push(
      confluence.cast === 0
        ? "no evidence groups — need ≥3 independent evidence groups"
        : `confluence ${confluence.aligned}/${confluence.cast} groups — need ${need} more independent group${need === 1 ? "" : "s"} (pro gate ≥3 groups)`,
    );
  }

  if (wait.length > 0) {
    return {
      decision: "WAIT",
      label: "WAIT",
      reasons: [...reasons, ...wait],
      confluence,
      liquidity,
    };
  }

  // ── TAKE ──
  reasons.push("ladder valid · R:R ≥ 1.5 · stop below entry");
  reasons.push(
    `confluence ${confluence.aligned}/${confluence.cast} groups — pro gate ≥3 ✓`,
  );
  if (preferred && prefConfirmed && preferred === side) {
    reasons.push(`aligned with ★ ${side === "CALL" ? "CE" : "PE"} bias`);
  } else if (!preferred) {
    reasons.push("neutral bias — no ★ blocker");
  }
  if (tp1?.achievable) reasons.push("TP1 clear of walls");
  if (absDelta != null) {
    reasons.push(`|delta| ${absDelta.toFixed(2)} — ${absDelta >= 0.4 ? "ATM, healthy" : absDelta >= 0.3 ? "moderate" : "lean"}`);
  }
  if (ema) {
    const wantUp = isCE;
    const aligned =
      (wantUp && ema.trend === "UP") || (!wantUp && ema.trend === "DOWN");
    if (aligned) reasons.push(`EMA9/15 ${ema.trend} — trend with the option`);
    else if (ema.trend === "NONE") reasons.push("EMA flat — no trend drag either way");
  }
  if (oiChg != null && Number.isFinite(oiChg)) {
    reasons.push(
      `leg ΔOI ${oiChg >= 0 ? "+" : ""}${Math.round(oiChg).toLocaleString("en-IN")} — ${oiChg >= 0 ? "building" : "mild unwind"}`,
    );
  }
  if (cvdBull && isCE) reasons.push(`CVD ${cvd} — flow with CE`);
  if (cvdBear && !isCE) reasons.push(`CVD ${cvd} — flow with PE`);
  if (!input.chop && input.chopAssessment) {
    reasons.push(input.chopAssessment.reasons[0] || "trend regime — expansion present");
  }
  if (sc?.entryConfirmed) reasons.push("seller entry confirmed (retest ✓)");
  if (sc?.score != null && sc.score >= 40 && seller && seller !== "WAIT") {
    reasons.push(`seller score ${sc.score}/100`);
  }
  if (dealer === "BULLISH" && isCE) reasons.push("dealer bias BULLISH — with CE");
  if (dealer === "BEARISH" && !isCE) reasons.push("dealer bias BEARISH — with PE");
  if (
    sc?.netDex != null &&
    Number.isFinite(sc.netDex) &&
    Math.abs(sc.netDex) > 0
  ) {
    const lean = sc.netDex > 0 ? "call-delta dominant" : "put-delta dominant";
    const withSide = (sc.netDex > 0 && isCE) || (sc.netDex < 0 && !isCE);
    if (withSide) reasons.push(`net DEX ${lean} — with ${isCE ? "CE" : "PE"}`);
  }
  if (seller && seller !== "WAIT") {
    const sellerSide = seller === "BUY_CE" ? "CALL" : "PUT";
    if (sellerSide === side) reasons.push(`seller intel agrees (${seller})`);
  }
  if (seller === "WAIT") reasons.push("seller intel neutral (WAIT — not a blocker)");
  return { decision: "TAKE", label: "TAKE", reasons, confluence, liquidity };
}

// ── Decision hysteresis — stop TAKE↔WAIT flicker every poll ──────────
// raw evaluatePlanTrade recomputes from live OI / seller / walls each poll;
// a single mixed OI tick used to drop TAKE → WAIT in one minute. Mirror the
// ★ lock: same verdict keeps; an opposing verdict needs ≥2 consecutive polls
// AND ≥2 minutes. Hard NO always applies immediately (fail closed).

export interface PlanDecisionLock {
  confirmed: TradeDecision | null;
  pending: TradeDecision | null;
  pendingSince: number;
  pendingCount: number;
}

const DEC_MIN_CONFIRMATIONS = 2;
const DEC_MIN_PERSIST_MS = 2 * 60_000;
const planDecisionLocks = new Map<string, PlanDecisionLock>();

function blankDecisionLock(): PlanDecisionLock {
  return { confirmed: null, pending: null, pendingSince: 0, pendingCount: 0 };
}

/**
 * Sticky TAKE/WAIT per symbol+side. Pure state machine — no network.
 * `raw` is this poll's evaluatePlanTrade verdict.
 */
export function resolvePlanDecision(
  symbol: string,
  optionType: "CE" | "PE",
  raw: TradeDecision,
  nowMs: number = Date.now(),
): { decision: TradeDecision; status: "confirmed" | "pending"; pending: TradeDecision | null } {
  const key = `${symbol}:${optionType}`;
  let lock = planDecisionLocks.get(key);
  if (!lock) {
    lock = blankDecisionLock();
    planDecisionLocks.set(key, lock);
  }

  // Hard NO always wins immediately — safety never waits on hysteresis.
  if (raw === "NO") {
    lock.confirmed = "NO";
    lock.pending = null;
    lock.pendingCount = 0;
    return { decision: "NO", status: "confirmed", pending: null };
  }

  // First verdict confirms immediately (cold start).
  if (lock.confirmed == null) {
    lock.confirmed = raw;
    lock.pending = null;
    lock.pendingCount = 0;
    return { decision: raw, status: "confirmed", pending: null };
  }

  // Same as confirmed → keep (no flicker).
  if (raw === lock.confirmed) {
    lock.pending = null;
    lock.pendingCount = 0;
    return { decision: lock.confirmed, status: "confirmed", pending: null };
  }

  // Opposing raw — accumulate; only flip past count + persistence.
  if (lock.pending !== raw) {
    lock.pending = raw;
    lock.pendingSince = nowMs;
    lock.pendingCount = 1;
  } else {
    lock.pendingCount += 1;
  }

  const persistOk = nowMs - lock.pendingSince >= DEC_MIN_PERSIST_MS;
  const countOk = lock.pendingCount >= DEC_MIN_CONFIRMATIONS;
  if (persistOk && countOk) {
    lock.confirmed = raw;
    lock.pending = null;
    lock.pendingCount = 0;
    return { decision: raw, status: "confirmed", pending: null };
  }

  return { decision: lock.confirmed, status: "pending", pending: lock.pending };
}

/** Test hook — clear per-symbol plan decision locks. */
export function __resetPlanDecisionLocksForTests(): void {
  planDecisionLocks.clear();
}

/**
 * Hold window computed from LIVE inputs — EMA cross state, OI / ΔOI,
 * greeks (delta + theta), and the plan's seller stop. Never invents an
 * exit clock: the window is a guidance range; SL/TP remain the real exits.
 *
 * Deterministic scoring (no randomness, pure function):
 *   base window from DTE → tighten on chop / thin delta / heavy θ
 *                          → extend on aligned trend + strong ADX + room to wall
 *   FAKEOUT/REVERSAL always capped short (trap must resolve fast).
 */
export interface HoldTimeInput {
  daysToExpiry: number;
  setup?: string;
  optionType: "CE" | "PE";
  /** Last-bar EMA9/15 + ADX state (null when candles unavailable). */
  ema?: EmaBarState | null;
  /** Selected leg's live delta (provider or BS). */
  delta?: number | null;
  /** Selected leg's live theta (per day, negative for longs). */
  theta?: number | null;
  /** Selected leg's ΔOI today (contracts). */
  oiChange?: number | null;
  /** Nearest opposing OI wall in the TP path (from assessTargets). */
  wall?: { strike: number; oi: number; oiChange: number } | null;
  /** Plan entry premium. */
  entry?: number;
  /** Plan stop (seller stop / rupee-risk stop). */
  stopLoss?: number;
}

export interface HoldTimeResult {
  /** Display label, e.g. "45-90 min". */
  label: string;
  minutesLow: number;
  minutesHigh: number;
  /** Human-readable factors that set the window (UI tooltip). */
  reasons: string[];
}

function clampWindow(low: number, high: number): [number, number] {
  const lo = Math.max(10, Math.round(low));
  const hi = Math.max(lo + 15, Math.round(high));
  return [lo, hi];
}

function fmtWindow(lo: number, hi: number): string {
  if (hi < 60) return `${lo}-${hi} min`;
  const loH = lo >= 60 ? (lo % 60 === 0 ? `${lo / 60}h` : `${Math.floor(lo / 60)}h${lo % 60}`) : `${lo} min`;
  const hiH = hi % 60 === 0 ? `${hi / 60}h` : `${Math.floor(hi / 60)}h${hi % 60}`;
  if (lo < 60) return `${lo} min-${hiH}`;
  return `${loH}-${hiH}`;
}

export function computeHoldTime(input: HoldTimeInput): HoldTimeResult {
  const dte = Number(input.daysToExpiry);
  const setup = (input.setup || "").toUpperCase();
  const reasons: string[] = [];

  // ── Base window from DTE ──
  let low: number, high: number;
  if (Number.isFinite(dte) && dte <= 0) {
    low = 15; high = 30;
    reasons.push("expiry day — theta kills longs");
  } else if (dte === 1) {
    low = 30; high = 60;
    reasons.push("expiry eve — short window");
  } else {
    low = 60; high = 240;
    reasons.push(`DTE ${dte} — swing-to-intraday base`);
  }

  const isTrap = setup.includes("FAKEOUT") || setup.includes("REVERSAL");
  const isContinuation =
    setup.includes("BREAKOUT") ||
    setup.includes("RETEST") ||
    setup.includes("PULLBACK") ||
    setup.includes("CROSSOVER");

  // ── EMA cross alignment (CE wants UP, PE wants DOWN) ──
  const ema = input.ema ?? null;
  const wantUp = input.optionType === "CE";
  if (ema) {
    const aligned =
      (wantUp && ema.trend === "UP") || (!wantUp && ema.trend === "DOWN");
    const against =
      (wantUp && ema.trend === "DOWN") || (!wantUp && ema.trend === "UP");
    reasons.push(
      `EMA9/15 ${ema.trend} · ADX ${ema.adx.toFixed(0)} · gap ${ema.gapAtr.toFixed(2)}×ATR`,
    );
    if (against) {
      // Trend opposes the long option — the hold must be short; SL first.
      low = Math.min(low, 30);
      high = Math.min(high, 90);
      reasons.push("EMA against option side — exit on SL or first TP");
    } else if (aligned && ema.adx >= 25 && ema.gapAtr >= 0.15) {
      // Confirmed expansion — room to ride toward the TP ladder.
      high = Math.min(360, high + 60);
      reasons.push("trend aligned + ADX≥25 — room to ride TP");
    } else if (ema.trend === "NONE" || ema.gapAtr < 0.1) {
      // Flat / tight cross — chop eats premium.
      low = Math.min(low, 30);
      high = Math.min(high, 90);
      reasons.push("flat EMA cross — chop, keep the hold short");
    }
  } else {
    reasons.push("EMA state unavailable — base window only");
  }

  // ── Setup type caps ──
  if (isTrap) {
    high = Math.min(high, 90);
    low = Math.min(low, 45);
    reasons.push("trap/reversal — resolve within 90 min");
  } else if (isContinuation && ema && ((wantUp && ema.trend === "UP") || (!wantUp && ema.trend === "DOWN"))) {
    reasons.push("continuation setup with trend tailwind");
  }

  // ── Delta: thin lottery vs tradable ──
  const delta = input.delta;
  if (delta != null && Number.isFinite(delta)) {
    const abs = Math.abs(delta);
    if (abs < 0.3) {
      high = Math.min(high, 90);
      reasons.push(`|delta| ${abs.toFixed(2)} — lottery, cap 90 min`);
    } else if (abs >= 0.45 && abs <= 0.75) {
      reasons.push(`|delta| ${abs.toFixed(2)} — ATM, healthy for the ladder`);
    }
  }

  // ── Theta: heavy time-decay shortens a long option hold ──
  const theta = input.theta;
  const entry = Number(input.entry) || 0;
  if (theta != null && Number.isFinite(theta) && entry > 0) {
    // θ as % of premium per day (theta is negative for longs).
    const thetaPct = Math.abs(theta) / entry;
    if (thetaPct >= 0.04) {
      high = Math.min(high, 120);
      reasons.push(`|θ| ${(thetaPct * 100).toFixed(1)}%/day of premium — decay heavy`);
    }
  }

  // ── OI: fresh writing against the TP path (wall) ──
  const wall = input.wall ?? null;
  if (wall && wall.oiChange > 0) {
    // Opposing wall still being written — TPs above it need a spot break;
    // do not promise a multi-hour ride into defended OI.
    high = Math.min(high, 120);
    reasons.push(
      `wall ${wall.strike} writing +${wall.oiChange.toLocaleString("en-IN")} OI — TPs blocked until broken`,
    );
  }
  const oiChange = input.oiChange;
  if (oiChange != null && Number.isFinite(oiChange) && oiChange <= -5000) {
    // Heavy unwinding of THIS leg can precede a premium fade — mild shorten.
    high = Math.min(high, 150);
    reasons.push(`this leg ΔOI ${oiChange.toLocaleString("en-IN")} — unwinding, don't overstay`);
  }

  // ── Seller stop geometry: tight stop = short hold expectation ──
  const stop = Number(input.stopLoss) || 0;
  if (entry > 0 && stop > 0 && stop < entry) {
    const stopPct = (entry - stop) / entry;
    if (stopPct <= 0.12) {
      high = Math.min(high, 90);
      reasons.push(`stop ${((1 - stopPct) * 100).toFixed(0)}% of entry — tight, SL can print fast`);
    } else if (stopPct >= 0.25) {
      reasons.push(`stop ${((1 - stopPct) * 100).toFixed(0)}% of entry — room before SL`);
    }
  }

  const [lo, hi] = clampWindow(low, high);
  return {
    label: fmtWindow(lo, hi),
    minutesLow: lo,
    minutesHigh: hi,
    reasons,
  };
}

/** Back-compat wrapper — static table when no live inputs are wired. */
export function estimateHoldTime(input: {
  daysToExpiry: number;
  setup?: string;
}): string {
  return computeHoldTime({
    daysToExpiry: input.daysToExpiry,
    setup: input.setup,
    optionType: "CE",
  }).label;
}

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

    // 2. Max-pain gravity — sellers win if spot settles AT max pain.
    //    Spot ABOVE MP → pain is below → gravity pulls DOWN → bearish (PUT).
    //    Spot BELOW MP → gravity pulls UP → bullish (CALL).
    //    (Was inverted here while sdm-engine / gap-engine had it right.)
    votes.push(
      args.spot > args.maxPain
        ? { factor: "Max Pain", vote: "PUT", detail: `spot ${args.spot.toFixed(0)} above MP ${args.maxPain} — gravity down to pain` }
        : args.spot < args.maxPain
          ? { factor: "Max Pain", vote: "CALL", detail: `spot ${args.spot.toFixed(0)} below MP ${args.maxPain} — gravity up to pain` }
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

    // 1. Get option chain from canonical data layer (NSE/BSE/MOAPI/Breeze).
    //    Two short retries with backoff: under load the first race can lose
    //    every provider even though the next attempt succeeds seconds later.
    //    Never fall back to EOD bhavcopy while the market is open.
    let chainResult = await canonicalGetOptionChain(underlying, expiryISO);
    for (let attempt = 0; !chainResult.data && attempt < 2; attempt++) {
      await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
      chainResult = await canonicalGetOptionChain(underlying, expiryISO);
    }

    if (!chainResult.data) {
      console.error(`[DailyDerivatives] Chain fetch failed:`, chainResult.fallbackReason);
      const err: any = new Error(chainResult.fallbackReason || "Failed to fetch option chain");
      err.status = 503;
      throw err;
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
    let emaState: EmaBarState | null = null;
    if (candles.length > 0) {
      const { signals, lastBar } = emaCrossAdxAtr(candles, { adxMin: 20 });
      allSignals = signals;
      latestSignals = signals.slice(-5).reverse();
      emaState = lastBar;
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
    // ★ follows the hysteresis lock — one OI tick or one new candle setup
    // must NOT flip PE↔CE mid-session. Raw majority is still on directionBias.
    const pref = resolvePreferredSide(
      underlying,
      directionBias.side === "NEUTRAL" ? null : directionBias.side,
      Date.now(),
    );
    const preferredSide = pref.side;

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
        // Live leg: ΔOI + θ for the hold window (same chain row we priced).
        const legRow = chainRows.find((r) => r.strike === sel.strike);
        const leg = sel.optionType === "CE" ? legRow?.ce : legRow?.pe;
        const legOiChange =
          leg && Number.isFinite(Number((leg as any).oiChange))
            ? Number((leg as any).oiChange)
            : null;
        const legTheta =
          leg?.greeks && Number.isFinite(leg.greeks.theta) ? leg.greeks.theta : null;
        // First blocked TP's wall — writing against the path shortens the hold.
        const firstBlocked = targetReach.find((t) => !t.achievable && t.wall);
        const hold = computeHoldTime({
          daysToExpiry,
          setup,
          optionType: sel.optionType,
          ema: emaState,
          delta: sel.delta,
          theta: legTheta,
          oiChange: legOiChange,
          wall: firstBlocked?.wall
            ? {
                strike: firstBlocked.wall.strike,
                oi: firstBlocked.wall.oi,
                oiChange: firstBlocked.wall.oiChange,
              }
            : null,
          entry: plan ? plan.entry : sel.entry,
          stopLoss: plan?.stopLoss ?? 0,
        });
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
          holdingTime: hold.label,
          holdingReasons: hold.reasons,
          reason: plan
            ? `${sel.reason}${cleanNotes.length ? ` — ${cleanNotes.join(" · ")}` : ""}${blocked.length ? ` — ${blocked.join(" · ")}` : ""}`
            : `${sel.reason} — no valid SL/TP ladder`,
        };
      };

      const cached = planSnapshots.get(underlying);
      const ttlOk = !!cached && Date.now() - cached.at < PLAN_TTL_MS;
      const drift = cached && cached.spot > 0 ? Math.abs(spot - cached.spot) / cached.spot : Infinity;
      const driftOk = drift <= PLAN_SPOT_DRIFT;
      // Reuse the frozen ladder while TTL + drift hold. A side that appears
      // fresh (was absent, now present) forces a coherent rebuild so we never
      // mix a stale card with a new one. An ATM WALK that would re-select a
      // neighbouring strike does NOT rebuild — the held plan's entry/SL/TP
      // stay anchored (only `refreshPlan: true` or a material spot move
      // rebuilds). That is what stops the strike number ticking every poll.
      const sideAppeared =
        !!cached &&
        (["CALL", "PUT"] as const).some((d) => !cached.bySide[d] && selBySide[d]);
      const fmtPlanTime = (ms: number) =>
        new Date(ms).toLocaleTimeString("en-IN", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });

      if (!params.refreshPlan && cached && ttlOk && driftOk && !sideAppeared) {
        // Frozen ladder — entry/SL/TP/strike stay put; only live premium ticks.
        // Hold window is NOT a level: recompute it from live EMA/OI/greeks/stop
        // so the badge tracks the tape without rebuilding the SL/TP ladder.
        planAsOf = fmtPlanTime(cached.at);
        for (const direction of ["CALL", "PUT"] as const) {
          const frozen = cached.bySide[direction];
          if (!frozen) continue;
          const sel = selBySide[direction];
          const card = sel ? { ...frozen, livePremium: sel.entry } : frozen;
          if (sel) {
            const legRow = chainRows.find((r) => r.strike === frozen.strike);
            const leg = frozen.optionType === "CE" ? legRow?.ce : legRow?.pe;
            const legOiChange =
              leg && Number.isFinite(Number((leg as any).oiChange))
                ? Number((leg as any).oiChange)
                : null;
            const legTheta =
              leg?.greeks && Number.isFinite(leg.greeks.theta) ? leg.greeks.theta : null;
            const firstBlocked = (frozen.targetReach || []).find(
              (t) => !t.achievable && t.wall,
            );
            const hold = computeHoldTime({
              daysToExpiry,
              setup: frozen.setup,
              optionType: frozen.optionType,
              ema: emaState,
              delta: sel.delta,
              theta: legTheta,
              oiChange: legOiChange,
              wall: firstBlocked?.wall
                ? {
                    strike: firstBlocked.wall.strike,
                    oi: firstBlocked.wall.oi,
                    oiChange: firstBlocked.wall.oiChange,
                  }
                : null,
              entry: frozen.entry,
              stopLoss: frozen.stopLoss,
            });
            card.holdingTime = hold.label;
            card.holdingReasons = hold.reasons;
          }
          tradePlans.push(card);
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

    // Per-card TAKE / WAIT / NO — needs sellerIntel + CVD (built just above).
    // Live leg greeks / ΔOI / EMA / CVD / chop feed the same quality checks
    // the hold window uses, so ENTRY and EXIT read one consistent tape.
    const marketOpenNow = marketSessionSnapshot()?.isMarketOpen !== false;
    const cvdVerdict = cvd?.available ? cvd.verdict : null;
    // Live RVOL: futures-flow's last-bar read when present, else derive from
    // the same candles — null when history is thin (never a fake 1.0).
    const liveRvol =
      futuresRelVol?.ratio != null && Number.isFinite(futuresRelVol.ratio)
        ? futuresRelVol.ratio
        : lastBarRvol(candles);
    const chopAssessment =
      candles.length > 0
        ? assessChop({ ema: emaState, candles, rvol: liveRvol })
        : null;
    for (const card of tradePlans) {
      // Frozen strike still gets LIVE greeks/OI from the current chain row.
      const legRow = strikes.find((s) => s.strike === card.strike);
      const leg = card.optionType === "CE" ? legRow?.call : legRow?.put;
      const legDelta =
        leg?.greeks && Number.isFinite(leg.greeks.delta) ? leg.greeks.delta : null;
      const legTheta =
        leg?.greeks && Number.isFinite(leg.greeks.theta) ? leg.greeks.theta : null;
      const legOiChange =
        leg && Number.isFinite(leg.oiChange) ? leg.oiChange : null;
      const legBid = leg && Number.isFinite(leg.bid) ? leg.bid : null;
      const legAsk = leg && Number.isFinite(leg.ask) ? leg.ask : null;
      const v = evaluatePlanTrade({
        optionType: card.optionType,
        tradable: card.tradable,
        lots: card.lots,
        rr: card.rr,
        entry: card.entry,
        stopLoss: card.stopLoss,
        preferredSide,
        preferredStatus: pref.status,
        targetReach: card.targetReach,
        sellerSignal: sellerIntel.verdict.signal,
        marketOpen: marketOpenNow,
        delta: legDelta,
        theta: legTheta,
        oiChange: legOiChange,
        ema: emaState,
        cvdVerdict,
        chop: chopAssessment?.chop === true,
        chopAssessment,
        bid: legBid,
        ask: legAsk,
        chainFreshness: chain.freshness || null,
        sellerCtx: {
          requiresRetest: sellerIntel.verdict.requiresRetest,
          entryConfirmed: sellerIntel.verdict.entryConfirmed,
          score: sellerIntel.verdict.score,
          direction: sellerIntel.verdict.direction,
          dealerBias: sellerIntel.exposure.dealerBias,
          dealerRegime: sellerIntel.exposure.dealerRegime,
          netDex: sellerIntel.exposure.netDex,
          gammaFlip: sellerIntel.exposure.gammaFlip,
          spot,
          vwap: sellerIntel.market.vwap,
          priceAboveVwap:
            sellerIntel.market.vwap > 0
              ? spot > sellerIntel.market.vwap
              : null,
          breakoutConfirmed: sellerIntel.market.breakoutConfirmed,
        },
      });
      // Sticky verdict — one mixed OI/seller tick must not flip TAKE→WAIT
      // mid-entry. Hard NO bypasses the lock (fail closed).
      const locked = resolvePlanDecision(underlying, card.optionType, v.decision);
      card.decision = locked.decision;
      card.decisionLabel =
        locked.decision === "TAKE" ? "TAKE" : locked.decision === "WAIT" ? "WAIT" : "NO TRADE";
      if (v.confluence) {
        card.confluenceAligned = v.confluence.aligned;
        card.confluenceCast = v.confluence.cast;
      }
      if (v.liquidity) {
        card.liquidityState = v.liquidity.state;
        card.liquiditySpreadPct = v.liquidity.spreadPct;
      }
      if (locked.status === "pending" && locked.pending && locked.decision !== v.decision) {
        card.decisionReasons = [
          ...v.reasons,
          `raw ${v.decision} pending — keeping ${locked.decision} until confirmed`,
        ];
      } else {
        card.decisionReasons = v.reasons;
      }
    }

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
      preferredStatus: pref.status,
      preferredPending: pref.pending,
      directionBias,
      chopRegime: chopAssessment,
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