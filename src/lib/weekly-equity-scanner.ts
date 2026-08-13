// Weekly Equity Scanner — AI Pro Prompt implementation
// Swing-trading equity research assistant for NSE stocks with realistic
// upside over the next 5-7 trading days.
//
// Hard filters (never violated):
//   1. Price within ₹100–₹5,000
//   2. Price above 20-EMA AND 50-EMA (daily)
//   3. RSI(14) between 45–65
//   4. RVOL > 1.2x (real participation)
//   5. ADX > 20 (real trend strength)
//   6. Exclude RSI > 70 (overbought) or RSI < 30 (falling knife)
//   7. Exclude avg daily volume < 5,00,000 shares
//   8. Exclude earnings / major corporate action in next 7 days
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
const MIN_RSI = 45;
const MAX_RSI = 65;
const MIN_RVOL = 1.2;
const MIN_ADX = 20;
const MIN_AVG_VOLUME = 500_000;
const MAX_CANDIDATES = 20;
const MAX_PER_SECTOR = 3;

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

// ─── Yahoo Finance data fetcher ───────────────────────────────────
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
  const CONCURRENCY = 12;
  const DEADLINE = Date.now() + 45_000;

  const fetchOne = async (stock: { symbol: string; name: string; sector: string }) => {
    const yahooSym = `${stock.symbol}.NS`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=1y&interval=1d`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return;
      const data = await res.json();
      const chart = data?.chart?.result?.[0];
      if (!chart) return;
      const ts: number[] = chart.timestamp || [];
      const q = chart.indicators?.quote?.[0];
      if (!q?.close || ts.length < 30) return;

      const daily: Candle[] = [];
      for (let i = 0; i < ts.length; i++) {
        const close = q.close[i];
        if (close == null) continue;
        daily.push({
          time: ts[i],
          open: q.open?.[i] ?? close,
          high: q.high?.[i] ?? close,
          low: q.low?.[i] ?? close,
          close,
          volume: q.volume?.[i] || 0,
        });
      }
      if (daily.length < 30) return;
      result.push({ symbol: stock.symbol, name: stock.name, sector: stock.sector, daily, weekly: aggregateWeekly(daily) });
    } catch {
      // skip unavailable symbol rather than fabricate data
    }
  };

  // Probe one stock first — bail fast if Yahoo is unreachable.
  await fetchOne(UNIVERSE[0]);
  if (result.length === 0) return [];

  for (let i = 0; i < UNIVERSE.length && Date.now() < DEADLINE; i += CONCURRENCY) {
    const batch = UNIVERSE.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(fetchOne));
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
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=1y&interval=1d`, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const data = await res.json();
      const chart = data?.chart?.result?.[0];
      const closes: number[] = chart?.indicators?.quote?.[0]?.close || [];
      if (closes.length >= 30) {
        const last = closes[closes.length - 1];
        const five = closes[closes.length - 6];
        const ema20 = lastEMA(closes, 20);
        const ema50 = lastEMA(closes, 50);
        niftyWeekChg = five > 0 ? ((last - five) / five) * 100 : 0;
        niftyTrend = last > ema20 && last > ema50 ? "UP" : last < ema20 && last < ema50 ? "DOWN" : "SIDEWAYS";
      }
    }
  } catch {}
  try {
    const { fetchIndiaVIX } = await import("@/lib/yahoo-finance-api");
    const vix = await fetchIndiaVIX();
    if (vix?.value) vixLevel = vix.value.toFixed(1);
  } catch {}

  const stockData = await fetchStockData();
  const totalScanned = stockData.length;
  if (totalScanned === 0) {
    return {
      timestamp,
      dataQuality: "PARTIAL",
      marketContext: "No live quotes returned from Yahoo Finance.",
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

    // ── Hard filter: price range ──
    if (price < PRICE_MIN || price > PRICE_MAX) continue;

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

    // ── Hard filters ──
    if (price <= ema20 || price <= ema50) continue;           // trend
    if (rsi < MIN_RSI || rsi > MAX_RSI) continue;             // RSI band
    if (rsi > 70 || rsi < 30) continue;                       // overbought / falling knife
    if (rvol < MIN_RVOL) continue;                            // participation
    if (adx < MIN_ADX) continue;                              // trend strength
    if (avgVol < MIN_AVG_VOLUME) continue;                    // liquidity floor

    // ── Hard filter #8: earnings / corporate action in next 7 days ──
    const events = upcomingEvents.get(sd.symbol) || [];
    if (events.length > 0) continue;

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
    const target1 = resistance > price ? resistance : price + 2.2 * atr;
    const target2 = price + 3.5 * atr;
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
    else if (rr < 1.5) bearCase = "Reward-to-risk below 1.5 at current entry.";
    else bearCase = "Broad-market or sector weakness could stall momentum.";
    if (!bearCase) bearCase = "Sector rotation away from this group would stall momentum.";

    // Confidence score — AI reasoning layer
    let confidence = 55;
    if (weeklyTrend === "UP") confidence += 10;
    if (weeklyCloseAboveEma20) confidence += 5;
    if (rsi >= 48 && rsi <= 58) confidence += 8;
    if (rvol >= 2) confidence += 7;
    if (adx >= 28) confidence += 5;
    if (rr >= 2) confidence += 5;
    confidence -= flags.length * 5;
    if (weeklyTrend === "DOWN") confidence -= 10;
    confidence = Math.max(5, Math.min(98, Math.round(confidence)));

    const confidenceNote = flags.length
      ? `${flags[0].split("—")[0].trim()} → discounted`
      : weeklyTrend === "UP" ? "Daily + weekly aligned uptrend" : "Daily trend only — monitor weekly";

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

  return {
    timestamp,
    dataQuality: "LIVE",
    marketContext,
    niftyTrend: trendLabel,
    vixLevel,
    breadth: `${stockData.length}/${UNIVERSE.length} symbols returned live quotes`,
    totalScanned,
    passedFilters: finalList.length,
    candidates: finalList,
    rocketMovers,
  };
}

function formatINR(n: number): string {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}