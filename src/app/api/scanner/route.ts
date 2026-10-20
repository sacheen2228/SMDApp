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
import { fetchAllOptionChains } from "@/lib/breeze-fno-data";
import { getCachedMarketNews } from "@/lib/news-engine";
import { scoreTrade, type MarketDataInput, type StrategyProfile } from "@/lib/unified-scoring-engine";
import { isPlausibleOptionSymbol } from "@/lib/stockUniverse";
import { fetchLiveOptionChain } from "@/lib/live-option-chain";
import { getNSEIndiaVIX, getNSEIndexQuote } from "@/lib/nse-api";
import { getStockQuoteProvenance } from "@/lib/nse-stock-data";
import { buildCardMeta, getMarketClock, round } from "@/lib/data-freshness";

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
  const TIMEOUT = 30_000;
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
    const optionChains = await Promise.race([
      fetchAllOptionChains(NIFTY50_SYMBOLS, new Map()),
      // A REAL timeout — the old `new Promise(executor, 16_000)` passed the
      // timeout as a second constructor argument, which Promise ignores
      // (the promise never settled on its own).
      new Promise<Map<string, any>>((resolve) => {
        setTimeout(() => {
          const empty = new Map<string, null>();
          NIFTY50_SYMBOLS.forEach((s) => empty.set(s, null));
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

    // Run the scan
    const result = await runIntradayScan(config, optionChains, marketData);

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
            hardGatesPassed: decision.hardGateStatus.passed,
          };
        } catch {
          return candidate;
        }
      });
    }

    // ─── Honest data quality ──────────────────────────────────────────
    // Derived from the ACTUAL source + age of each input — not from a quote
    // count. "SIMULATED" is never emitted: nothing in this path simulates.
    const clock = await getMarketClock();
    const prov = getStockQuoteProvenance();
    const quoteStamp = marketDataBundle.quoteSourceStamp ?? prov.providerTimestamp ?? clock.tradeDate ?? null;
    const dailyOk = (marketData.dailyCandles?.size ?? 0) > 0;
    const quoteOk = (marketData.quoteFallback?.size ?? 0) > 0;

    const chainFresh = chainOk && chainAgeMs != null && chainAgeMs <= 120_000;
    const quotesFresh =
      quoteOk && quoteStamp != null && Date.now() - Date.parse(quoteStamp) <= 120_000;

    let dataQuality: "LIVE" | "PARTIAL" | "UNAVAILABLE" = "UNAVAILABLE";
    if (chainOk || quoteOk || dailyOk) {
      const allFresh = chainFresh && quotesFresh && dailyOk && clock.isOpen;
      dataQuality = allFresh ? "LIVE" : "PARTIAL";
    }
    if (dataQuality === "PARTIAL" && !clock.isOpen) {
      warnings.push(
        `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}. Quotes are the last close, not a live print.`,
      );
    }
    (result as any).dataQuality = dataQuality;

    const cardMeta = buildCardMeta({
      source: chainOk ? chainSource : quoteOk ? (prov.source === "moneycontrol" ? "moneycontrol" : "nse") : "none",
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

    return NextResponse.json({
      success: true,
      status: dataQuality,
      // `data` is the scan result (the UI reads data.candidates …).
      data: result,
      // `meta` carries the provenance of every input behind the scan.
      meta: cardMeta,
      dataQuality,
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
