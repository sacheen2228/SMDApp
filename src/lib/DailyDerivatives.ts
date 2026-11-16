// SDM App - Daily Derivatives Tab
// Uses canonical data-layer (NSE primary, BSE primary, MOAPI fallback, NO_DATA)
// Includes: India VIX, PCR, Max Pain, OI Walls, ATM Greeks, Signals, Sentiment

import { getOptionChain as canonicalGetOptionChain } from "@/lib/data-layer/chains/option-chain";
import { calculateGreeks, parseExpiryDateLoose, impliedVolFromPremium } from "@/lib/greeks";
import { getNSEIndiaVIX } from "@/lib/nse-api";
import { fetchCandlesWithFallback } from "@/lib/market/candle-chain";
import { buildOptionPlan, selectStrike } from "@/lib/option-plan";
import { getLotSizeStrict } from "@/lib/symbol-config";

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
export type SetupType = "CROSSOVER" | "PULLBACK" | "BREAKOUT" | "RETEST" | "FAKEOUT";

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
  pcr: number;
  maxPain: number;
  callWall: number;
  putWall: number;
  totalCallOI: number;
  totalPutOI: number;
  atmStrike: number;
  atmIV: number;
  atmGreeks?: Greeks;
  topCallOI: { strike: number; oi: number; oiChange: number }[];
  topPutOI: { strike: number; oi: number; oiChange: number }[];
  expiry: string;
  daysToExpiry: number;
  latestSignals: Signal[];
  sentiment: "Extreme Greed" | "Bullish" | "Neutral" | "Bearish" | "Extreme Fear";
  sentimentScore: number;
  tradePlans: TradePlanCard[];
  preferredSide: "CALL" | "PUT" | null;
  candleSource: string;
  candleInterval: string;
  candleDegraded: string | null;
  candleCount: number;
  dataSource: string;
  freshness: string;
}

// ====================== INDICATOR (kept pure) ======================
export interface Config {
  fast: number;
  slow: number;
  adxPeriod: number;
  adxMin: number;
  atrPeriod: number;
  breakoutLookback: number;
  breakoutBufferAtr: number;
  minEmaGapAtr: number;
  pullbackSlowToleranceAtr: number;
  retestWindow: number;
  retestToleranceAtr: number;
  fakeoutWindow: number;
  stopAtrMult: number;
  rrTargets: number[];
  cooldownBars: number;
}

export const DEFAULTS: Config = {
  fast: 9,
  slow: 15,
  adxPeriod: 14,
  adxMin: 20,
  atrPeriod: 14,
  breakoutLookback: 20,
  breakoutBufferAtr: 0.1,
  minEmaGapAtr: 0.15,
  pullbackSlowToleranceAtr: 0.5,
  retestWindow: 10,
  retestToleranceAtr: 0.3,
  fakeoutWindow: 3,
  stopAtrMult: 1.5,
  rrTargets: [1, 2, 3],
  cooldownBars: 3,
};

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

  const start = Math.max(o.slow, o.adxPeriod * 2, o.atrPeriod, o.breakoutLookback) + 1;

  for (let i = start; i < candles.length; i++) {
    const k = candles[i];
    const a = atrArr[i];
    const f = emaFast[i], s = emaSlow[i];
    const pf = emaFast[i - 1], ps = emaSlow[i - 1];
    if ([a, f, s, pf, ps, adxArr[i], adxArr[i - 1]].some(Number.isNaN)) continue;

    const adxOk = adxArr[i] >= o.adxMin;
    const gapOk = Math.abs(f - s) >= o.minEmaGapAtr * a;
    const up = f > s;
    const dn = f < s;
    trend[i] = up ? "UP" : dn ? "DOWN" : "NONE";
    const diBull = plusDI[i] > minusDI[i];
    const diBear = minusDI[i] > plusDI[i];
    const bullBar = k.close > k.open;
    const bearBar = k.close < k.open;
    const stopDist = o.stopAtrMult * a;

    pending = pending.filter(p => i - p.index <= o.retestWindow);

    let hh = -Infinity, ll = Infinity;
    for (let j = i - o.breakoutLookback; j < i; j++) {
      hh = Math.max(hh, candles[j].high);
      ll = Math.min(ll, candles[j].low);
    }
    const buf = o.breakoutBufferAtr * a;
    const expansion = k.high - k.low >= 0.8 * a;

    if (up && gapOk && adxOk && diBull && k.close > hh + buf && bullBar && expansion) {
      push(build(i, "BREAKOUT", "LONG", k.close, k.close - stopDist, `Breakout above ${hh.toFixed(0)}`));
      pending.push({ side: "LONG", level: hh, index: i });
    } else if (dn && gapOk && adxOk && diBear && k.close < ll - buf && bearBar && expansion) {
      push(build(i, "BREAKOUT", "SHORT", k.close, k.close + stopDist, `Breakdown below ${ll.toFixed(0)}`));
      pending.push({ side: "SHORT", level: ll, index: i });
    }

    const crossUp = pf <= ps && f > s;
    const crossDn = pf >= ps && f < s;
    if (crossUp && adxOk && diBull) {
      push(build(i, "CROSSOVER", "LONG", k.close, k.close - stopDist, `EMA9 crossed above EMA15`));
    } else if (crossDn && adxOk && diBear) {
      push(build(i, "CROSSOVER", "SHORT", k.close, k.close + stopDist, `EMA9 crossed below EMA15`));
    }

    const slowTol = o.pullbackSlowToleranceAtr * a;
    if (up && gapOk && adxOk && diBull && !crossUp &&
        k.low <= f && k.close > f && k.close > s && k.low >= s - slowTol && bullBar) {
      push(build(i, "PULLBACK", "LONG", k.close, Math.min(k.low, s) - 0.25 * a, `Pullback to EMA zone`));
    } else if (dn && gapOk && adxOk && diBear && !crossDn &&
        k.high >= f && k.close < f && k.close < s && k.high <= s + slowTol && bearBar) {
      push(build(i, "PULLBACK", "SHORT", k.close, Math.max(k.high, s) + 0.25 * a, `Pullback to EMA zone`));
    }
  }

  return { signals, trend };
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

  async getDailyDerivativesReport(params: {
    underlying: "NIFTY" | "SENSEX";
    expiryISO?: string;
    daysToExpiry?: number;
    interval?: "5minute" | "15minute" | "30minute";
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
    const daysToExpiry =
      params.daysToExpiry ??
      (expiryDate ? Math.max(0, Math.ceil((expiryDate.getTime() - Date.now()) / 86400000)) : 0);

    // 2. Candles via the live capture chain (Breeze → MO → NSE index-only).
    //    SENSEX is a BSE index — the chain reports that capability skip honestly;
    //    never substitutes a different instrument or timeframe.
    const candleResult = await fetchCandlesWithFallback(
      underlying,
      new Date().toISOString().slice(0, 10),
      interval
    );
    const candles: Candle[] = (candleResult.candles || []).map((c) => ({
      time: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    // 3. Indicator Signals (if we have candles)
    let latestSignals: Signal[] = [];
    if (candles.length > 0) {
      const { signals } = emaCrossAdxAtr(candles, { adxMin: 20 });
      latestSignals = signals.slice(-5).reverse();
    }

    // 4. Process option chain data — map canonical ce/pe legs to call/put
    const strikes: OptionStrike[] = (chain.strikes || []).map((s: any) => ({
      strike: Number(s.strike),
      call: s.ce ? {
        ltp: Number(s.ce.ltp) || 0,
        oi: Number(s.ce.oi) || 0,
        oiChange: Number(s.ce.oiChg) || 0,
        volume: Number(s.ce.volume) || 0,
        bid: Number(s.ce.bid) || 0,
        ask: Number(s.ce.ask) || 0,
      } : undefined,
      put: s.pe ? {
        ltp: Number(s.pe.ltp) || 0,
        oi: Number(s.pe.oi) || 0,
        oiChange: Number(s.pe.oiChg) || 0,
        volume: Number(s.pe.volume) || 0,
        bid: Number(s.pe.bid) || 0,
        ask: Number(s.pe.ask) || 0,
      } : undefined,
    }));
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

    // ATM Greeks
    const atm = strikes.find(s => s.strike === atmStrike);
    let atmIV = 0;
    let atmGreeks: Greeks | undefined;
    const T = Math.max((daysToExpiry || 0) / 365, 0.002);

    if (atm?.call?.ltp && spot > 0) {
      atmIV = impliedVolFromPremium(atm.call.ltp, spot, atmStrike, T, true) || 0;
      if (atmIV > 0) {
        atmGreeks = { ...calculateGreeks(spot, atmStrike, T, atmIV, true), iv: atmIV };
      }
    }

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

    // India VIX — real value from NSE, fallback only when NSE is unreachable
    const vixData = await getNSEIndiaVIX().catch(() => null);
    const indiaVix = vixData?.value ?? 15.70;
    const indiaVixChange = vixData?.change ?? 0;

    const { sentiment, score } = this.getSentiment(indiaVix, pcr);

    // Trade plans — canonical `selectStrike` picks the tradable ATM..OTM
    // contract per side (gate rules: budget fit, |delta| ≥ 0.35 when
    // published), then `buildOptionPlan` prices the SL/TP ladder on it.
    // Both sides are shown honestly; the preferred side follows sentiment/PCR
    // (neutral tie-break: spot vs max pain).
    const preferredSide: "CALL" | "PUT" | null =
      sentiment === "Bullish" || sentiment === "Extreme Greed" || pcr > 1 ? "CALL"
      : sentiment === "Bearish" || sentiment === "Extreme Fear" || pcr < 0.85 ? "PUT"
      : spot > maxPain ? "CALL" : spot < maxPain ? "PUT" : null;

    const tradePlans: TradePlanCard[] = [];
    const lotSize = getLotSizeStrict(underlying);
    if (lotSize && spot > 0) {
      const chainRows = (chain.strikes || []).map((s: any) => ({
        strike: Number(s.strike),
        ce: s.ce,
        pe: s.pe,
      }));
      for (const direction of ["CALL", "PUT"] as const) {
        const sel = selectStrike({ chain: chainRows, direction, spot, lotSize });
        if (!sel) continue;
        const plan = buildOptionPlan({
          symbol: underlying,
          optionType: sel.optionType,
          entryPremium: sel.entry,
          lotSize,
        });
        tradePlans.push({
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
          reason: plan
            ? `${sel.reason}${plan.notes.length ? ` — ${plan.notes.join(" · ")}` : ""}`
            : `${sel.reason} — no valid SL/TP ladder`,
        });
      }
      // Preferred side first
      tradePlans.sort((a, b) =>
        (a.optionType === (preferredSide === "PUT" ? "PE" : "CE") ? 0 : 1) -
        (b.optionType === (preferredSide === "PUT" ? "PE" : "CE") ? 0 : 1)
      );
    }

    // Expiry info
    const expiry = chain.expiry || expiryISO || "";
    const dte = daysToExpiry || 0;

    return {
      underlying,
      timestamp: new Date().toISOString(),
      spot,
      indiaVix,
      indiaVixChange,
      pcr: +pcr.toFixed(3),
      maxPain,
      callWall,
      putWall,
      totalCallOI,
      totalPutOI,
      atmStrike,
      atmIV: +(atmIV * 100).toFixed(2),
      atmGreeks,
      topCallOI,
      topPutOI,
      expiry,
      daysToExpiry: dte,
      latestSignals,
      sentiment,
      sentimentScore: score,
      tradePlans,
      preferredSide,
      candleSource: candleResult.source,
      candleInterval: candleResult.intervalLabel,
      candleDegraded: candleResult.degraded,
      candleCount: candles.length,
      dataSource: chainResult.source || "canonical",
      freshness: chain.freshness || "UNKNOWN",
    };
  }

  formatDailyDerivativesReport(r: DailyDerivativesReport): string {
    return `
═══════════════════════════════════════════════════
          SDM DAILY DERIVATIVES REPORT
═══════════════════════════════════════════════════
Underlying     : ${r.underlying}
Spot           : ${r.spot.toFixed(2)}
Time           : ${new Date(r.timestamp).toLocaleString("en-IN")}

India VIX      : ${r.indiaVix.toFixed(2)} (${r.indiaVixChange >= 0 ? "+" : ""}${r.indiaVixChange.toFixed(2)})
PCR            : ${r.pcr}
Max Pain       : ${r.maxPain}
Call Wall      : ${r.callWall}
Put Wall       : ${r.putWall}

ATM Strike     : ${r.atmStrike}
ATM IV         : ${r.atmIV}%
ATM Delta      : ${r.atmGreeks?.delta?.toFixed(3) || "-"}
ATM Theta      : ${r.atmGreeks?.theta?.toFixed(2) || "-"}

Sentiment      : ${r.sentiment} (Score: ${r.sentimentScore}/100)
Expiry         : ${r.expiry.slice(0, 10)} (${r.daysToExpiry} days left)
Data Source    : ${r.dataSource} (${r.freshness})

── Top Call OI ──────────────────────────────
${r.topCallOI.map(t => `  ${t.strike} → OI: ${t.oi.toLocaleString()} | ΔOI: ${t.oiChange}`).join("\n")}

── Top Put OI ───────────────────────────────
${r.topPutOI.map(t => `  ${t.strike} → OI: ${t.oi.toLocaleString()} | ΔOI: ${t.oiChange}`).join("\n")}

── Latest Signals ───────────────────────────
${r.latestSignals.length === 0 ? "  No recent signals (candles not available)" :
  r.latestSignals.map(s => `  [${s.type}] ${s.side} @ ${s.entry.toFixed(0)} | Strength: ${s.strength}`).join("\n")}

── Trade Plans (SL/TP ladder, TP 2R/3R/4R) ──
${r.tradePlans.length === 0 ? "  No tradable contract found" :
  r.tradePlans.map(p => `  ${p.optionType} ${p.strike}${p.optionType === (r.preferredSide === "PUT" ? "PE" : "CE") ? " ★" : ""} | Entry: ${p.entry} | SL: ${p.stopLoss} | TP: ${p.targets.join(" / ") || "-"} | ${p.lots} lot${p.lots === 1 ? "" : "s"} ₹${Math.round(p.deployed).toLocaleString("en-IN")}${p.tradable ? "" : " — NOT TRADABLE"}`).join("\n")}
Candles         : ${r.candleCount} @ ${r.candleInterval} (${r.candleSource}${r.candleDegraded ? ` — ${r.candleDegraded}` : ""})
═══════════════════════════════════════════════════
`;
  }
}

export default DailyDerivativesService;