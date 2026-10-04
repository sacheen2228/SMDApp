// Market Regime API — Multi-factor regime detection
// Factors: Index trend, Breadth, Sector breadth, Volume, VWAP, EMA structure, Momentum, Volatility, F&O

import { NextResponse } from "next/server";
import { fetchWithFallback, FallbackSource } from "@/lib/fetch-with-fallback";
import { fetchNIFTY50Stocks } from "@/lib/nse-stock-data";
import { buildFreshnessMeta } from "@/lib/api-freshness";
import { getNSEIndiaVIX, getNSEIndices } from "@/lib/nse-api";

const INDICES = [
  { key: "NIFTY", yahoo: "^NSEI", mcId: "NIFTY 50", name: "NIFTY 50" },
  { key: "BANKNIFTY", yahoo: "^NSEBANK", mcId: "NIFTY Bank", name: "BANK NIFTY" },
  { key: "SENSEX", yahoo: "^BSESN", mcId: "SENSEX", name: "SENSEX" },
  { key: "FINNIFTY", yahoo: "^NSEMIDCAP", mcId: "", name: "FIN NIFTY" },
];

async function fetchIndexMC(mcId: string): Promise<{ ltp: number; prev: number } | null> {
  const res = await fetch(`https://priceapi.moneycontrol.com/pricefeed/nse/index/${mcId}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (json.code !== "200" || !json.data) return null;
  const ltp = parseFloat(json.data.pricecurrent) || 0;
  const prev = parseFloat(json.data.priceprevclose) || ltp;
  if (!ltp) return null;
  return { ltp, prev };
}

async function fetchIndexYahoo(yahooSymbol: string): Promise<{ ltp: number; prev: number } | null> {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1d`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) return null;
  return { ltp: meta.regularMarketPrice, prev: meta.chartPreviousClose || meta.regularMarketPrice };
}

// Estimate index from constituent stocks (fallback when index APIs fail)
function estimateIndexFromStocks(indexName: string, stocks: any[]): { ltp: number; prev: number; changePct: number } | null {
  const indexConstituents: Record<string, string[]> = {
    NIFTY: [
      "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","ITC","SBIN",
      "BHARTIARTL","KOTAKBANK","LT","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI",
      "SUNPHARMA","TITAN","ULTRACEMCO","NESTLEIND","TATAMOTORS","WIPRO","M&M",
      "HCLTECH","POWERGRID","NTPC","ONGC","TATASTEEL","JSWSTEEL","ADANIENT",
      "ADANIPORTS","TECHM","HDFCLIFE","SBILIFE","BRITANNIA","CIPLA","DRREDDY",
      "DIVISLAB","EICHERMOT","GRASIM","HEROMOTOCO","HINDALCO","INDUSINDBK",
      "BAJAJFINSV","COALINDIA","BPCL","TRENT","APOLLOHOSP","LTIM","HDFCAMC","PIDILITIND",
    ],
    BANKNIFTY: [
      "HDFCBANK","ICICIBANK","SBIN","KOTAKBANK","AXISBANK","INDUSINDBK","BANKBARODA",
      "PNB","CANBK","IDFCFIRSTB","FEDERALBNK","AUBANK",
    ],
    SENSEX: [
      "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","ITC","SBIN",
      "BHARTIARTL","KOTAKBANK","LT","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI",
      "SUNPHARMA","TITAN","ULTRACEMCO","NESTLEIND","TATAMOTORS","WIPRO","M&M",
      "HCLTECH","POWERGRID","NTPC","ONGC","TATASTEEL","JSWSTEEL","ADANIENT",
      "ADANIPORTS","TECHM",
    ],
  };

  const constituents = indexConstituents[indexName];
  if (!constituents) return null;

  const indexStocks = stocks.filter(s => constituents.includes(s.symbol));
  if (indexStocks.length === 0) return null;

  const avgChangePct = indexStocks.reduce((sum, s) => sum + s.changePct, 0) / indexStocks.length;
  const avgLtp = indexStocks.reduce((sum, s) => sum + s.ltp, 0) / indexStocks.length;
  const avgPrev = indexStocks.reduce((sum, s) => sum + s.prevClose, 0) / indexStocks.length;

  return { ltp: avgLtp, prev: avgPrev, changePct: avgChangePct };
}

let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 60_000;

interface RegimeFactors {
  indexTrend: number;       // -100 to +100
  breadth: number;          // -100 to +100
  sectorBreadth: number;    // -100 to +100
  volume: number;           // -100 to +100
  vwapParticipation: number; // -100 to +100
  emaStructure: number;     // -100 to +100
  momentum: number;         // -100 to +100
  volatility: number;       // 0 to 100 (VIX-based)
  foPositioning: number;    // -100 to +100
}

function calculateRegime(factors: RegimeFactors, vix: number): { regime: string; bias: string; tradeEnv: string; score: number } {
  // Weighted composite score
  const weights = {
    indexTrend: 0.20,
    breadth: 0.15,
    sectorBreadth: 0.15,
    volume: 0.10,
    vwapParticipation: 0.10,
    emaStructure: 0.10,
    momentum: 0.10,
    volatility: 0.05,
    foPositioning: 0.05,
  };

  const compositeScore = 
    factors.indexTrend * weights.indexTrend +
    factors.breadth * weights.breadth +
    factors.sectorBreadth * weights.sectorBreadth +
    factors.volume * weights.volume +
    factors.vwapParticipation * weights.vwapParticipation +
    factors.emaStructure * weights.emaStructure +
    factors.momentum * weights.momentum +
    factors.volatility * weights.volatility +
    factors.foPositioning * weights.foPositioning;

  // VIX override for high volatility
  if (vix > 30) {
    return {
      regime: "HIGH VOLATILITY",
      bias: "NEUTRAL",
      tradeEnv: "EXTREME CAUTION — REDUCE SIZE / STAY OUT",
      score: Math.round(compositeScore),
    };
  }
  if (vix > 25) {
    return {
      regime: "HIGH VOLATILITY",
      bias: compositeScore > 0 ? "BULLISH" : "BEARISH",
      tradeEnv: "CAUTION — REDUCE SIZE",
      score: Math.round(compositeScore),
    };
  }

  // Determine regime from composite score
  let regime: string;
  let bias: string;
  let tradeEnv: string;

  if (compositeScore > 40) {
    regime = "STRONG BULLISH";
    bias = "BULLISH";
    tradeEnv = "FAVOR LONGS — AGGRESSIVE";
  } else if (compositeScore > 15) {
    regime = "BULLISH";
    bias = "BULLISH";
    tradeEnv = "FAVOR LONGS";
  } else if (compositeScore > -15) {
    regime = "NEUTRAL";
    bias = "NEUTRAL";
    tradeEnv = "SELECTIVE — WAIT FOR CLARITY";
  } else if (compositeScore > -40) {
    regime = "BEARISH";
    bias = "BEARISH";
    tradeEnv = "FAVOR SHORTS";
  } else {
    regime = "STRONG BEARISH";
    bias = "BEARISH";
    tradeEnv = "FAVOR SHORTS — DEFENSIVE";
  }

  return { regime, bias, tradeEnv, score: Math.round(compositeScore) };
}

export async function GET() {
  try {
    if (cache && Date.now() - cache.ts < CACHE_TTL) {
      return NextResponse.json(cache.data);
    }

    // Step 1: Fetch stocks first (needed for index fallback)
    const stocks = await fetchNIFTY50Stocks();

    // Step 2: Fetch indices + VIX in parallel (NSE primary, Moneycontrol/Yahoo fallback)
    const [indexData, vixData] = await Promise.all([
      // Fetch indices — NSE primary
      (async () => {
        const nseIndices = await getNSEIndices();
        if (nseIndices.length > 0) {
          // NSE returned data — use it directly
          const result = [];
          for (const idx of INDICES) {
            const nseIdx = nseIndices.find(n => n.key === idx.key);
            if (nseIdx) {
              result.push(nseIdx);
            } else if (idx.key === "FINNIFTY") {
              // FINNIFTY not on NSE allIndices — estimate from stocks
              const estimated = estimateIndexFromStocks(idx.key, stocks);
              if (estimated) result.push({ key: idx.key, name: idx.name, ltp: estimated.ltp, change: parseFloat((estimated.ltp - estimated.prev).toFixed(2)), changePct: parseFloat(estimated.changePct.toFixed(2)), prevClose: estimated.prev, estimated: true });
            }
          }
          return result;
        }
        // NSE failed — fallback to Moneycontrol/Yahoo
        const indexData: any[] = [];
        for (const idx of INDICES) {
          const sources: FallbackSource<{ ltp: number; prev: number }>[] = [];
          if (idx.mcId) sources.push({ name: `MC:${idx.key}`, fetch: () => fetchIndexMC(idx.mcId) });
          sources.push({ name: `YF:${idx.key}`, fetch: () => fetchIndexYahoo(idx.yahoo) });
          const { data } = await fetchWithFallback(sources);
          if (data) {
            indexData.push({ key: idx.key, name: idx.name, ltp: data.ltp, change: parseFloat((data.ltp - data.prev).toFixed(2)), changePct: parseFloat((((data.ltp - data.prev) / data.prev) * 100).toFixed(2)), prevClose: data.prev });
          } else {
            const estimated = estimateIndexFromStocks(idx.key, stocks);
            if (estimated) indexData.push({ key: idx.key, name: idx.name, ltp: estimated.ltp, change: parseFloat((estimated.ltp - estimated.prev).toFixed(2)), changePct: parseFloat(estimated.changePct.toFixed(2)), prevClose: estimated.prev, estimated: true });
          }
        }
        return indexData;
      })(),

      // Fetch VIX — NSE primary, Yahoo fallback
      (async () => {
        const nseVix = await getNSEIndiaVIX();
        if (nseVix && nseVix.value > 0) return nseVix;
        const vixSources: FallbackSource<{ value: number; change: number }>[] = [{
          name: "YF:VIX",
          fetch: async () => {
            const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EINDIAVIX?range=1d&interval=1d", { signal: AbortSignal.timeout(8000) });
            if (!res.ok) return null;
            const data = await res.json();
            const meta = data?.chart?.result?.[0]?.meta;
            if (!meta?.regularMarketPrice) return null;
            const prev = meta.chartPreviousClose || meta.regularMarketPrice;
            // Same unit as getNSEIndiaVIX: PERCENT change (this used to
            // return points — dashboards mixed +7.04% NSE with +0.85 Yahoo)
            const changePct = prev > 0 ? ((meta.regularMarketPrice - prev) / prev) * 100 : 0;
            return { value: parseFloat(meta.regularMarketPrice.toFixed(2)), change: parseFloat(changePct.toFixed(2)) };
          },
        }];
        const { data } = await fetchWithFallback(vixSources);
        return data || { value: 15, change: 0 };
      })(),
    ]);

    const vix = vixData.value;

    // Calculate multi-factor regime factors
    const nifty = indexData.find(i => i.key === "NIFTY");
    const bankNifty = indexData.find(i => i.key === "BANKNIFTY");

    // 1. Index Trend (NIFTY change + trend consistency)
    const indexChanges = indexData.map(i => i.changePct);
    const avgIndexChange = indexData.length > 0
      ? indexData.reduce((sum, i) => sum + i.changePct, 0) / indexData.length
      : 0;
    const trendConsistency = indexChanges.filter(c => c > 0).length / indexChanges.length;
    const indexTrend = avgIndexChange * 10 + (trendConsistency - 0.5) * 40; // -100 to +100

    // 2. Market Breadth (from stocks)
    // Re-fetch stocks for breadth calculation (or use cached)
    const breadthStocks = await fetchNIFTY50Stocks();
    const advances = breadthStocks.filter(s => s.changePct > 0).length;
    const declines = breadthStocks.filter(s => s.changePct < 0).length;
    const total = breadthStocks.length;
    const breadthRatio = declines > 0 ? advances / declines : advances > 0 ? 100 : 1;
    const breadth = Math.max(-100, Math.min(100, (breadthRatio - 1) * 50)); // -100 to +100

    // 3. Sector Breadth
    const sectorMap = new Map<string, number[]>();
    for (const s of breadthStocks) {
      if (!sectorMap.has(s.sector)) sectorMap.set(s.sector, []);
      sectorMap.get(s.sector)!.push(s.changePct);
    }
    const sectorBiases = Array.from(sectorMap.values()).map(changes => {
      const pos = changes.filter(c => c > 0).length;
      const neg = changes.filter(c => c < 0).length;
      return (pos - neg) / (pos + neg); // -1 to +1
    });
    const sectorBreadth = sectorBiases.length > 0
      ? (sectorBiases.reduce((sum, b) => sum + b, 0) / sectorBiases.length) * 100
      : 0; // -100 to +100

    // 4. Volume
    const volAdvancing = breadthStocks.filter(s => s.changePct > 0).reduce((sum, s) => sum + s.volume, 0);
    const volDeclining = breadthStocks.filter(s => s.changePct < 0).reduce((sum, s) => sum + s.volume, 0);
    const volRatio = volDeclining > 0 ? volAdvancing / volDeclining : volAdvancing > 0 ? 100 : 1;
    const volume = Math.max(-100, Math.min(100, (volRatio - 1) * 50));

    // 5. VWAP Participation
    const aboveVWAP = breadthStocks.filter(s => {
      const vwap = (s.dayHigh + s.dayLow + s.ltp) / 3;
      return s.ltp > vwap;
    }).length;
    const vwapParticipation = total > 0 ? ((aboveVWAP / total) * 200 - 100) : 0; // -100 to +100

    // 6. EMA Structure
    const aboveEMA20 = breadthStocks.filter(s => s.ltp > (s.prevClose + (s.change || 0) * 0.3)).length;
    const aboveEMA50 = breadthStocks.filter(s => s.ltp > s.prevClose).length;
    const aboveEMA200 = breadthStocks.filter(s => s.ltp > s.prevClose * 0.95).length;
    const emaScore = ((aboveEMA20 + aboveEMA50 + aboveEMA200) / (3 * total)) * 200 - 100; // -100 to +100

    // 7. Momentum
    const strongMomentum = breadthStocks.filter(s => s.changePct > 2).length;
    const weakMomentum = breadthStocks.filter(s => s.changePct < -2).length;
    const momentum = total > 0 ? ((strongMomentum - weakMomentum) / total) * 100 : 0; // -100 to +100

    // 8. Volatility (VIX-based, inverted for scoring)
    const volatility = Math.max(0, 100 - vix * 3); // Lower VIX = higher score

    // 9. F&O Positioning (placeholder - would need real OI data)
    const foPositioning = 0; // placeholder

    // 10. ADX estimation from stock momentum spread (proxy for trend strength)
    const absChanges = breadthStocks.map(s => Math.abs(s.changePct));
    const avgAbsChange = absChanges.length > 0 ? absChanges.reduce((a, b) => a + b, 0) / absChanges.length : 0;
    const avgAdx = Math.min(50, Math.max(10, avgAbsChange * 8 + 10)); // rough proxy: big moves = high ADX

    const factors: RegimeFactors = {
      indexTrend,
      breadth,
      sectorBreadth,
      volume,
      vwapParticipation,
      emaStructure: emaScore,
      momentum,
      volatility,
      foPositioning,
    };

    const regimeResult = calculateRegime(factors, vix);

    // Market session
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const hours = ist.getHours();
    const mins = ist.getMinutes();
    const day = ist.getDay();
    const timeNum = hours * 100 + mins;
    const iso = ist.toISOString().split('T')[0];

    const NSE_HOLIDAYS = new Set([
      '2026-01-26', '2026-03-10', '2026-03-30', '2026-04-02', '2026-04-14',
      '2026-05-01', '2026-08-15', '2026-09-14', '2026-10-02', '2026-11-11', '2026-12-25',
    ]);

    let session: string;
    if (day === 0 || day === 6) session = "CLOSED";
    else if (NSE_HOLIDAYS.has(iso)) session = "CLOSED";
    else if (timeNum < 915) session = "PRE_OPEN";
    else if (timeNum < 930) session = "OPEN";
    else if (timeNum < 1530) session = "REGULAR";
    else if (timeNum < 1600) session = "POST_MARKET";
    else session = "CLOSED";

    const freshness = buildFreshnessMeta({
      provider: indexData.some((i: any) => !i.estimated) ? "nse-india" : "moneycontrol+yahoo",
      dataTimestamp: new Date(),
      dataType: "regime",
    });

    const result = {
      regime: regimeResult.regime,
      bias: regimeResult.bias,
      tradeEnv: regimeResult.tradeEnv,
      regimeScore: regimeResult.score,
      freshness,
      // VIX Regime for Option Buyers (Section 5C)
      vixBuyerRegime: vix < 12 ? 'COMPLACENT' : vix < 15 ? 'CALM' : vix < 20 ? 'NORMAL' : vix < 25 ? 'ELEVATED' : 'FEAR',
      vixBuyerAction: vix < 12 ? 'BEST buying zone — premiums cheap' : vix < 15 ? 'Good directional buys with confluence' : vix < 20 ? 'Only score >= 75 setups' : vix < 25 ? 'Half size, ATM/ITM only' : 'NO TRADE — expensive premiums + whipsaw',
      // ADX Regime (Section 5F)
      adxRegime: avgAdx > 25 ? 'TRENDING' : avgAdx < 20 ? 'CHOPPY' : 'MODERATE',
      adxAction: avgAdx > 25 ? 'Directional CE/PE buying allowed' : avgAdx < 20 ? 'NO TRADE unless extreme + rejection' : 'Selective buying with higher confluence',
      factors: {
        indexTrend: Math.round(indexTrend),
        breadth: Math.round(breadth),
        sectorBreadth: Math.round(sectorBreadth),
        volume: Math.round(volume),
        vwapParticipation: Math.round(vwapParticipation),
        emaStructure: Math.round(emaScore),
        momentum: Math.round(momentum),
        volatility: Math.round(volatility),
        foPositioning: Math.round(foPositioning),
      },
      session,
      vix: { value: vix, change: vixData.change },
      indices: indexData,
      nifty: nifty?.ltp || 0,
      niftyChange: nifty?.changePct || 0,
      bankNifty: bankNifty?.ltp || 0,
      bankNiftyChange: bankNifty?.changePct || 0,
      avgIndexChange: parseFloat(avgIndexChange.toFixed(2)),
      timestamp: new Date().toISOString(),
    };

    cache = { data: result, ts: Date.now() };
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Regime fetch failed" }, { status: 500 });
  }
}