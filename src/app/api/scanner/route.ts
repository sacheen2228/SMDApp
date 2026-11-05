// Intraday Scanner API
// Returns high-probability intraday stock setups for NSE India
//
// Provenance rules (2026-10-20 audit):
//   • The option chain comes from the canonical data-layer chain
//     (NSE primary / BSE for SENSEX / MO fallback) — one implementation, with
//     the provider's own timestamp.
//   • VIX comes from NSE. It used to default to 15, which is a real-looking
//     number that changed the market-direction score.
//   • Spot used to default to 24 000 and max pain to the spot price — both
//     were invented numbers on a failed feed.
//   • `dataQuality` used to be a quote COUNT ("SIMULATED" when the scan
//     returned nothing — nothing was simulated, the feed was simply dead).
//     It is now derived from the ACTUAL source + age of every input.
//   • Yahoo is banned (SOP §1): the Yahoo quote helper that lived here is
//     gone; prices come from the exchange feeds only.

import { NextRequest, NextResponse } from "next/server";
import {
  runIntradayScan,
  recordIntradayScannerResults,
  recordIntradayScannerSignals,
  type ScannerConfig,
  type ScannerMarketData,
} from "@/lib/intraday-scanner";
import { sendTradeAlert } from "@/lib/telegram";
import { isChainFresh, isPlausibleOptionPlan } from "@/lib/sendIntradayAlerts";
import { fetchAllOptionChains } from "@/lib/breeze-fno-data";
import { getCachedMarketNews } from "@/lib/news-engine";
import { scoreTrade, type MarketDataInput, type StrategyProfile } from "@/lib/unified-scoring-engine";
import { isPlausibleOptionSymbol } from "@/lib/stockUniverse";
import { fetchLiveOptionChain } from "@/lib/live-option-chain";
import { getNSEIndiaVIX, getNSEIndexQuote } from "@/lib/nse-api";
import { getStockQuoteProvenance } from "@/lib/nse-stock-data";
import { buildCardMeta, getMarketClock, round } from "@/lib/data-freshness";
import { classifyScannerDataQuality, type DataQuality, type SourceStatus } from "@/lib/scanner-data-quality";
import { getMOCandles } from "@/lib/motilal/candles";
import { alertScannerStock, scannerTradeId } from "@/lib/scanner-stock-alerts";

// Unified Intraday Intelligence Engine — additive layer on the Scanner tab.
// Computes a coordinator decision (BUY CE / BUY PE / WAIT) for the index
// symbol and a per-candidate unified signal, using data the scan already
// fetched (no redundant network calls). Does not replace existing scanner
// scoring, alerts, or trade registration.
import {
  computeIndicatorBundle,
  indicatorsSufficientForTrade,
} from "@/lib/unified-engine/indicators";
import { readSMC } from "@/lib/unified-engine/smc";
import { detectMarketMechanism } from "@/lib/unified-engine/mechanism";
import { coordinateDecision } from "@/lib/unified-engine/coordinator";
import { buildMarketContext } from "@/lib/unified-engine/market-context";
import type { SectorBreadthResult } from "@/lib/universe/sector-breadth";
import type { Candle } from "@/types/engine";

// How many cash-equity setups one scan may alert (the shortlist can hold
// dozens — a phone cannot be used as a ticker tape).
const MAX_SCANNER_EQUITY_ALERTS = 3;
// Score floor for a cash-equity alert — the SAME floor the option path in
// this route uses (65), so both expressions of one setup are judged alike.
const MIN_SCANNER_EQUITY_SCORE = 65;

/** IST calendar day — one scanner trade per symbol per day. */
const ymd = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// NIFTY 50 stock symbols for scanning
const NIFTY50_SYMBOLS = [
  "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK",
  "HINDUNILVR", "ITC", "SBIN", "BHARTIARTL", "KOTAKBANK",
  "LT", "AXISBANK", "BAJFINANCE", "ASIANPAINT", "MARUTI",
  "SUNPHARMA", "TITAN", "ULTRACEMCO", "NESTLEIND", "TATAMOTORS",
  "WIPRO", "M&M", "HCLTECH", "POWERGRID", "NTPC",
  "ONGC", "TATASTEEL", "JSWSTEEL", "ADANIENT", "ADANIPORTS",
  "TECHM", "HDFCLIFE", "SBILIFE", "BRITANNIA", "CIPLA",
  "DRREDDY", "DIVISLAB", "EICHERMOT", "GRASIM", "HEROMOTOCO",
  "HINDALCO", "INDUSINDBK", "BAJAJFINSV", "COALINDIA", "BPCL",
  "TRENT", "APOLLOHOSP", "LTIM", "HDFCAMC", "PIDILITIND",
];

/**
 * Free market data for the scanner: NSE daily history (3 months) + the free
 * exchange quotes for anything the quote path missed. Bounded concurrency +
 * deadline so the scan never crawls (the scanner tab must stay instant).
 */
const dailyHistoryCache = new Map<string, { at: number; bars: any[] }>();
const DAILY_HISTORY_TTL = 10 * 60_000;

async function buildScannerMarketData(symbols: string[]): Promise<{
  marketData: ScannerMarketData;
  quoteSource: string;
  quoteSourceStamp: string | null;
}> {
  const dailyCandles = new Map<string, any[]>();
  const quoteFallback = new Map<string, any>();
  const sources = { daily: "nse", intraday: "none", quotes: "nse" };
  let quoteSourceStamp: string | null = null;
  try {
    const { getNSEHistoricalData } = await import("@/lib/nse-api");
    const to = new Date();
    const from = new Date(to.getTime() - 100 * 86_400_000);
    const CONCURRENCY = 12;
    const DEADLINE = Date.now() + 10_000;
    for (let i = 0; i < symbols.length && Date.now() < DEADLINE; i += CONCURRENCY) {
      const batch = symbols.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map(async (sym) => {
        try {
          const cached = dailyHistoryCache.get(sym);
          if (cached && Date.now() - cached.at < DAILY_HISTORY_TTL) {
            if (cached.bars.length >= 20) dailyCandles.set(sym, cached.bars);
            return;
          }
          const bars: any = await getNSEHistoricalData(sym, from, to);
          if (!Array.isArray(bars) || bars.length < 20) return;
          const mapped = bars.map((b: any) => {
            const t = Date.parse(String(b.mtimestamp || b.timestamp || ""));
            const o = Number(b.chOpeningPrice ?? b.open);
            const h = Number(b.chTradeHighPrice ?? b.high);
            const l = Number(b.chTradeLowPrice ?? b.low);
            const c = Number(b.chClosingPrice ?? b.close);
            const v = Number(b.chTotTradedQty ?? b.volume ?? 0);
            if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(c)) return null;
            return { time: t, open: o, high: Number.isFinite(h) ? h : c, low: Number.isFinite(l) ? l : c, close: c, volume: Number.isFinite(v) ? v : 0 };
          }).filter(Boolean);
          if (mapped.length >= 20) {
            dailyCandles.set(sym, mapped as any);
            dailyHistoryCache.set(sym, { at: Date.now(), bars: mapped as any });
          }
        } catch { /* a missing history = no daily context for that name */ }
      }));
    }
    } catch { /* NSE unavailable → no daily context (honest) */ }

  // ── MOapi daily candles (fallback when NSE historical returns 403) ──────
  // MO exposes EOD equity spot daily bars via /rest/report/v3/geteoddatabyexchangename.
  // Not available for index symbols (capability skip — throws fast, no network).
  let moDailyAdded = false;
  try {
    const moSymbols = symbols.filter((sym) => !dailyCandles.has(sym));
    if (moSymbols.length) {
      const MO_CONCURRENCY = 6;
      const MO_DEADLINE = Date.now() + 20_000;
      for (let i = 0; i < moSymbols.length && Date.now() < MO_DEADLINE; i += MO_CONCURRENCY) {
        const batch = moSymbols.slice(i, i + MO_CONCURRENCY);
        await Promise.allSettled(batch.map(async (sym) => {
          try {
            const candles = await getMOCandles(sym);
            if (!candles || candles.length < 20) return;
            const mapped = candles.map((c: any) => {
              const t = Date.parse(c.time);
              const o = Number(c.open);
              const h = Number(c.high);
              const l = Number(c.low);
              const cl = Number(c.close);
              const v = Number(c.volume || 0);
              if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(cl)) return null;
              return { time: t, open: o, high: Number.isFinite(h) ? h : cl, low: Number.isFinite(l) ? l : cl, close: cl, volume: Number.isFinite(v) ? v : 0 };
            }).filter(Boolean).sort((a: any, b: any) => a.time - b.time);
            if (mapped.length >= 20) {
              dailyCandles.set(sym, mapped as any);
              dailyHistoryCache.set(sym, { at: Date.now(), bars: mapped as any });
              moDailyAdded = true;
            }
          } catch { /* MO capability skip / auth error / no rows → honest gap */ }
        }));
      }
    }
  } catch { /* MOapi unavailable → no daily context */ }
  if (moDailyAdded) sources.daily = "motilal";

  try {
    const { fetchFreeNSEQuotes } = await import("@/lib/nse-stock-data");
    const free = await fetchFreeNSEQuotes(symbols);
    let quoteStamps: string[] = [];
    for (const [sym, q] of free) {
      if (q.providerTimestamp) quoteStamps.push(q.providerTimestamp);
      quoteFallback.set(sym, {
        last_price: String(q.ltp),
        change: String(q.change ?? 0),
        change_percent: String(q.changePct ?? 0),
        volume: String(q.volume ?? 0),
        // The exchange-published 20-session average volume (real RVOL base).
        avg_volume: String(q.avgVolume ?? 0),
        open: String(q.dayHigh ?? q.ltp),
        day_high: String(q.dayHigh ?? q.ltp),
        day_low: String(q.dayLow ?? q.ltp),
        previous_close: String(q.prevClose ?? q.ltp),
        provider_timestamp: q.providerTimestamp ?? null,
      });
    }
    // Report the REAL quote source from the rows themselves (a Moneycontrol
    // row carries its own publication stamp; an NSE index-list row does not).
    sources.quotes = free.size === 0
      ? "none"
      : quoteStamps.length > 0
        ? "moneycontrol"
        : "nse";
    quoteSourceStamp = quoteStamps.length
      ? quoteStamps.sort()[0]
      : null;
  } catch { /* no quote fallback */ }
  return {
    marketData: { dailyCandles, quoteFallback, sources },
    quoteSource: sources.quotes,
    quoteSourceStamp,
  };
}

export async function GET(request: NextRequest) {
  const TIMEOUT = 60_000;
  const deadline = Date.now() + TIMEOUT;

  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol") || "NIFTY";

    // Reject synthetic/test IDs before any provider is contacted (same guard
    // as /api/option-chain) — garbage symbols never reach the exchanges.
    if (!isPlausibleOptionSymbol(symbol)) {
      return NextResponse.json({ success: false, error: `Invalid symbol: ${symbol}` }, { status: 400 });
    }

    const warnings: string[] = [];

    // ── Option chain (canonical: NSE → BSE → MO) ──────────────────────
    const chainResult = await Promise.race([
      fetchLiveOptionChain(symbol),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
    ]).catch(() => null);

    const chainOk = !!chainResult?.success && !!chainResult?.data;
    let chainSource: string = chainResult?.source || "none";
    let chainAgeMs: number | null = chainResult?.ageMs ?? null;
    let chainData: any = chainOk ? chainResult!.data : null;

    if (!chainOk) {
      warnings.push(
        `Option chain unavailable (${chainResult?.error || "no provider answered"}) — scanning without PCR / max pain.`,
      );
      chainSource = "none";
      chainAgeMs = null;
    }

    // ── Spot (real) ───────────────────────────────────────────────────
    // Chain first (it carries the exchange's own underlying value), then the
    // free index quote. NO invented 24 000 fallback.
    let spotPrice: number | null = chainData?.spotPrice ?? null;
    let spotSource = chainOk ? chainSource : "none";
    if (!spotPrice || spotPrice <= 0) {
      const idx = await getNSEIndexQuote(symbol).catch(() => null);
      if (idx?.regularMarketPrice) {
        spotPrice = idx.regularMarketPrice;
        spotSource = "nse";
      }
    }
    if (!spotPrice || spotPrice <= 0) {
      return NextResponse.json(
        {
          success: false,
          status: "UNAVAILABLE",
          error: "Market data unavailable — no exchange quote for the index.",
          warnings,
          timestamp: new Date().toISOString(),
        },
        { status: 503 },
      );
    }

    // ── VIX (real) ────────────────────────────────────────────────────
    const vixQuote = await getNSEIndiaVIX().catch(() => null);
    const vix: number | null = vixQuote && vixQuote.value > 0 ? vixQuote.value : null;
    if (vix == null) warnings.push("INDIA VIX unavailable — volatility scoring skipped.");

    // ── Chain metrics (real, null when absent) ────────────────────────
    const optionChain = (chainData?.data || []) as any[];
    const summary = chainData?.summary || {};
    let totalCallOI = 0;
    let totalPutOI = 0;
    for (const strike of optionChain) {
      if (strike.ce) totalCallOI += strike.ce.oi || 0;
      if (strike.pe) totalPutOI += strike.pe.oi || 0;
    }
    const pcr: number | null =
      totalCallOI > 0 && totalPutOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : null;
    // Max pain only when the chain published one — never "spot" as a stand-in.
    const maxPain: number | null =
      summary.maxPain && Number.isFinite(summary.maxPain) ? summary.maxPain : null;
    if (pcr == null) warnings.push("No OI in the chain — PCR unavailable.");
    if (maxPain == null) warnings.push("Max pain unavailable from the chain.");

    // Fetch news sentiment (real RSS headlines)
    let marketNews: any = null;
    try {
      marketNews = await getCachedMarketNews();
    } catch (e) {
      warnings.push("News feed unavailable — news factor skipped.");
    }

    // Build scanner config. The scanner lib already treats a missing VIX /
    // PCR / max pain as "no data" (it skips that factor) — passing null is
    // what keeps the scan honest.
    const config = {
      symbol,
      spotPrice,
      optionChain,
      vix,
      pcr,
      maxPain,
      totalCallOI,
      totalPutOI,
    } as unknown as ScannerConfig;

    // Deadline check — if we've already spent too long, bail.
    if (Date.now() >= deadline) {
      return NextResponse.json({
        success: false,
        status: "UNAVAILABLE",
        error: "Market data API timed out — try again later.",
        timestamp: new Date().toISOString(),
      }, { status: 504 });
    }

    // Fetch real per-stock option chains (probe ∥ Breeze/NSE race, cached)
    // so the scanner's options score + monthly option trades use REAL
    // premium/IV/PCR. 16s = worst probe (12s, per-provider caps 6s/10s)
    // plus early batch work; fetchAllOptionChains has its own 12s batch
    // deadline; empty map when both providers are down.
    // Filter to F&O eligible symbols only to avoid wasting time on non-derivative names
    const fnoSymbols = NIFTY50_SYMBOLS.filter(isPlausibleOptionSymbol);
    const optionChains = await Promise.race([
      fetchAllOptionChains(fnoSymbols, new Map()),
      // A REAL timeout — the old `new Promise(executor, 16_000)` passed the
      // timeout as a second constructor argument, which Promise ignores
      // (the promise never settled on its own).
      new Promise<Map<string, any>>((resolve) => {
        setTimeout(() => {
          const empty = new Map<string, null>();
          fnoSymbols.forEach((s) => empty.set(s, null));
          resolve(empty);
        }, 16_000);
      }),
    ]);

    // ─── Market data for the scan (SERVER side) ───
    // The scanner module is imported by client components too, so it may not pull
    // in server-only modules (nse-api → session-health → telegram → voice → fs/path).
    // Free NSE daily history + free NSE quotes are fetched here and handed over.
    const marketDataBundle = await buildScannerMarketData(NIFTY50_SYMBOLS);
    const marketData = marketDataBundle.marketData;
    const quoteStamp = marketDataBundle.quoteSourceStamp;

    // Run the scan
    const result = await runIntradayScan(config, optionChains, marketData);

    // ─── Unified Intraday Intelligence — additive market-level decision ───
    // Reuses data the scan already fetched (daily candles, VIX, PCR, OI chain).
    // No redundant network calls. Does not replace existing scanner scoring.
    let unifiedIntelligence: any = null;
    try {
      const indexSymbol = config.symbol;
      const indexCandlesRaw = marketData.dailyCandles?.get(indexSymbol);
      const indexCandles: Candle[] = Array.isArray(indexCandlesRaw)
        ? indexCandlesRaw
            .map((b: any) => {
              const t = Date.parse(String(b.mtimestamp || b.timestamp || b.time || ""));
              const o = Number(b.chOpeningPrice ?? b.open);
              const h = Number(b.chTradeHighPrice ?? b.high);
              const l = Number(b.chTradeLowPrice ?? b.low);
              const c = Number(b.chClosingPrice ?? b.close);
              const v = Number(b.chTotTradedQty ?? b.volume ?? 0);
              if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(c)) return null;
              return { time: t, open: o, high: Number.isFinite(h) ? h : c, low: Number.isFinite(l) ? l : c, close: c, volume: Number.isFinite(v) ? v : 0 };
            })
            .filter((b): b is Candle => b != null)
            .sort((a: Candle, b: Candle) => a.time - b.time)
        : [];

      const lastCandle = indexCandles[indexCandles.length - 1];
      const todayCandles = lastCandle ? [lastCandle] : [];
      const historicalCandles = indexCandles.slice(0, -1);
      const lastCandleTs = lastCandle?.time ?? null;

      // Phase B: indicator bundle
      const indicatorBundle = computeIndicatorBundle(
        indexSymbol, todayCandles, historicalCandles, config.spotPrice, lastCandleTs,
      );

      // Phase C: SMC read + mechanism detection
      const smcRead = readSMC(indexSymbol, historicalCandles, indicatorBundle);
      const mechanismRead = detectMarketMechanism(indexSymbol, indicatorBundle, smcRead, {
        indiaVix: vix ?? null,
        sectorBreadth: result.sectors
          ? {
              advancing: result.sectors.reduce((s, sec: any) => s + (sec.advanceCount ?? 0), 0),
              declining: result.sectors.reduce((s, sec: any) => s + (sec.declineCount ?? 0), 0),
              unchanged: result.sectors.reduce((s, sec: any) => s + ((sec.stocks?.length ?? 0) - (sec.advanceCount ?? 0) - (sec.declineCount ?? 0)), 0),
            }
          : undefined,
        lastCandleTs,
      });

      // Phase D: derivatives context (reuse chainResult already fetched — no re-fetch)
      const chainStrikes = Array.isArray(chainResult?.data?.strikes)
        ? chainResult.data.strikes
        : [];
      const chainSummary = chainResult?.data?.summary ?? {};
      const totalCallOI = chainStrikes.reduce((s: number, st: any) => s + (st.ce?.oi || 0), 0);
      const totalPutOI = chainStrikes.reduce((s: number, st: any) => s + (st.pe?.oi || 0), 0);
      const derivatives: any = {
        symbol: indexSymbol,
        exchange: "NSE",
        timestamp: new Date().toISOString(),
        futuresOI: {
          value: {
            symbol: indexSymbol,
            expiry: chainResult?.data?.selectedExpiry ?? null,
            currentOI: totalCallOI > 0 && totalPutOI > 0 ? totalCallOI + totalPutOI : null,
            previousOI: null,
            oiChange: null,
            oiChangePct: null,
            priceChange: null,
            priceChangePct: null,
            volume: null,
            buildup: null,
            divergence: null,
          },
          freshness: "FRESH" as const,
          available: true,
          reason: null,
        },
        optionChain: {
          value: {
            symbol: indexSymbol,
            expiry: chainResult?.data?.selectedExpiry ?? null,
            spot: chainResult?.data?.spotPrice ?? null,
            atmStrike: chainResult?.data?.summary?.atmStrike ?? null,
            daysToExpiry: null,
            pcr: pcr ?? null,
            totalCallOI: totalCallOI > 0 ? totalCallOI : null,
            totalPutOI: totalPutOI > 0 ? totalPutOI : null,
            callOiChange: null,
            putOiChange: null,
            atmIV: null,
            maxPain: maxPain ?? null,
            supports: [],
            resistances: [],
            bias: (pcr ?? 0) > 1.2 ? "BULLISH_LEAN" : (pcr ?? 0) < 0.8 ? "BEARISH_LEAN" : "NEUTRAL",
            chainFreshness: "FRESH" as const,
            available: chainResult?.success ?? false,
          },
          freshness: "FRESH" as const,
          available: chainResult?.success ?? false,
          reason: null,
        },
        greeks: { delta: null, iv: null, theta: null, vega: null, valid: false, reason: "not computed in scanner path" },
        vix: {
          value: vix ? { value: vix, change: 0, regime: vix > 22 ? "extreme" : vix > 20 ? "high" : vix > 14 ? "moderate" : "low" } : null,
          freshness: "FRESH" as const,
          available: vix != null && vix > 0,
          reason: vix == null ? "VIX unavailable" : null,
        },
        fiiDii: {
          value: null,
          freshness: "UNAVAILABLE" as const,
          available: false,
          reason: "not fetched in scanner path",
        },
        optionPlan: {
          value: null,
          freshness: "UNAVAILABLE" as const,
          available: false,
          reason: "not computed in scanner path",
        },
      };

      // Phase D: market context (sync — VIX already fetched; FII/DII not in scanner path)
      const sectorBreadthResult: SectorBreadthResult = result.sectors
        ? {
            advances: result.sectors.reduce((s: number, sec: any) => s + (sec.advanceCount ?? 0), 0),
            declines: result.sectors.reduce((s: number, sec: any) => s + (sec.declineCount ?? 0), 0),
            unchanged: result.sectors.reduce(
              (s: number, sec: any) => s + ((sec.stocks?.length ?? 0) - (sec.advanceCount ?? 0) - (sec.declineCount ?? 0)),
              0,
            ),
            totalWithPriceData: result.sectors.reduce(
              (s: number, sec: any) => s + (sec.stocks?.length ?? 0),
              0,
            ),
            withoutPriceData: 0,
            sectorCounts: {} as Record<string, number>,
            otherUnmappedCount: 0,
            sectorAdvances: {} as Record<string, number>,
            sectorDeclines: {} as Record<string, number>,
            uniqueCompanies: result.sectors.length,
            duplicateCount: 0,
            dualListedCount: 0,
          }
        : {
            advances: 0,
            declines: 0,
            unchanged: 0,
            totalWithPriceData: 0,
            withoutPriceData: 0,
            sectorCounts: {},
            otherUnmappedCount: 0,
            sectorAdvances: {},
            sectorDeclines: {},
            uniqueCompanies: 0,
            duplicateCount: 0,
            dualListedCount: 0,
          };

      const marketContext = buildMarketContext(
        indexSymbol,
        indicatorBundle,
        smcRead,
        mechanismRead,
        {
          advancing: sectorBreadthResult.advances,
          declining: sectorBreadthResult.declines,
          unchanged: sectorBreadthResult.unchanged,
        },
      );

      // Phase E: coordinator decision
      unifiedIntelligence = coordinateDecision(
        indexSymbol,
        "NSE",
        indicatorBundle,
        smcRead,
        mechanismRead,
        derivatives,
        marketContext,
        sectorBreadthResult,
        100_000,
      );
    } catch (err: any) {
      console.warn("[Scanner] Unified intelligence computation skipped:", err.message);
    }

    // Apply real news scores to candidates
    if (marketNews && marketNews.articles?.length > 0) {
      result.candidates = result.candidates.map((candidate) => {
        // Find news for this stock
        const stockNews = marketNews.articles.filter((a: any) =>
          a.stockEntities?.includes(candidate.symbol)
        );

        if (stockNews.length > 0) {
          const avgSentiment = stockNews.reduce((sum: number, a: any) => sum + a.sentiment, 0) / stockNews.length;
          const newsScore = Math.round((avgSentiment + 1) * 50);

          // SAME weights as the engine's totalScore (intraday-scanner.ts). The
          // dominant term is the real signal engine (engineScore × 0.35) and
          // news is folded in at 5%. A different formula here made the score —
          // and therefore the ranking and the alerts — change between runs
          // depending on whether news happened to load.
          const newTotalScore = Math.round(
            (candidate.marketScore * 0.05) +
            (candidate.sectorScore * 0.10) +
            (candidate.technicalScore * 0.25) +
            (candidate.engineScore * 0.35) +
            (candidate.optionsScore * 0.05) +
            (candidate.volumeScore * 0.10) +
            (candidate.fundamentalScore * 0.05) +
            (newsScore * 0.05)
          );

          return {
            ...candidate,
            newsScore,
            totalScore: newTotalScore,
            // Add top headline to reasons
            reasons: [
              ...candidate.reasons,
              `News: ${stockNews[0].title.slice(0, 60)}... (${stockNews.length} articles)`,
            ],
          };
        }
        return candidate;
      });

      // Re-sort by updated scores
      result.candidates.sort((a, b) => b.totalScore - a.totalScore);
    }

    // Add market sentiment to result
    result.marketSentiment = marketNews ? {
      overall: marketNews.overall,
      label: marketNews.label,
      topBullish: (marketNews.topBullish || []).slice(0, 3),
      topBearish: (marketNews.topBearish || []).slice(0, 3),
    } : null;

    // Add unified scoring to each candidate
    if (result.candidates && result.candidates.length > 0) {
      result.candidates = result.candidates.map((candidate) => {
        try {
          const direction = (candidate.direction || "NEUTRAL") as "BULLISH" | "BEARISH" | "NEUTRAL";
          const input: MarketDataInput = {
            symbol: candidate.symbol,
            strategy: "EQUITY_SWING" as StrategyProfile,
            direction,
            spot: candidate.currentPrice || spotPrice,
            vix: vix ?? undefined,
            pcr: pcr ?? undefined,
            avgVolume: candidate.avgVolume || undefined,
            currentVolume: candidate.volume || undefined,
            relativeVolume: candidate.rvol || undefined,
            rsi: candidate.rsi || undefined,
            adx: candidate.adx || undefined,
            ema9: candidate.ema9 || undefined,
            ema21: candidate.ema21 || undefined,
          };
          const decision = scoreTrade(input);
          return {
            ...candidate,
            unifiedScore: decision.score,
            unifiedGrade: decision.grade,
            unifiedDecision: decision.decision,
            unifiedReasons: decision.reasons,
            hardGatesPassed: decision.hardGateStatus.passed,
            // Unified Intelligence signal — additive, derived from existing
            // candidate fields (no extra network calls). BUY_CE / BUY_PE only.
            unifiedSignal: (() => {
              const rr = candidate.riskReward ?? 0;
              const score = candidate.totalScore ?? 0;
              if (direction === "BULLISH" && rr >= 1.5 && score >= 60) return "BUY_CE";
              if (direction === "BEARISH" && rr >= 1.5 && score >= 60) return "BUY_PE";
              return "WAIT";
            })(),
          };
        } catch {
          return candidate;
        }
      });
    }

    // ─── Honest 6-state data quality ────────────────────────────────────
    // Derived from provider freshness + market session + source availability.
    // ERROR | CLOSED | STALE | DELAYED | PARTIAL | LIVE
    const quoteOk = (marketData.quoteFallback?.size ?? 0) > 0;
    const dailyOk = (marketData.dailyCandles?.size ?? 0) > 0;
    const chainStatus: SourceStatus = {
      ok: chainOk,
      ageMs: chainAgeMs,
      source: chainSource,
    };
    const quotesStatus: SourceStatus = {
      ok: quoteOk,
      ageMs: quoteStamp ? Date.now() - Date.parse(quoteStamp) : null,
      source: marketDataBundle.quoteSource || "none",
    };
    const dailyStatus = {
      ok: dailyOk,
      count: marketData.dailyCandles?.size ?? 0,
    };
    const clock = await getMarketClock();
    const errors: string[] = [];
    if (!chainOk && !quoteOk && !dailyOk) errors.push("All data sources unavailable");

    let dataQuality: DataQuality = classifyScannerDataQuality({
      chain: chainStatus,
      quotes: quotesStatus,
      daily: dailyStatus,
      clock: {
        isOpen: clock.isOpen,
        marketState: clock.marketState,
        tradeDate: clock.tradeDate,
        tradeAgeMs: clock.tradeAgeMs,
      },
      errors,
    });

    if (dataQuality === "CLOSED") {
      warnings.push(
        `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}. Quotes are the last close, not a live print.`,
      );
    }
    (result as any).dataQuality = dataQuality;

    const cardMeta = buildCardMeta({
        source: chainOk ? chainSource : quoteOk ? (marketDataBundle.quoteSource === "moneycontrol" ? "moneycontrol" : "nse") : "none",
      providerTimestamp: chainOk ? (chainAgeMs != null ? new Date(Date.now() - chainAgeMs) : null) : quoteStamp,
      ttlMs: 120_000,
      live: clock.isOpen && dataQuality === "LIVE",
      reason: clock.isOpen ? undefined : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
    });

    const dataSource =
      chainOk
        ? chainSource
        : quoteOk
        ? (marketDataBundle.quoteSource === "moneycontrol" ? "Moneycontrol" : "NSE")
        : "none";

    // If we got zero candidates, say so honestly (the feed worked, the
    // screen found nothing) instead of calling it "SIMULATED".
    if (!result.candidates || result.candidates.length === 0) {
      result.candidates = [];
      if (dataQuality !== "UNAVAILABLE") {
        warnings.push("No candidate passed the screen on the real data.");
      }
    }

    // Migration: persist intraday scanner results to the Scanner Results
    // store so the Evaluation framework + Replay can grade this strategy.
    try {
      await recordIntradayScannerResults(result.candidates, config);
    } catch (recErr) {
      console.warn("[Scanner] Scanner Results recording skipped:", recErr);
    }

    // Record top candidates into the Trade Audit sidecar (:4001) as trackable
    // EQUITY signals so the scanner's live win rate / avg R is measurable.
    try {
      await recordIntradayScannerSignals(result.candidates, 8);
    } catch (recErr) {
      console.warn("[Scanner] Trade Audit signal recording skipped:", recErr);
    }

    // ── Scanner option-trade Telegram alerts (live=true) ────────────────
    // The Scanner tab fetches /api/scanner directly (client side) and never
    // alerted. When called with ?live=true (the cron path), high-confidence
    // option trades are pushed through sendTradeAlert — the same centralized
    // funnel (veto + risk limits + full-day dedup + short-term throttle +
    // calibrated confidence) used by SDM, agent and Zero-Hero alerts.
    let equityAlerts = 0;
    if (searchParams.get("live") === "true" && result.candidates) {
      const dataQualityOk = dataQuality === "LIVE";
      const nowMs = Date.now();

      // ── Scanner STOCK (cash equity) alerts ────────────────────────────
      // The scanner finds stock setups, but only the OPTION expression was
      // ever alerted — the cash-equity pick (entry/SL/TP on the stock) never
      // reached Telegram and was never registered, so no TP/SL hit could be
      // reported. Same funnel; the trade is registered with the tracker so
      // the TIGER monitor sends the TP_HIT / SL_HIT card.
      if (dataQualityOk) {
        for (const stock of result.candidates) {
          if (equityAlerts >= MAX_SCANNER_EQUITY_ALERTS) break;
          if (stock.direction !== "BULLISH") continue;
          if ((stock.totalScore ?? 0) < MIN_SCANNER_EQUITY_SCORE) continue;
          // Same unified-decision gate as the option path below.
          const equityUnifiedOk = (stock as any).unifiedDecision === "TRADE" || (stock as any).hardGatesPassed === true;
          if (!equityUnifiedOk) continue;
          const sent = await alertScannerStock({
            symbol: stock.symbol,
            name: stock.name,
            side: "BUY",
            entry: stock.entry,
            stopLoss: stock.stopLoss,
            target1: stock.target1,
            target2: stock.target2,
            spot: stock.currentPrice,
            confidence: stock.totalScore ?? 0,
            source: "intraday-scanner",
            tradeId: scannerTradeId("intraday-scanner", stock.symbol, stock.monthlyOptionTrade?.strike ?? 0, stock.monthlyOptionTrade?.optionType ?? 'CE', ymd),
            reason: stock.technicalSummary,
          }).catch(() => false);
          if (sent) equityAlerts++;
        }
      }

      for (const stock of result.candidates) {
        const opt = stock.monthlyOptionTrade;
        if (!opt || !(opt.premium > 0)) continue;
        if ((stock.totalScore ?? 0) < 65) continue;
        if (!dataQualityOk) continue;
        const unifiedOk = (stock as any).unifiedDecision === "TRADE" || (stock as any).hardGatesPassed === true;
        if (!unifiedOk) continue;
        const risk = opt.premium - Number(opt.stopLoss || 0);
        const reward = (opt.targets?.[0] ?? 0) - opt.premium;
        const rr = risk > 0 && reward > 0 ? reward / risk : 0;
        if (rr < 1.5) continue;
        if (!isChainFresh((opt as any)?.chainAsOf)) continue;
        if (!isPlausibleOptionPlan(stock, opt)) continue;

        await sendTradeAlert({
          symbol: stock.symbol,
          action: "BUY",
          strike: opt.strike,
          type: opt.optionType,
          confidence: stock.totalScore ?? 0,
          entry: opt.premium,
          stopLoss: opt.stopLoss,
          target1: opt.targets?.[0] ?? 0,
          target2: opt.targets?.[1] ?? 0,
          source: "stock-scanner",
          spot: stock.currentPrice,
          expiry: opt.expiry,
          requireExpiry: true,
          requireSpot: true,
          nowMs,
        }).catch(() => {});
      }
    }

    return NextResponse.json({
      success: true,
      status: dataQuality,
      // `data` is the scan result (the UI reads data.candidates …).
      data: result,
      // `meta` carries the provenance of every input behind the scan.
      meta: cardMeta,
      dataQuality,
      // Unified Intraday Intelligence Engine — coordinator decision for the
      // index symbol (market-level BUY CE / BUY PE / WAIT). Additive to the
      // existing scanner scoring; does not replace it.
      unifiedIntelligence,
      // Cash-equity alerts actually delivered by this scan (the equity
      // expression of a scanner setup — registered with the tracker so the
      // TIGER monitor can report its TP/SL hits).
      equityAlerts,
      liveQuotesCount: (result.candidates || []).length,
      dataSource,
      dataSources: {
        ...result.dataSources,
        chain: chainOk ? chainSource : "none",
        chainAgeMs,
        quotes: marketData.sources?.quotes || "none",
        daily: marketData.sources?.daily || "none",
        vix: vix == null ? "none" : "nse",
        spot: spotSource,
      },
      inputs: {
        spotPrice,
        vix,
        pcr,
        maxPain,
        totalCallOI,
        totalPutOI,
        optionStrikes: optionChain.length,
        dailySymbols: marketData.dailyCandles?.size ?? 0,
        quoteSymbols: marketData.quoteFallback?.size ?? 0,
      },
      warnings,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    const isTimeout = error?.message?.includes("timed out") || Date.now() >= deadline;
    console.error("[Scanner API] Error:", isTimeout ? "TIMEOUT" : error);
    return NextResponse.json(
      { success: false, status: "UNAVAILABLE", error: isTimeout ? "Market data API timed out — try again later." : (error.message || "Scanner failed") },
      { status: isTimeout ? 504 : 500 }
    );
  }
}
