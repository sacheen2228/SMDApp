// market-direction-analyzer.ts — D-4 remediation
//
// The OLD analyzeMarketDirection (intraday-scanner.ts) classified the market
// from PCR ALONE, then fabricated the rest:
//   • niftyTrend  = spot vs max pain ("simulated")
//   • breadth     = pcr > 1.1 ? "Advancing" : …  (PCR is not breadth)
//   • no multi-timeframe trend, no VWAP, no MACD/ADX/ATR confirmation
//
// This module derives direction from REAL OHLC candles:
//   • EMA alignment (9/21/50)      — daily + 5m/15m/30m when available
//   • VWAP position (volume-weighted, session candles)
//   • RSI, MACD, ADX, ATR          — from the candle series (never defaulted)
//   • Relative volume vs trailing average
//   • Breadth from the scanned stocks' own daily bars
//   • PCR / VIX as CONFIRMING factors only (never the sole driver)
//
// When there is not enough candle data the analyzer says so and returns a
// neutral, low-confidence reading — it never invents a trend.

import { calculateRSI, calculateEMA, calculateADX, type Candle } from "./ml-engine";

export type MTFAlignment = "BULLISH" | "BEARISH" | "MIXED";
export type VwapPosition = "ABOVE" | "BELOW" | "AT";
export type BreadthState = "ADVANCING" | "DECLINING" | "MIXED";

export interface MarketDirectionInput {
  spotPrice: number;
  vix: number | null;
  pcr: number | null;
  maxPain: number;
  totalCallOI?: number;
  totalPutOI?: number;
  dailyCandles: Candle[];
  /** Intraday timeframes keyed "5m" / "15m" / "30m" — optional. */
  intradayCandles?: Record<string, Candle[]>;
  breadth?: { advancing: number; declining: number; unchanged: number };
}

export interface MultiTimeframe {
  emaAlignment: MTFAlignment;
  vwapPosition: VwapPosition;
  breadth: BreadthState;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  rsi: number | null;
  macd: number | null;
  adx: number | null;
  atr: number | null;
  relVolume: number | null;
  /** Per-timeframe EMA alignment (daily, 5m, 15m, 30m when available). */
  timeframes: { tf: string; alignment: MTFAlignment }[];
}

export interface MarketDirectionResult {
  trend: "STRONG_BULLISH" | "BULLISH" | "SIDEWAYS" | "VOLATILE" | "BEARISH" | "STRONG_BEARISH";
  score: number;
  details: string;
  niftyTrend: string;
  bankNiftyTrend: string;
  vixLevel: string;
  breadth: string;
  globalCues: string;
  multiTimeframe: MultiTimeframe;
}

/** Oldest → newest. Scanner candles arrive newest-first (no timestamp). */
function chrono(candles: Candle[] | undefined): Candle[] {
  if (!candles || candles.length === 0) return [];
  const allTs = candles.every((c) => c && typeof (c as any).timestamp === "number");
  if (allTs) return [...candles].sort((a, b) => (a as any).timestamp - (b as any).timestamp);
  return [...candles].reverse();
}

function finiteCloses(candles: Candle[]): number[] {
  return candles.map((c) => Number(c.close)).filter((n) => Number.isFinite(n) && n > 0);
}

interface EmaRead { alignment: MTFAlignment; ema9: number | null; ema21: number | null; ema50: number | null }

function emaRead(candles: Candle[]): EmaRead {
  const cs = chrono(candles);
  const closes = finiteCloses(cs);
  if (closes.length < 10) return { alignment: "MIXED", ema9: null, ema21: null, ema50: null };
  const ema9 = calculateEMA(closes, 9).slice(-1)[0] ?? null;
  const ema21 = closes.length >= 21 ? calculateEMA(closes, 21).slice(-1)[0] ?? null : null;
  const ema50 = closes.length >= 50 ? calculateEMA(closes, 50).slice(-1)[0] ?? null : null;

  let alignment: MTFAlignment = "MIXED";
  if (ema21 != null && ema50 != null) {
    if (ema9! > ema21 && ema21 > ema50) alignment = "BULLISH";
    else if (ema9! < ema21 && ema21 < ema50) alignment = "BEARISH";
  } else if (ema21 != null) {
    if (ema9! > ema21) alignment = "BULLISH";
    else if (ema9! < ema21) alignment = "BEARISH";
  }
  return { alignment, ema9, ema21, ema50 };
}

/** Volume-weighted average price over the session (oldest → newest). */
function vwap(candles: Candle[]): number | null {
  const cs = chrono(candles);
  let pv = 0;
  let v = 0;
  for (const c of cs) {
    const tp = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
    const vol = Number(c.volume) || 0;
    if (!Number.isFinite(tp) || vol <= 0) continue;
    pv += tp * vol;
    v += vol;
  }
  return v > 0 ? pv / v : null;
}

function macdOf(candles: Candle[]): number | null {
  const closes = finiteCloses(chrono(candles));
  if (closes.length < 26) return null;
  const e12 = calculateEMA(closes, 12).slice(-1)[0];
  const e26 = calculateEMA(closes, 26).slice(-1)[0];
  if (!Number.isFinite(e12) || !Number.isFinite(e26)) return null;
  return e12 - e26;
}

function atrOf(candles: Candle[], period = 14): number | null {
  const cs = chrono(candles);
  if (cs.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < cs.length; i++) {
    const h = Number(cs[i].high);
    const l = Number(cs[i].low);
    const pc = Number(cs[i - 1].close);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-period);
  if (recent.length === 0) return null;
  return recent.reduce((s, x) => s + x, 0) / recent.length;
}

function relVolumeOf(candles: Candle[]): number | null {
  const cs = chrono(candles);
  const vols = cs.map((c) => Number(c.volume)).filter((v) => Number.isFinite(v) && v > 0);
  if (vols.length < 11) return null;
  const latest = vols[vols.length - 1];
  const hist = vols.slice(0, -1).slice(-20);
  if (hist.length === 0) return null;
  const avg = hist.reduce((s, v) => s + v, 0) / hist.length;
  return avg > 0 ? latest / avg : null;
}

function breadthState(breadth?: { advancing: number; declining: number; unchanged: number }): BreadthState {
  if (!breadth) return "MIXED";
  const total = breadth.advancing + breadth.declining + breadth.unchanged;
  if (total <= 0) return "MIXED";
  const pctAdv = (breadth.advancing / total) * 100;
  if (pctAdv >= 55) return "ADVANCING";
  if (pctAdv <= 45) return "DECLINING";
  return "MIXED";
}

export function analyzeMarketDirection(input: MarketDirectionInput): MarketDirectionResult {
  const { spotPrice, vix, pcr, maxPain } = input;
  const daily = emaRead(input.dailyCandles);
  const vwapVal = vwap(input.dailyCandles);
  const lastClose = finiteCloses(chrono(input.dailyCandles)).slice(-1)[0] ?? spotPrice;
  const breadth = breadthState(input.breadth);
  const rsi = input.dailyCandles.length >= 15 ? safeNum(calculateRSI(chrono(input.dailyCandles), 14)) : null;
  const macd = macdOf(input.dailyCandles);
  const adx = input.dailyCandles.length >= 15 ? safeNum(calculateADX(chrono(input.dailyCandles), 14)) : null;
  const atr = atrOf(input.dailyCandles);
  const relVolume = relVolumeOf(input.dailyCandles);

  const vixOk = typeof vix === "number" && Number.isFinite(vix);
  const pcrOk = typeof pcr === "number" && Number.isFinite(pcr);

  // ── Age check: daily bar must be recent, otherwise degrade ──
  const cs = chrono(input.dailyCandles);
  const latestTs = cs.length ? (cs[cs.length - 1] as any).timestamp : null;
  const ageHours = latestTs ? (Date.now() - latestTs) / 3_600_000 : Infinity;
  const stale = ageHours > 36;

  // ── Insufficient data: say so, never invent a trend ──
  if (input.dailyCandles.length < 10) {
    const detailsBase = "insufficient candle data — direction unavailable (no trend invented)";
    const details = stale ? `${detailsBase} · daily bars stale ${ageHours.toFixed(0)}h old` : detailsBase;
    return {
      trend: "SIDEWAYS",
      score: 50,
      details,
      niftyTrend: "Neutral (no candle data)",
      bankNiftyTrend: "Neutral (no candle data)",
      vixLevel: !vixOk ? "Unknown" : vix! > 20 ? "High" : vix! > 14 ? "Moderate" : "Low",
      breadth: breadth === "ADVANCING" ? "Advancing" : breadth === "DECLINING" ? "Declining" : "Mixed",
      globalCues: !vixOk ? "Global cues unavailable" : vix! > 20 ? "Global uncertainty elevated" : "Global markets supportive",
      multiTimeframe: {
        emaAlignment: "MIXED", vwapPosition: vwapVal == null ? "AT" : "AT", breadth,
        ema9: daily.ema9, ema21: daily.ema21, ema50: daily.ema50,
        rsi, macd, adx, atr, relVolume, timeframes: [],
      },
    };
  }

  // ── VWAP position ──
  let vwapPosition: VwapPosition = "AT";
  if (vwapVal != null && vwapVal > 0) {
    const diffPct = ((lastClose - vwapVal) / vwapVal) * 100;
    if (diffPct > 0.1) vwapPosition = "ABOVE";
    else if (diffPct < -0.1) vwapPosition = "BELOW";
  }

  // ── Multi-timeframe EMA alignment ──
  const timeframes: { tf: string; alignment: MTFAlignment }[] = [];
  if (daily.ema9 != null) timeframes.push({ tf: "daily", alignment: daily.alignment });
  const intradayAlignments: MTFAlignment[] = [];
  if (input.intradayCandles) {
    for (const tf of ["5m", "15m", "30m"]) {
      const c = input.intradayCandles[tf];
      if (c && c.length >= 10) {
        const r = emaRead(c);
        timeframes.push({ tf, alignment: r.alignment });
        if (r.alignment !== "MIXED") intradayAlignments.push(r.alignment);
      }
    }
  }
  const intradayBias: MTFAlignment =
    intradayAlignments.length === 0
      ? "MIXED"
      : intradayAlignments.filter((a) => a === "BULLISH").length >
        intradayAlignments.filter((a) => a === "BEARISH").length
      ? "BULLISH"
      : intradayAlignments.filter((a) => a === "BEARISH").length >
        intradayAlignments.filter((a) => a === "BULLISH").length
      ? "BEARISH"
      : "MIXED";

  // ── Composite score (50 = neutral) ──
  const notes: string[] = [];
  let score = 50;

  if (daily.alignment === "BULLISH") { score += 20; notes.push("daily EMA 9>21>50"); }
  else if (daily.alignment === "BEARISH") { score -= 20; notes.push("daily EMA 9<21<50"); }
  else notes.push("daily EMAs mixed");

  if (intradayBias === "BULLISH") { score += 10; notes.push("intraday EMAs bullish"); }
  else if (intradayBias === "BEARISH") { score -= 10; notes.push("intraday EMAs bearish"); }

  if (vwapPosition === "ABOVE") { score += 10; notes.push("price above VWAP"); }
  else if (vwapPosition === "BELOW") { score -= 10; notes.push("price below VWAP"); }

  if (breadth === "ADVANCING") { score += 10; notes.push("breadth advancing"); }
  else if (breadth === "DECLINING") { score -= 10; notes.push("breadth declining"); }

  if (rsi != null) {
    if (rsi > 55) score += 5;
    else if (rsi < 45) score -= 5;
  }
  if (macd != null) {
    if (macd > 0) score += 5;
    else if (macd < 0) score -= 5;
  }
  if (adx != null && adx > 25) {
    if (daily.alignment === "BULLISH") score += 3;
    else if (daily.alignment === "BEARISH") score -= 3;
  }

  // PCR / VIX — confirming only, never the sole driver.
  if (pcrOk) {
    if (pcr! > 1.1) score += 5;
    else if (pcr! < 0.9) score -= 5;
    notes.push(`PCR ${pcr!.toFixed(2)}${pcrOk ? "" : ""}`);
  } else {
    notes.push("PCR unavailable");
  }
  if (vixOk && vix! > 25) { score -= 10; notes.push(`high VIX ${vix!.toFixed(1)}`); }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Degrade if daily bars are stale
  if (stale) {
    score = Math.max(40, score - 20);
    notes.push(`daily bars stale ${ageHours.toFixed(0)}h old — direction degraded`);
  }

  let trend: MarketDirectionResult["trend"];
  if (vixOk && vix! > 25) trend = "VOLATILE";
  else if (score >= 75) trend = "STRONG_BULLISH";
  else if (score >= 60) trend = "BULLISH";
  else if (score >= 45) trend = "SIDEWAYS";
  else if (score >= 30) trend = "BEARISH";
  else trend = "STRONG_BEARISH";

  const niftyTrend =
    trend === "STRONG_BULLISH" || trend === "BULLISH" ? "Bullish"
    : trend === "STRONG_BEARISH" || trend === "BEARISH" ? "Bearish"
    : "Neutral";
  const breadthText = breadth === "ADVANCING" ? `Advancing (${input.breadth?.advancing ?? 0}/${(input.breadth?.advancing ?? 0) + (input.breadth?.declining ?? 0) + (input.breadth?.unchanged ?? 0)})` : breadth === "DECLINING" ? `Declining (${input.breadth?.declining ?? 0}/${(input.breadth?.advancing ?? 0) + (input.breadth?.declining ?? 0) + (input.breadth?.unchanged ?? 0)})` : "Mixed";

  return {
    trend,
    score,
    details: notes.join(" · "),
    niftyTrend,
    bankNiftyTrend: niftyTrend,
    vixLevel: !vixOk ? "Unknown" : vix! > 20 ? "High" : vix! > 14 ? "Moderate" : "Low",
    breadth: breadthText,
    globalCues: !vixOk ? "Global cues unavailable" : vix! > 20 ? "Global uncertainty elevated" : "Global markets supportive",
    multiTimeframe: {
      emaAlignment: daily.alignment,
      vwapPosition,
      breadth,
      ema9: daily.ema9,
      ema21: daily.ema21,
      ema50: daily.ema50,
      rsi,
      macd,
      adx,
      atr,
      relVolume,
      timeframes,
    },
  };
}

function safeNum(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}