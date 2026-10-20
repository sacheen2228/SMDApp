// Intraday Scanner API
// Returns high-probability intraday stock setups for NSE India
// Uses Yahoo Finance API for real stock data + News sentiment

import { NextRequest, NextResponse } from "next/server";
import { runIntradayScan, recordIntradayScannerResults, recordIntradayScannerSignals, type ScannerConfig, type ScannerMarketData } from "@/lib/intraday-scanner";
import { fetchAllOptionChains } from "@/lib/breeze-fno-data";
import { getCachedMarketNews } from "@/lib/news-engine";
import { scoreTrade, type MarketDataInput, type StrategyProfile } from "@/lib/unified-scoring-engine";
import { isPlausibleOptionSymbol } from "@/lib/stockUniverse";

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

// Map NSE symbols to Yahoo Finance format (RELIANCE -> RELIANCE.NS)
function toYahooSymbol(nseSymbol: string): string {
  return `${nseSymbol}.NS`;
}

// Yahoo Finance chart endpoint rate limiter (2 second interval)
let lastYahooRequest = 0;
const YAHOO_RATE_LIMIT = 2000;

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const wait = Math.max(0, YAHOO_RATE_LIMIT - (now - lastYahooRequest));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastYahooRequest = Date.now();
  return fetch(url, { signal: AbortSignal.timeout(10000) });
}

// Fetch stock quotes from Yahoo Finance v8 chart API (free, no auth)
async function fetchYahooQuotes(symbols: string[]): Promise<Map<string, any>> {
  const quotes = new Map<string, any>();

  try {
    for (const sym of symbols) {
      const yahooSymbol = toYahooSymbol(sym);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1d`;

      const res = await rateLimitedFetch(url);
      if (!res.ok) continue;

      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) continue;

      const prevClose = meta.chartPreviousClose || meta.regularMarketPrice;
      const ltp = meta.regularMarketPrice;
      const change = ltp - prevClose;
      const changePct = prevClose ? (change / prevClose) * 100 : 0;

      quotes.set(sym, {
        last_price: ltp.toString(),
        change: change.toFixed(2),
        change_percent: changePct.toFixed(2),
        volume: (meta.regularMarketVolume || 0).toString(),
        open: (meta.regularMarketOpen || ltp).toString(),
        day_high: (meta.regularMarketDayHigh || ltp).toString(),
        day_low: (meta.regularMarketDayLow || ltp).toString(),
        fifty_two_week_high: (meta.fiftyTwoWeekHigh || ltp).toString(),
        fifty_two_week_low: (meta.fiftyTwoWeekLow || ltp).toString(),
        previous_close: prevClose.toString(),
      });
    }
  } catch (error) {
    console.warn("[Scanner] Yahoo Finance fetch failed:", error);
  }

  return quotes;
}

// Get sector for a stock
function getSector(symbol: string): string {
  const sectorMap: Record<string, string> = {
    RELIANCE: "Energy", TCS: "IT", HDFCBANK: "Banking", INFY: "IT",
    ICICIBANK: "Banking", HINDUNILVR: "FMCG", ITC: "FMCG", SBIN: "Banking",
    BHARTIARTL: "Telecom", KOTAKBANK: "Banking", LT: "Infrastructure",
    AXISBANK: "Banking", BAJFINANCE: "NBFC", ASIANPAINT: "Consumer",
    MARUTI: "Auto", SUNPHARMA: "Pharma", TITAN: "Consumer", ULTRACEMCO: "Cement",
    NESTLEIND: "FMCG", TATAMOTORS: "Auto", WIPRO: "IT", "M&M": "Auto",
    HCLTECH: "IT", POWERGRID: "Power", NTPC: "Power", ONGC: "Energy",
    TATASTEEL: "Metal", JSWSTEEL: "Metal", ADANIENT: "Conglomerate",
    ADANIPORTS: "Infrastructure", TECHM: "IT", HDFCLIFE: "Insurance",
    SBILIFE: "Insurance", BRITANNIA: "FMCG", CIPLA: "Pharma",
    DRREDDY: "Pharma", DIVISLAB: "Pharma", EICHERMOT: "Auto",
    GRASIM: "Cement", HEROMOTOCO: "Auto", HINDALCO: "Metal",
    INDUSINDBK: "Banking", BAJAJFINSV: "NBFC", COALINDIA: "Mining",
    BPCL: "Energy", TRENT: "Retail", APOLLOHOSP: "Healthcare",
    LTIM: "IT", HDFCAMC: "Finance", PIDILITIND: "Chemical",
  };
  return sectorMap[symbol] || "Other";
}

/**
 * Free market data for the scanner: NSE daily history (3 months) + NSE quotes for
 * anything the quote path missed. Bounded concurrency + deadline so the scan never
 * crawls (the scanner tab must stay instant).
 */
const dailyHistoryCache = new Map<string, { at: number; bars: any[] }>();
const DAILY_HISTORY_TTL = 10 * 60_000;

async function buildScannerMarketData(symbols: string[]): Promise<ScannerMarketData> {
  const dailyCandles = new Map<string, any[]>();
  const quoteFallback = new Map<string, any>();
  const sources = { daily: "nse", intraday: "none", quotes: "nse" };
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
  try {
    const { fetchFreeNSEQuotes } = await import("@/lib/nse-stock-data");
    const free = await fetchFreeNSEQuotes(symbols);
    for (const [sym, q] of free) {
      quoteFallback.set(sym, {
        last_price: String(q.ltp),
        change: String(q.change ?? 0),
        change_percent: String(q.changePct ?? 0),
        volume: String(q.volume ?? 0),
        open: String(q.dayHigh ?? q.ltp),
        day_high: String(q.dayHigh ?? q.ltp),
        day_low: String(q.dayLow ?? q.ltp),
        previous_close: String(q.prevClose ?? q.ltp),
      });
    }
  } catch { /* no quote fallback */ }
  return { dailyCandles, quoteFallback, sources };
}

export async function GET(request: NextRequest) {
  const TIMEOUT = 30_000;
  const deadline = Date.now() + TIMEOUT;

  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol") || "NIFTY";
    const useLive = searchParams.get("live") === "true";

    // Reject synthetic/test IDs before any provider is contacted (same guard
    // as /api/option-chain) — garbage symbols never reach Breeze or NSE.
    if (!isPlausibleOptionSymbol(symbol)) {
      return NextResponse.json({ success: false, error: `Invalid symbol: ${symbol}` }, { status: 400 });
    }

    // Fetch real option chain data: Breeze → NSE (15s max for both)
    let chainData: any = null;
    try {
      await Promise.race([
        (async () => {
          const { getOptionChain, getOptionChainExpiries } = await import("@/lib/icici-breeze/option-chain");
          const { initSession } = await import("@/lib/icici-breeze/auth");
          await initSession().catch(() => {});
          const expiries = await getOptionChainExpiries(symbol);
          for (const exp of expiries.slice(0, 3)) {
            const chain = await getOptionChain(symbol, exp);
            if (chain) {
              chainData = {
                spotPrice: chain.spotPrice,
                data: chain.strikes.map((strike) => ({
                  strike,
                  ce: chain.calls.find((c) => c.strikePrice === strike) || null,
                  pe: chain.puts.find((p) => p.strikePrice === strike) || null,
                })),
                summary: { indiaVIX: 15 },
              };
              break;
            }
          }
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 15_000)),
      ]);
    } catch (e) {
      console.warn("[Scanner] Breeze option chain failed:", e);
    }

    // Fallback to NSE (within remaining budget)
    if (!chainData) {
      try {
        await Promise.race([
          (async () => {
            const { getNSEOptionChain } = await import("@/lib/nse-api");
            const nseData = await getNSEOptionChain(symbol);
            if (nseData?.records?.data) {
              chainData = {
                spotPrice: nseData.records?.underlyingValue || 0,
                data: nseData.records.data.map((row: any) => ({
                  strike: row.strikePrice,
                  ce: row.CE ? { oi: row.CE.openInterest || 0, ltp: row.CE.lastPrice || 0 } : null,
                  pe: row.PE ? { oi: row.PE.openInterest || 0, ltp: row.PE.lastPrice || 0 } : null,
                })),
                summary: { indiaVIX: 15 },
              };
            }
          })(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 10_000)),
        ]);
      } catch (e) {
        console.warn("[Scanner] NSE failed:", e);
      }
    }

    // Option chain is optional — scanner can work with Yahoo Finance stock
    // data alone. When Breeze/NSE are unavailable (weekend/holiday), use
    // defaults so the scanner still produces results.
    let dataSource: string | null = null;
    let liveError: string | null = null;

    if (!chainData) {
      // Use Yahoo Finance for spot price as context
      try {
        const { getNSEIndiaVIX, getNSEIndexQuote } = await import('@/lib/nse-api');
        const [yahooData, vixData] = await Promise.all([
          getNSEIndexQuote(symbol).catch(() => null),
          getNSEIndiaVIX().catch(() => null),
        ]);
        const spot = yahooData?.regularMarketPrice || 0;
        if (spot > 0) {
          chainData = {
            spotPrice: spot,
            data: [],
            summary: { indiaVIX: vixData?.value ?? null },
          };
          liveError = "Option chain unavailable — scanning with Yahoo Finance stock data only.";
        }
      } catch {}
    }

    if (!chainData) {
      return NextResponse.json({
        success: false,
        error: "Market data unavailable — neither option chain nor Yahoo Finance could provide data.",
      }, { status: 503 });
    }

    // Extract market metrics
    const spotPrice = chainData.spotPrice || 24000;
    const optionChain = chainData.data || [];
    const summary = chainData.summary || {};

    // Calculate PCR and other metrics from option chain
    let totalCallOI = 0;
    let totalPutOI = 0;

    for (const strike of optionChain) {
      if (strike.ce) totalCallOI += strike.ce.oi || 0;
      if (strike.pe) totalPutOI += strike.pe.oi || 0;
    }

    const pcr = totalCallOI > 0 && totalPutOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : null;
    const maxPain = summary.maxPain || spotPrice;
    const vix = summary.indiaVIX || 15;

    // Live stock data is fetched inside runIntradayScan (generateCandidates)
    // via Yahoo Finance for the full NIFTY50 universe.

    // Fetch news sentiment
    let marketNews = null;
    try {
      marketNews = await getCachedMarketNews();
    } catch (e) {
      console.warn("[Scanner] News fetch failed:", e);
    }

    // Build scanner config
    const config: ScannerConfig = {
      symbol,
      spotPrice,
      optionChain,
      vix,
      pcr,
      maxPain,
      totalCallOI,
      totalPutOI,
    };

    // Deadline check — if we've already spent too long, bail.
    if (Date.now() >= deadline) {
      return NextResponse.json({
        success: false,
        error: "Market data API timed out — try again later.",
      }, { status: 504 });
    }

    // Fetch real per-stock option chains (probe ∥ Breeze/NSE race, cached)
    // so the scanner's options score + monthly option trades use REAL
    // premium/IV/PCR. 16s = worst probe (12s, per-provider caps 6s/10s)
    // plus early batch work; fetchAllOptionChains has its own 12s batch
    // deadline; empty map when both providers are down.
    const optionChains = await Promise.race([
      fetchAllOptionChains(NIFTY50_SYMBOLS, new Map()),
      new Promise<Map<string, any>>((resolve) => setTimeout(() => {
        const empty = new Map<string, null>();
        NIFTY50_SYMBOLS.forEach(s => empty.set(s, null));
        resolve(empty);
      }, 16_000)),
    ]);

    // ─── Market data for the scan (SERVER side) ───
    // The scanner module is imported by client components too, so it may not pull
    // in server-only modules (nse-api → session-health → telegram → voice → fs/path).
    // Free NSE daily history + free NSE quotes are fetched here and handed over.
    const marketData = await buildScannerMarketData(NIFTY50_SYMBOLS);

    // Run the scan
    const result = await runIntradayScan(config, optionChains, marketData);

    // Apply real news scores to candidates
    if (marketNews && marketNews.articles.length > 0) {
      result.candidates = result.candidates.map((candidate) => {
        // Find news for this stock
        const stockNews = marketNews.articles.filter(a =>
          a.stockEntities.includes(candidate.symbol)
        );

        if (stockNews.length > 0) {
          const avgSentiment = stockNews.reduce((sum, a) => sum + a.sentiment, 0) / stockNews.length;
          const newsScore = Math.round((avgSentiment + 1) * 50);

          // Recalculate total score with real news weight (10%)
          const newTotalScore = Math.round(
            (candidate.marketScore * 0.15) +
            (candidate.sectorScore * 0.10) +
            (candidate.technicalScore * 0.35) +
            (candidate.optionsScore * 0.15) +
            (candidate.volumeScore * 0.10) +
            (candidate.fundamentalScore * 0.05) +
            (newsScore * 0.10)
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
      topBullish: marketNews.topBullish.slice(0, 3),
      topBearish: marketNews.topBearish.slice(0, 3),
    } : null;

    // If we got zero candidates, return success with empty results rather
    // than a 503 — the UI handles empty state gracefully.
    if (!result.candidates || result.candidates.length === 0) {
      result.candidates = [];
      result.dataQuality = "UNAVAILABLE";
    }

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
            vix,
            pcr,
            avgVolume: candidate.avgVolume || undefined,
            currentVolume: candidate.currentVolume || undefined,
            relativeVolume: candidate.relativeVolume || undefined,
            rsi: candidate.rsi || undefined,
            adx: candidate.adx || undefined,
            vwap: candidate.vwap || undefined,
            ema9: candidate.ema9 || undefined,
            ema21: candidate.ema21 || undefined,
            historicalWinRate: candidate.historicalWinRate || undefined,
            historicalRR: candidate.historicalRR || undefined,
          };
          const decision = scoreTrade(input);
          return {
            ...candidate,
            unifiedScore: decision.score,
            unifiedGrade: decision.grade,
            unifiedDecision: decision.decision,
            hardGatesPassed: decision.hardGateStatus.passed,
          };
        } catch {
          return candidate;
        }
      });
    }

    dataSource = result.dataQuality === "LIVE" || result.dataQuality === "PARTIAL" ? "Yahoo Finance" : null;
    liveError = result.dataQuality === "LIVE" ? null : "Partial real-time quotes — some symbols unavailable from Yahoo Finance.";

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

    return NextResponse.json({
      success: true,
      data: result,
      liveQuotesCount: (result.candidates || []).length,
      dataSource,
      dataSources: result.dataSources,
      liveError,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    const isTimeout = error?.message?.includes("timed out") || Date.now() >= deadline;
    console.error("[Scanner API] Error:", isTimeout ? "TIMEOUT" : error);
    return NextResponse.json(
      { success: false, error: isTimeout ? "Market data API timed out — try again later." : (error.message || "Scanner failed") },
      { status: isTimeout ? 504 : 500 }
    );
  }
}
