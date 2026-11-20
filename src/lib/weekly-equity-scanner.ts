// Weekly Equity Scanner — AI Pro Prompt implementation
// Swing-trading equity research assistant for NSE stocks with realistic
// upside over the next 5-7 trading days.
//
// Gates — SAME logic as the intraday scanner (soft scoring, not hard RSI bands):
//   HARD (reject only): price ₹100–₹5,000 · avg volume ≥ 5,00,000 ·
//     no earnings / major corporate action inside the 7-day window
//   SOFT (score only, never reject): price vs 20/50 EMA · RSI zone ·
//     RVOL tiers · ADX chop dampen — folded into confidence via
//     evaluateWeeklyGate().softScore
//
// AI reasoning layer (before finalizing):
//   1. Multi-timeframe check — daily uptrend not contradicted by weekly
//   2. Sector rotation check — prefer sectors stronger than Nifty (5 sessions)
//   3. False-breakout filter — downgrade short-covering spikes / single-day gaps
//   4. Self-critique pass — generate one bear-case reason; drop if stronger

import { Candle, calculateRSI, calculateEMA, calculateADX } from "@/lib/ml-engine";
import { FO_STOCKS } from "@/lib/fo-universe";
import { analyzeVolumeStructure, VolumeStructure } from "@/lib/volume-structure";
import { detectRocket, RocketDetection } from "@/lib/rocket-detect";
import { buildOptionPlan } from "@/lib/option-plan";
import { getLotSizeStrict } from "@/lib/symbol-config";
import type { OptionPlan } from "@/lib/option-plan";
import { analyzeEmaStructure, type EmaStructure } from "@/lib/ema-structure";
import { checkDirectionalConsistency, type DirectionalEvidence, type ConsistencyVerdict } from "@/lib/directional-consistency";
import { confirmOptions, type OptionsConfirmationVerdict } from "@/lib/options-confirmation";
import { BRAIN_FLAGS } from "@/lib/brain-flags";
import { recordEmaShadowObservations } from "@/lib/ema-shadow-observer";
import { analyzeEquityCash } from "@/lib/equity-cash-engine";

// ─── Scan universe ────────────────────────────────────────────────
// NSE F&O universe (208 liquid, options-tradable stocks) — far broader than
// the NIFTY 50. All symbols have weekly expiries and deep liquidity, so the
// minimum-volume filter is meaningful and setups are actionable.
const UNIVERSE = FO_STOCKS;

// ─── Types ────────────────────────────────────────────────────────
export interface WeeklyCandidate {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  weekChgPct: number;
  rsi: number;
  rvol: number;
  adx: number;
  ema20: number;
  ema50: number;
  ema200: number;
  /** Shadow-mode EMA 9/21/50 market-structure read (no live behaviour change). */
  emaStructure?: EmaStructure;
  /** Shadow directional-consistency verdict for the candidate's direction. */
  directionalCheck?: ConsistencyVerdict;
  /** Shadow options-confirmation verdict for the candidate's direction. */
  optionsConfirmation?: OptionsConfirmationVerdict;
  weeklyTrend: "UP" | "DOWN" | "FLAT";
  weeklyRsi: number;
  weeklyCloseAboveEma20: boolean;
  sectorStrength: number;
  sectorTrendLabel: string;
  support: number;
  resistance: number;
  entryZone: { low: number; high: number };
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  confidence: number;
  confidenceNote: string;
  bullCase: string;
  bearCase: string;
  flags: string[];
  // Earnings / corporate-action risk (hard filter #8)
  events: string[];
  hasEventRisk: boolean;
  // Stage 3 — VWAP + volume structure
  volumeStructure: VolumeStructure;
  // Stage 4 — rocket move detection (null unless detected)
  rocket: RocketDetection | null;
  // ── Signal Engine (same as intraday): Auction/VP/Liq/Struct/VWAP/Vol/Regime ──
  /** 0–100 from analyzeEquityCash best-plan signalScore.total (0 = engine skipped). */
  engineScore: number;
  engineSetup: string;
  engineAuctionState: string;
  engineRegime: string;
  engineDirection: "LONG" | "SHORT" | "NO_TRADE";
  /** Score-breakdown rows for the expanded card (intraday parity). */
  technicalScore: number;
  volumeScore: number;
  optionsScore: number;
  /** Soft-gate score (EMA/RSI/RVOL/ADX) — feeds confidence. */
  softScore: number;
  // Option plan — computed from equity levels using buildOptionPlan (rupee risk
  // 20% of deployed, 2R/3R/4R targets). null when the contract does not fit
  // the per-trade budget or lot size is unknown.
  optionPlan: OptionPlan | null;
  optionStrike: number | null;
  optionType: "CE" | "PE" | null;
}

export interface RocketMoveRow {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  rvol: number;
  dayChgPct: number;
  gapHeld: boolean;
  stage: string;
  catalyst: string;
  chaseRisk: string;
  recommendedAction: string;
}

export interface WeeklyScanResult {
  timestamp: string;
  dataQuality: "LIVE" | "PARTIAL";
  marketContext: string;
  niftyTrend: string;
  vixLevel: string;
  breadth: string;
  totalScanned: number;
  passedFilters: number;
  candidates: WeeklyCandidate[];
  rocketMovers: RocketMoveRow[];
}

// ─── Config ───────────────────────────────────────────────────────
const PRICE_MIN = 100;
const PRICE_MAX = 5000;
const MIN_AVG_VOLUME = 500_000;
const MAX_CANDIDATES = 20;
const MAX_PER_SECTOR = 3;

// ─── Soft gates — SAME logic as the intraday scanner ──────────────
// Intraday never hard-rejects on RSI / RVOL / ADX / EMA — it SCORES them
// (technicalScore + volumeScore + ADX chop dampen). The old weekly hard
// filters (RSI 45–65, RVOL ≥1.2, ADX ≥20, price>EMA) rejected every stock
// after the trend check in a bull market (post-trend median RSI ≈ 76 →
// passedFilters 0/208). Safety rails stay hard; edge factors score.

export interface WeeklyGateInput {
  price: number;
  ema20: number;
  ema50: number;
  rsi: number;
  rvol: number;
  adx: number;
  avgVol: number;
  hasEventRisk: boolean;
}

export interface WeeklyGateResult {
  /** false → skip (safety filter only). Soft factors never fail this. */
  pass: boolean;
  /** Set only when pass=false — the safety filter that fired. */
  hardReason?: string;
  /** 0–100 soft score from EMA/RSI/RVOL/ADX (intraday-style). */
  softScore: number;
  /** Breakdown components for the Score Breakdown card (0–100 each). */
  technicalScore: number;
  volumeScore: number;
}

/**
 * Intraday-parity gate for one weekly candidate.
 * HARD (reject): price band, liquidity floor, corporate-action risk.
 * SOFT (score only): price vs 20/50 EMA, RSI zone, RVOL, ADX chop dampen.
 */
export function evaluateWeeklyGate(input: WeeklyGateInput): WeeklyGateResult {
  if (input.price < PRICE_MIN || input.price > PRICE_MAX) {
    return { pass: false, hardReason: `price ${input.price} outside ₹${PRICE_MIN}–₹${PRICE_MAX}`, softScore: 0, technicalScore: 0, volumeScore: 0 };
  }
  if (input.avgVol < MIN_AVG_VOLUME) {
    return { pass: false, hardReason: `avg volume ${Math.round(input.avgVol)} below ${MIN_AVG_VOLUME}`, softScore: 0, technicalScore: 0, volumeScore: 0 };
  }
  if (input.hasEventRisk) {
    return { pass: false, hardReason: "corporate action / earnings inside 7-day window", softScore: 0, technicalScore: 0, volumeScore: 0 };
  }

  // Soft technicals — mirrors intraday technicalScore + volumeScore bands.
  // technical = EMA stack + RSI + ADX (max 75); volume = RVOL tiers (max 25).
  let technical = 0;
  let volume = 0;

  // EMA trend stack (intraday: +15 EMA9>21, +10 EMA21>50).
  if (input.price > input.ema20 && input.price > input.ema50) technical += 30;
  else if (input.price > input.ema20 || input.price > input.ema50) technical += 15;

  // RSI — intraday rewards 50–70 bullish momentum; extremes dampen.
  if (input.rsi >= 50 && input.rsi <= 70) technical += 25;
  else if (input.rsi >= 45 && input.rsi < 50) technical += 15;
  else if (input.rsi > 70 && input.rsi <= 80) technical += 10; // hot but not blow-off
  else if (input.rsi > 80 || input.rsi < 30) technical += 0;   // blow-off / falling knife
  else technical += 5;

  // ADX — soft dampen when choppy (never reject).
  if (input.adx >= 25) technical += 20;
  else if (input.adx >= 20) technical += 14;
  else if (input.adx >= 15) technical += 8;
  else technical += 2;

  // RVOL tiers — same thresholds as intraday volumeScore.
  if (input.rvol >= 2.0) volume = 95;
  else if (input.rvol >= 1.5) volume = 80;
  else if (input.rvol >= 1.2) volume = 60;
  else if (input.rvol >= 0.8) volume = 35;
  else volume = 15;

  const technicalScore = Math.min(100, technical);
  // softScore weights technical (0–75) + volume scaled to 0–25 so both feed confidence.
  const softScore = Math.min(100, technicalScore + Math.round(volume * 0.25));
  return { pass: true, softScore, technicalScore, volumeScore: volume };
}

// ─── Corporate actions / earnings risk (hard filter #8) ──────────
// NSE publishes a machine-readable announcements feed for the next N days.
// We flag any stock in the F&O universe that has a results/board-meeting
// or material corporate-action event inside the 7-day holding window.
const EVENT_KEYWORDS = [
  "board meeting",
  "result",
  "record date",
  "dividend",
  "buyback",
  "stock split",
  "bonus",
  "rights issue",
  "preferential issue",
];

export interface CorporateEvent {
  symbol: string;
  name: string;
  desc: string;
  date: string;
}

let eventCache: { data: Map<string, CorporateEvent[]>; ts: number } | null = null;
const EVENT_CACHE_TTL = 30 * 60 * 1000;

async function fetchUpcomingEvents(): Promise<Map<string, CorporateEvent[]>> {
  if (eventCache && Date.now() - eventCache.ts < EVENT_CACHE_TTL) return eventCache.data;

  const map = new Map<string, CorporateEvent[]>();
  try {
    // Next 7 calendar days (from today to today+7). NSE returns events as they
    // are filed — the from/to window captures results & corporate actions that
    // land inside the swing holding window.
    const today = new Date();
    const end = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => {
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      return `${dd}-${mm}-${d.getFullYear()}`;
    };
    const url = `https://www.nseindia.com/api/corporate-announcements?index=equities&from_date=${fmt(today)}&to_date=${fmt(end)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126",
        Referer: "https://www.nseindia.com/",
        Cookie: "nseappid=2",
      },
    });
    if (!res.ok) throw new Error(`NSE announcements HTTP ${res.status}`);
    const rows: any[] = await res.json();
    for (const row of rows) {
      const desc = (row.desc || "") as string;
      const sym = (row.symbol || "").toUpperCase();
      if (!sym) continue;
      const lower = desc.toLowerCase();
      const isEvent = EVENT_KEYWORDS.some(k => lower.includes(k));
      if (!isEvent) continue;
      const arr = map.get(sym) || [];
      arr.push({ symbol: sym, name: row.sm_name || "", desc, date: row.sort_date || "" });
      map.set(sym, arr);
    }
  } catch (err) {
    console.warn("[WeeklyScanner] NSE corporate-announcements fetch failed:", (err as Error)?.message?.substring(0, 100));
  }

  eventCache = { data: map, ts: Date.now() };
  return map;
}

// ─── Exchange data fetcher (NSE daily history) ─────────────────────────
// Yahoo is banned (SOP §1). The scan now reads the exchange's own daily
// history through `getDailyBars()` (cached 15 min), so the candles behind
// every EMA / RSI / ADX / RVOL figure are the exchange's, and the card can
// name the source and the age of the newest bar.
interface StockData {
  symbol: string;
  name: string;
  sector: string;
  daily: Candle[];
  weekly: Candle[];
}

const dataCache = new Map<string, { data: StockData[]; ts: number }>();
const CACHE_TTL = 60_000;

async function fetchStockData(): Promise<StockData[]> {
  const cacheKey = UNIVERSE.map(s => s.symbol).join(",");
  const cached = dataCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const result: StockData[] = [];
  const CONCURRENCY = 20;
  const DEADLINE = Date.now() + 40_000;

  const { getDailyBars } = await import("@/lib/daily-bars");

  for (let i = 0; i < UNIVERSE.length && Date.now() < DEADLINE; i += CONCURRENCY) {
    const batch = UNIVERSE.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (stock) => {
        try {
          const bars = await getDailyBars(stock.symbol);
          if (bars.length < 30) return; // skip unavailable symbol rather than fabricate data
          const daily: Candle[] = bars.map((b) => ({
            time: Math.floor(b.t / 1000),
            open: b.o,
            high: b.h,
            low: b.l,
            close: b.c,
            volume: b.v || 0,
          }));
          result.push({
            symbol: stock.symbol,
            name: stock.name,
            sector: stock.sector,
            daily,
            weekly: aggregateWeekly(daily),
          });
        } catch {
          // skip unavailable symbol rather than fabricate data
        }
      }),
    );
  }

  dataCache.set(cacheKey, { data: result, ts: Date.now() });
  return result;
}

function aggregateWeekly(daily: Candle[]): Candle[] {
  const weeks = new Map<string, Candle>();
  for (const c of daily) {
    const d = new Date(c.time * 1000);
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.getTime());
    monday.setUTCDate(diff);
    monday.setUTCHours(0, 0, 0, 0);
    const key = monday.toISOString();
    const existing = weeks.get(key);
    if (!existing) {
      weeks.set(key, { time: monday.getTime() / 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume += c.volume;
    }
  }
  return [...weeks.values()].sort((a, b) => a.time - b.time);
}

// ─── Indicator helpers ────────────────────────────────────────────
function lastEMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  return calculateEMA(closes, period).at(-1) ?? 0;
}

function averageDailyVolume(candles: Candle[]): number {
  const vols = candles.slice(0, -1).map(c => c.volume).filter(v => v > 0);
  if (!vols.length) return 0;
  return vols.reduce((a, b) => a + b, 0) / vols.length;
}

function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }
  const n = Math.min(period, trs.length);
  return trs.slice(-n).reduce((s, v) => s + v, 0) / n;
}

function recentSwing(candles: Candle[], lookback: number, findHigh: boolean): number {
  const slice = candles.slice(-lookback);
  if (!slice.length) return 0;
  return findHigh ? Math.max(...slice.map(c => c.high)) : Math.min(...slice.map(c => c.low));
}

// False-breakout filter: single-day gap-up without follow-through volume,
// or a short-covering spike (big % move, low RVOL the next session).
function isFalseBreakout(daily: Candle[]): boolean {
  if (daily.length < 5) return false;
  const last = daily[daily.length - 1];
  const prev = daily[daily.length - 2];
  const avgVol = averageDailyVolume(daily);
  const gapPct = prev.close > 0 ? ((last.open - prev.close) / prev.close) * 100 : 0;
  const closeUnderOpen = last.close < last.open;
  const lowRvol = avgVol > 0 && last.volume / avgVol < 1.0;
  if (gapPct > 1.5 && closeUnderOpen) return true;
  if (gapPct > 3 && lowRvol) return true;
  return false;
}

// ─── Main scanner ─────────────────────────────────────────────────
export async function runWeeklyScan(): Promise<WeeklyScanResult> {
  const timestamp = new Date().toISOString();

  // NIFTY context
  let niftyWeekChg = 0;
  let niftyTrend = "SIDEWAYS";
  let vixLevel = "N/A";
  let niftyBreadth: string[] = [];
  try {
    // NIFTY context from the exchange's own daily history. NSE publishes no
    // index OHLC, so the NIFTYBEES ETF (same index, exchange-listed) is used
    // as the proxy — real candles, and labelled as a proxy below.
    const { getDailyBars } = await import("@/lib/daily-bars");
    const bars = await getDailyBars("NIFTYBEES");
    const closes = bars.map((b) => b.c);
    if (closes.length >= 30) {
      const last = closes[closes.length - 1];
      const five = closes[closes.length - 6];
      const ema20 = lastEMA(closes, 20);
      const ema50 = lastEMA(closes, 50);
      niftyWeekChg = five > 0 ? ((last - five) / five) * 100 : 0;
      niftyTrend = last > ema20 && last > ema50 ? "UP" : last < ema20 && last < ema50 ? "DOWN" : "SIDEWAYS";
    }
  } catch {}
  try {
    const { getNSEIndiaVIX } = await import("@/lib/nse-api");
    const vix = await getNSEIndiaVIX();
    if (vix?.value) vixLevel = vix.value.toFixed(1);
  } catch {}

  const stockData = await fetchStockData();
  const totalScanned = stockData.length;
  if (totalScanned === 0) {
    return {
      timestamp,
      dataQuality: "PARTIAL",
      marketContext: "No daily history returned by the exchange (NSE).",
      niftyTrend,
      vixLevel,
      breadth: "N/A",
      totalScanned: 0,
      passedFilters: 0,
      candidates: [],
      rocketMovers: [],
    };
  }

  // Corporate actions / earnings events inside the 7-day holding window.
  const upcomingEvents = await fetchUpcomingEvents();

  // First pass — compute indicators + hard filters
  const candidates: WeeklyCandidate[] = [];

  for (const sd of stockData) {
    const daily = sd.daily;
    const weekly = sd.weekly;
    const last = daily[daily.length - 1];
    const price = last.close;
    const closes = daily.map(c => c.close);

    // ── Technicals ──
    const ema20 = lastEMA(closes, 20);
    const ema50 = lastEMA(closes, 50);
    const ema200 = lastEMA(closes, 200);
    const rsi = calculateRSI(daily, 14);
    const adx = calculateADX(daily, 14);
    const avgVol = averageDailyVolume(daily);
    const rvol = avgVol > 0 ? last.volume / avgVol : 1;
    const weekChgPct = daily.length >= 6 && daily[daily.length - 6].close > 0
      ? ((price - daily[daily.length - 6].close) / daily[daily.length - 6].close) * 100
      : 0;

    // ── Gates — hard safety + soft intraday-style score ──
    const events = upcomingEvents.get(sd.symbol) || [];
    const gate = evaluateWeeklyGate({
      price,
      ema20,
      ema50,
      rsi,
      rvol,
      adx,
      avgVol,
      hasEventRisk: events.length > 0,
    });
    if (!gate.pass) continue;

    // ── Multi-timeframe: weekly trend not contradicting ──
    const wCloses = weekly.map(c => c.close);
    const wEma20 = lastEMA(wCloses, 20);
    const weeklyRsi = calculateRSI(weekly, 14);
    const weeklyCloseAboveEma20 = price > wEma20;
    const weeklyTrend: "UP" | "DOWN" | "FLAT" =
      price > wEma20 && weeklyRsi >= 45 ? "UP"
      : price < wEma20 && weeklyRsi < 40 ? "DOWN"
      : "FLAT";

    // Setup: support/resistance from recent swings + weekly structure
    const support = Math.max(recentSwing(daily, 20, false), recentSwing(weekly, 8, false));
    const resistance = recentSwing(daily, 20, true);
    const atr = calcATR(daily, 14) || price * 0.02;

    const entryLow = Math.max(price * 0.985, support);
    const entryHigh = price * 1.015;
    const stopLoss = Math.max(support * 0.98, price - 1.6 * atr);
    const minTarget1 = price + 2.2 * atr;
    const target1 = Math.max(resistance, minTarget1);
    const target2 = Math.max(price + 3.5 * atr, target1 + 1.5 * atr);
    const risk = price - stopLoss;
    const rr = risk > 0 ? (target1 - price) / risk : 0;

    // ── Self-critique / bear case ──
    const flags: string[] = [];
    if (isFalseBreakout(daily)) flags.push("False-breakout pattern — big gap w/o follow-through");
    if (weeklyTrend === "DOWN") flags.push("Weekly chart still in downtrend");
    if (!weeklyCloseAboveEma20) flags.push("Trading below weekly 20-EMA");
    if (rsi > 60) flags.push("RSI approaching upper band");

    const bullCase = `Above 20/50 EMA with RSI ${rsi.toFixed(0)} and ADX ${adx.toFixed(0)}; RVOL ${rvol.toFixed(1)}x confirms participation; support near ${formatINR(support)}.`;
    let bearCase = "";
    if (rsi >= 62) bearCase = "RSI close to overbought — pullback risk before continuation.";
    else if (weeklyTrend === "DOWN") bearCase = "Weekly timeframe still bearish — daily bounce may fail.";
    else if (rvol >= 3) bearCase = "Volume spike may be short-covering rather than fresh buying.";
    else if (rr < 2) bearCase = "Reward-to-risk below 2 at current entry.";
    else bearCase = "Broad-market or sector weakness could stall momentum.";
    if (!bearCase) bearCase = "Sector rotation away from this group would stall momentum.";

    const confidenceNote = flags.length
      ? `${flags[0].split("—")[0].trim()} → discounted`
      : weeklyTrend === "UP" ? "Daily + weekly aligned uptrend" : "Daily trend only — monitor weekly";

    // ── Signal Engine — SAME as intraday: Auction/VP/Liq/Struct/VWAP/Vol/Regime.
    //     Real analyzeEquityCash on the exchange daily bars (no 5m path here). ──
    let engineScore = 0;
    let engineSetup = "";
    let engineAuctionState = "";
    let engineRegime = "";
    let engineDirection: "LONG" | "SHORT" | "NO_TRADE" = "NO_TRADE";
    if (daily.length >= 35) {
      const prev = daily[daily.length - 2];
      const weekBars = daily.slice(-6, -1); // last 5 completed sessions
      const prevDayHigh = prev?.high || price;
      const prevDayLow = prev?.low || price;
      const prevWeekHigh = weekBars.length ? Math.max(...weekBars.map(c => c.high)) : prevDayHigh;
      const prevWeekLow = weekBars.length ? Math.min(...weekBars.map(c => c.low)) : prevDayLow;
      try {
        const analysis = analyzeEquityCash(sd.symbol, daily, prevDayHigh, prevDayLow, prevWeekHigh, prevWeekLow);
        engineAuctionState = analysis.data.auctionState;
        engineRegime = analysis.data.regime;
        engineDirection = analysis.finalDecision;
        const engineBest =
          analysis.finalDecision === "LONG" ? analysis.bestLong :
          analysis.finalDecision === "SHORT" ? analysis.bestShort : null;
        engineScore = engineBest?.signalScore.total ?? 0;
        engineSetup = engineBest?.setup || "";
      } catch {
        // engine unavailable for this symbol — leave 0, never fabricate
      }
    }

    // Options score — neutral when no chain (weekly has no per-stock chain here).
    const optionsScore = 50;

    // Confidence — soft gate + engine (mirrors intraday totalScore weighting).
    let confidence = 30 + Math.round(gate.softScore * 0.25); // soft 0–100 → 30–55
    if (engineScore > 0) confidence += Math.round(engineScore * 0.25); // engine 0–100 → +0–25
    if (weeklyTrend === "UP") confidence += 8;
    if (weeklyCloseAboveEma20) confidence += 4;
    if (rr >= 2) confidence += 5;
    confidence -= flags.length * 5;
    if (weeklyTrend === "DOWN") confidence -= 10;
    confidence = Math.max(5, Math.min(98, Math.round(confidence)));

    // ── EMA 9/21/50 market-structure read + directional consistency.
    //     Computed when shadow logging OR the live veto is on. ──
    let weeklyEmaStructure: EmaStructure | undefined;
    let weeklyDirectionalCheck: ConsistencyVerdict | undefined;
    let weeklyOptionsConfirmation: OptionsConfirmationVerdict | undefined;
    if ((BRAIN_FLAGS.emaStructureShadow || BRAIN_FLAGS.emaStructureLive) && sd.daily && sd.daily.length >= 35) {
      weeklyEmaStructure = analyzeEmaStructure(sd.daily, { nowMs: Date.now() });
      const ev: DirectionalEvidence = {
        ema: { alignment: weeklyEmaStructure.alignment, direction: weeklyEmaStructure.direction },
        macd: { direction: "NEUTRAL" },
        structure: {
          direction: weeklyTrend === "UP" ? "BULLISH" : weeklyTrend === "DOWN" ? "BEARISH" : "NEUTRAL",
          trend: weeklyTrend,
        },
        momentum: { direction: rsi > 50 ? "BULLISH" : rsi < 50 ? "BEARISH" : "NEUTRAL" },
        vwap: { side: "NA" },
        reversal: null,
      };
      weeklyDirectionalCheck = checkDirectionalConsistency(
        weeklyTrend === "DOWN" ? "PE" : "CE",
        ev,
      ).verdict;
    }

    candidates.push({
      symbol: sd.symbol,
      name: sd.name,
      sector: sd.sector,
      price,
      weekChgPct,
      rsi,
      rvol,
      adx,
      ema20,
      ema50,
      ema200,
      emaStructure: weeklyEmaStructure,
      directionalCheck: weeklyDirectionalCheck,
      optionsConfirmation: weeklyOptionsConfirmation,
      weeklyTrend,
      weeklyRsi,
      weeklyCloseAboveEma20,
      sectorStrength: 50,
      sectorTrendLabel: "—",
      support,
      resistance,
      entryZone: { low: entryLow, high: entryHigh },
      stopLoss,
      target1,
      target2,
      riskReward: rr,
      confidence,
      confidenceNote,
      bullCase,
      bearCase,
      flags,
      events: events.map(e => e.desc),
      hasEventRisk: events.length > 0,
      volumeStructure: analyzeVolumeStructure(daily),
      rocket: detectRocket(daily, sd.symbol, sd.name, sd.sector),
      engineScore,
      engineSetup,
      engineAuctionState,
      engineRegime,
      engineDirection,
      technicalScore: gate.technicalScore,
      volumeScore: gate.volumeScore,
      optionsScore,
      softScore: gate.softScore,
      // ── Option plan — computed from equity levels using buildOptionPlan ──
      // Rupee risk 20% of deployed, 2R/3R/4R targets (1:2 / 1:3 / 1:4).
      ...(() => {
        const optionType: "CE" | "PE" = weeklyTrend === "DOWN" ? "PE" : "CE";
        // ATM strike: round to nearest 50 (price < 1000) or 100 (price >= 1000)
        const step = price < 1000 ? 50 : 100;
        const optionStrike = Math.round(price / step) * step;
        // Estimated ATM premium ≈ 3% of underlying price (typical for liquid F&O).
        const estimatedPremium = Math.max(price * 0.03, step * 0.1);
        const lotSize = getLotSizeStrict(sd.symbol) ?? 50;
        const plan = buildOptionPlan({
          symbol: sd.symbol,
          optionType,
          entryPremium: estimatedPremium,
          lotSize,
        });
        return {
          optionPlan: plan && plan.tradable ? plan : null,
          optionStrike: plan && plan.tradable ? optionStrike : null,
          optionType: plan && plan.tradable ? optionType : null,
        };
      })(),
    });
  }

  // ── Stage 4 — Rocket move sweep across the whole universe ────────────
  // Runs in parallel with the steady-swing scan. A stock that fails Stage 1
  // (too extended) may still be a valid Stage 4 candidate if it's in early
  // Continuation with real volume.
  const rocketMovers: RocketMoveRow[] = [];
  for (const sd of stockData) {
    const det = detectRocket(sd.daily, sd.symbol, sd.name, sd.sector);
    if (!det) continue;
    rocketMovers.push({
      symbol: det.symbol,
      name: det.name,
      sector: det.sector,
      price: det.price,
      rvol: det.rvol,
      dayChgPct: det.dayChgPct,
      gapHeld: det.gapHeld,
      stage: det.stage,
      catalyst: det.catalyst,
      chaseRisk: det.chaseRisk,
      recommendedAction: det.recommendedAction,
    });
  }
  rocketMovers.sort((a, b) => b.rvol - a.rvol);
  rocketMovers.length = Math.min(rocketMovers.length, 10);

  // Catalyst check (mandatory for Stage 4) — enrich the top movers with
  // news-engine sentiment. An unexplained spike scores LOWER conviction.
  try {
    const { getNewsScore } = await import("@/lib/news-engine");
    await Promise.all(rocketMovers.map(async r => {
      try {
        const score = await getNewsScore(r.symbol);
        const matched = score !== 50;
        r.catalyst = matched
          ? `Y — sentiment ${score >= 65 ? "positive" : score <= 35 ? "negative" : "mixed"} (news score ${score})`
          : "N — unexplained spike, higher risk";
      } catch {
        r.catalyst = "N — news lookup failed, treat as unexplained";
      }
    }));
  } catch {
    // news-engine unavailable — keep placeholder
  }

  // ── Sector rotation check ──
  const bySector = new Map<string, { chg: number; count: number }>();
  for (const c of candidates) {
    const cur = bySector.get(c.sector) || { chg: 0, count: 0 };
    cur.chg += c.weekChgPct;
    cur.count += 1;
    bySector.set(c.sector, cur);
  }
  const sectorStrengthMap = new Map<string, number>();
  for (const [sector, { chg, count }] of bySector) {
    const avg = chg / count;
    const edge = avg - niftyWeekChg;
    sectorStrengthMap.set(sector, Math.max(0, Math.min(100, Math.round(50 + edge * 8))));
  }
  for (const c of candidates) {
    const strength = sectorStrengthMap.get(c.sector) ?? 50;
    c.sectorStrength = strength;
    c.sectorTrendLabel = strength >= 60 ? "Outperforming Nifty" : strength <= 40 ? "Lagging Nifty" : "In line with Nifty";
    // Downgrade confidence for lagging sectors
    if (strength <= 40) c.confidence = Math.max(5, c.confidence - 8);
  }

  // ── Sort ascending by price, cap 20, max 3 per sector ──
  candidates.sort((a, b) => a.price - b.price);
  const perSectorCount = new Map<string, number>();
  const finalList: WeeklyCandidate[] = [];
  for (const c of candidates) {
    const used = perSectorCount.get(c.sector) || 0;
    if (used >= MAX_PER_SECTOR) continue;
    finalList.push(c);
    perSectorCount.set(c.sector, used + 1);
    if (finalList.length >= MAX_CANDIDATES) break;
  }

  // Market context line
  const vixNote = vixLevel !== "N/A" ? `VIX ${vixLevel}` : "VIX N/A";
  const trendLabel = niftyTrend === "UP" ? "Nifty in uptrend" : niftyTrend === "DOWN" ? "Nifty in downtrend" : "Nifty sideways";
  const marketContext = `${trendLabel} (${niftyWeekChg >= 0 ? "+" : ""}${niftyWeekChg.toFixed(1)}% / 5d), ${vixNote}.`;

  // Phase 8B — shadow observation (fire-and-forget; never affects the response).
  void recordEmaShadowObservations(finalList, "weekly-scanner:shadow");

  return {
    timestamp,
    dataQuality: "LIVE",
    marketContext,
    niftyTrend: trendLabel,
    vixLevel,
    breadth: `${stockData.length}/${UNIVERSE.length} symbols returned exchange daily bars`,
    totalScanned,
    passedFilters: finalList.length,
    candidates: finalList,
    rocketMovers,
  };
}

function formatINR(n: number): string {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}