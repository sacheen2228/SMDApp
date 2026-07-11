// Intraday Scanner API
// Returns high-probability intraday stock setups for NSE India
// Uses Yahoo Finance API for real stock data + News sentiment

import { NextRequest, NextResponse } from "next/server";
import { runIntradayScan, type ScannerConfig } from "@/lib/intraday-scanner";
import { getCachedMarketNews } from "@/lib/news-engine";

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

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol") || "NIFTY";
    const useLive = searchParams.get("live") === "true";

    // Fetch real option chain data: Breeze → NSE → Simulation fallback
    let chainData: any = null;
    try {
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
            summary: { indiaVIX: 15 }, // VIX from separate endpoint
          };
          break;
        }
      }
    } catch (e) {
      console.warn("[Scanner] Breeze option chain failed:", e);
    }

    // Fallback to NSE
    if (!chainData) {
      try {
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
      } catch (e) {
        console.warn("[Scanner] NSE failed:", e);
      }
    }

    // If no real data available, return error
    if (!chainData) {
      return NextResponse.json({
        success: false,
        error: "No real option chain data available for market context.",
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

    const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;
    const maxPain = summary.maxPain || spotPrice;
    const vix = summary.indiaVIX || 15;

    // Fetch real stock data from Yahoo Finance if requested
    let liveQuotes = new Map<string, any>();
    let dataQuality: "LIVE" | "SIMULATED" | "PARTIAL" = "SIMULATED";
    let dataSource: string | null = null;
    let liveError: string | null = null;

    if (useLive) {
      try {
        // Fetch top 15 stocks only (rate limited: 2s per stock)
        liveQuotes = await Promise.race([
          fetchYahooQuotes(NIFTY50_SYMBOLS.slice(0, 15)),
          new Promise<Map<string, any>>((_, reject) => setTimeout(() => reject(new Error("timeout")), 35000)),
        ]);
        if (liveQuotes.size > 0) {
          dataQuality = liveQuotes.size >= 10 ? "LIVE" : "PARTIAL";
          dataSource = "Yahoo Finance";
        } else {
          liveError = "Yahoo Finance temporarily unavailable — showing simulated data";
        }
      } catch (error: any) {
        liveError = "Yahoo Finance temporarily unavailable — showing simulated data";
        console.warn("[Scanner] Live fetch failed:", error.message);
      }
    }

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

    // Run the scan
    const result = runIntradayScan(config);

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

    // Override candidates with real data if available
    if (liveQuotes.size > 0) {
      result.candidates = result.candidates.map((candidate) => {
        const quote = liveQuotes.get(candidate.symbol);
        if (quote) {
          const ltp = parseFloat(quote.last_price || "0");
          const change = parseFloat(quote.change || "0");
          const changePct = parseFloat(quote.change_percent || "0");
          const volume = parseInt(quote.volume || "0");

          // Update with real data
          return {
            ...candidate,
            currentPrice: ltp || candidate.currentPrice,
            change: change || candidate.change,
            changePct: changePct || candidate.changePct,
            volume: volume || candidate.volume,
            // Recalculate entry/SL/targets based on real price
            entry: ltp ? Math.round(ltp * 1.005 * 100) / 100 : candidate.entry,
            stopLoss: ltp ? Math.round(ltp * 0.985 * 100) / 100 : candidate.stopLoss,
            target1: ltp ? Math.round(ltp * 1.02 * 100) / 100 : candidate.target1,
            target2: ltp ? Math.round(ltp * 1.035 * 100) / 100 : candidate.target2,
          };
        }
        return candidate;
      });

      // Sort by score again after updating with real data
      result.candidates.sort((a, b) => b.totalScore - a.totalScore);
    }

    result.dataQuality = dataQuality;

    return NextResponse.json({
      success: true,
      data: result,
      liveQuotesCount: liveQuotes.size,
      dataSource,
      liveError,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[Scanner API] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Scanner failed" },
      { status: 500 }
    );
  }
}
