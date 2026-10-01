// Hermes Context — parallel data collector using existing SMDApp engines
// Fetches only the data required for the current task via the tool registry.

import type {
  HermesContext, HermesMode, FreshData, SpotData, OptionChainData,
  StructureData, GreeksData, GammaData, VolumeData, FIIDIIData,
  NewsData, RegimeData, ExpiryLiquidityData, BacktestData, DataFreshness, ToolStatus,
  MCXIntelligenceData, DataProvider
} from "./types";
import { classifyFreshness } from "./freshness";
import { getRequiredTools } from "./tool-registry";

const BASE = ""; // Same-origin API calls

// Map raw API provenance strings onto Hermes DataProvider
function toProvider(raw: unknown, fallback: DataProvider = "nse"): DataProvider {
  const s = String(raw || "").toLowerCase();
  if (!s) return fallback;
  if (s.includes("breeze") || s === "icici-breeze") return "icici-breeze";
  if (s.includes("motilal") || s === "moapi") return "moapi";
  if (s.includes("bse")) return "bse-api";
  if (s.includes("nse")) return "nse";
  if (s.includes("yahoo")) return "yahoo";
  if (s.includes("website")) return "website";
  return fallback;
}

// ── Fetch Helper ───────────────────────────────────────────────────────

async function fetchJSON(path: string, timeout = 10_000): Promise<any | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function wrapFresh<T>(
  value: T | null,
  source: any,
  dataType: string
): FreshData<T> {
  if (value === null) {
    return {
      value: null as any,
      source: "yahoo",
      timestamp: new Date().toISOString(),
      ageMs: 0,
      freshness: "UNAVAILABLE",
      status: "UNAVAILABLE" as ToolStatus,
      delayed: false,
      fallbackUsed: false,
      error: "Data unavailable",
    };
  }

  const ts = (value as any)?.timestamp || (value as any)?.lastUpdate || new Date().toISOString();
  const freshness = classifyFreshness(ts, dataType);

  return {
    value,
    source: source || "unknown",
    timestamp: ts,
    ageMs: Date.now() - new Date(ts).getTime(),
    freshness,
    status: "SUCCESS",
    delayed: source === "yahoo",
    fallbackUsed: false,
  };
}

// ── Parallel Data Collection ───────────────────────────────────────────

export async function collectHermesContext(
  symbol: string,
  mode: HermesMode,
  apiBase: string = ""
): Promise<HermesContext> {
  const now = new Date();
  const requiredTools = getRequiredToolsForMode(mode);

  // Build fetch plan based on required tools
  const fetches: Record<string, Promise<any>> = {};

  if (requiredTools.includes("get_spot") || requiredTools.includes("get_option_chain")) {
    fetches.optionChain = fetchJSON(`${apiBase}/api/option-chain?symbol=${symbol}`, 12_000);
  }
  if (requiredTools.includes("get_fii_dii")) {
    fetches.fiiDii = fetchJSON(`${apiBase}/api/fii-dii`, 8_000);
  }
  if (requiredTools.includes("get_news")) {
    fetches.news = fetchJSON(`${apiBase}/api/news?symbol=${symbol}`, 8_000);
  }
  if (requiredTools.includes("get_regime")) {
    fetches.regime = fetchJSON(`${apiBase}/api/market/regime?symbol=${symbol}`, 10_000);
  }
  if (requiredTools.includes("get_market_structure")) {
    fetches.structure = fetchJSON(`${apiBase}/api/sdm-signal?symbol=${symbol}`, 10_000);
  }
  if (requiredTools.includes("get_gamma")) {
    fetches.gamma = fetchJSON(`${apiBase}/api/greek-flow?symbol=${symbol}`, 10_000);
  }
  if (requiredTools.includes("get_mcx_data")) {
    fetches.mcx = fetchJSON(`${apiBase}/api/mcx`, 15_000);
  }
  if (requiredTools.includes("get_backtest_results")) {
    fetches.backtest = fetchJSON(`${apiBase}/api/backtest/trades?symbol=${symbol}`, 15_000);
  }
  if (requiredTools.includes("get_mtf_signal")) {
    fetches.mtf = fetchJSON(`${apiBase}/api/mtf-signal?symbol=${symbol}`, 15_000);
  }
  // MCX-specific intelligence fetch
  const isMCX = getExchange(symbol) === "MCX";
  if (isMCX) {
    fetches.mcxIntel = fetchJSON(`${apiBase}/api/mcx/intelligence?symbol=${symbol}`, 15_000);
  }

  // Execute all fetches in parallel
  const results = await Promise.allSettled(Object.values(fetches));
  const keys = Object.keys(fetches);
  const data: Record<string, any> = {};

  keys.forEach((key, i) => {
    const result = results[i];
    data[key] = result.status === "fulfilled" ? result.value : null;
  });

  // Build context from fetched data
  const canonicalChain = data.optionChain?.canonical;
  const chainData = data.optionChain?.data;
  const summary = chainData?.summary || chainData;

  // Spot data — prefer canonical chain spot, then raw data
  const spotPrice = canonicalChain?.spot || summary?.spotPrice || chainData?.spotPrice || 0;
  const prevClose = summary?.prevClose || 0;
  const spot: FreshData<SpotData> = {
    value: {
      price: spotPrice,
      change: spotPrice - prevClose,
      changePct: prevClose > 0 ? ((spotPrice - prevClose) / prevClose) * 100 : 0,
      prevClose,
      open: summary?.open || spotPrice,
      high: summary?.high || spotPrice,
      low: summary?.low || spotPrice,
      volume: summary?.volume || 0,
    },
    source: toProvider(data.optionChain?.source || data.optionChain?.data?.dataSource, data.optionChain ? "nse" : "yahoo"),
    timestamp: now.toISOString(),
    ageMs: 0,
    freshness: spotPrice > 0 ? "LIVE" : "UNAVAILABLE",
    status: spotPrice > 0 ? "SUCCESS" : "UNAVAILABLE",
    delayed: false,
    fallbackUsed: false,
  };

  // Option chain — prefer canonical chain from normalizer
  let optionChain: FreshData<OptionChainData>;
  if (canonicalChain && canonicalChain.strikes?.length > 0) {
    // Map canonical strikes to Hermes OptionStrike format
    const hermesStrikes = canonicalChain.strikes.map((s: any) => ({
      strike: s.strike,
      ce: s.ce ? {
        ltp: s.ce.premium || 0,
        bid: s.ce.bid ?? null,
        ask: s.ce.ask ?? null,
        spread: s.ce.spread ?? null,
        quoteQuality: s.ce.quoteQuality || 'UNKNOWN',
        volume: s.ce.volume || 0,
        oi: s.ce.oi || 0,
        oiChange: s.ce.oiChange || 0,
        iv: s.ce.iv || 0,
        delta: s.ce.delta || 0,
        gamma: s.ce.gamma || 0,
        theta: s.ce.theta || 0,
        vega: s.ce.vega || 0,
        rho: 0,
      } : { ltp: 0, bid: null, ask: null, spread: null, quoteQuality: 'UNKNOWN' as const, volume: 0, oi: 0, oiChange: 0, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 },
      pe: s.pe ? {
        ltp: s.pe.premium || 0,
        bid: s.pe.bid ?? null,
        ask: s.pe.ask ?? null,
        spread: s.pe.spread ?? null,
        quoteQuality: s.pe.quoteQuality || 'UNKNOWN',
        volume: s.pe.volume || 0,
        oi: s.pe.oi || 0,
        oiChange: s.pe.oiChange || 0,
        iv: s.pe.iv || 0,
        delta: s.pe.delta || 0,
        gamma: s.pe.gamma || 0,
        theta: s.pe.theta || 0,
        vega: s.pe.vega || 0,
        rho: 0,
      } : { ltp: 0, bid: null, ask: null, spread: null, quoteQuality: 'UNKNOWN' as const, volume: 0, oi: 0, oiChange: 0, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 },
    }));

    optionChain = {
      value: {
        symbol,
        spot: spotPrice,
        atmStrike: canonicalChain.atmStrike || 0,
        expiry: canonicalChain.expiry || "",
        daysToExpiry: canonicalChain.daysToExpiry || 0,
        strikes: hermesStrikes,
        totalCallOI: canonicalChain.totalCallOI || 0,
        totalPutOI: canonicalChain.totalPutOI || 0,
        callOiChange: canonicalChain.callOiChange || 0,
        putOiChange: canonicalChain.putOiChange || 0,
        pcrOI: canonicalChain.pcr || 0,
        pcrVolume: canonicalChain.pcrVolume || 0,
        maxPain: canonicalChain.maxPain || 0,
        callWall: 0,
        putWall: 0,
        gammaWall: 0,
        gammaFlip: 0,
        expectedMove: 0,
        vix: summary?.indiaVIX || 0,
        futuresPrice: summary?.futuresPrice || 0,
      },
      source: toProvider(canonicalChain.dataSource || data.optionChain?.source || data.optionChain?.data?.dataSource, "nse"),
      timestamp: now.toISOString(),
      ageMs: 0,
      freshness: "LIVE",
      status: "SUCCESS",
      delayed: false,
      fallbackUsed: false,
    };
  } else if (chainData) {
    optionChain = {
      value: {
        symbol,
        spot: spotPrice,
        atmStrike: summary?.atmStrike || 0,
        expiry: summary?.expiry || "",
        daysToExpiry: summary?.daysToExpiry || 0,
        strikes: chainData.strikes || [],
        totalCallOI: summary?.totalCallOI || 0,
        totalPutOI: summary?.totalPutOI || 0,
        callOiChange: summary?.callOiChange || 0,
        putOiChange: summary?.putOiChange || 0,
        pcrOI: summary?.pcr || 0,
        pcrVolume: summary?.pcrVolume || 0,
        maxPain: summary?.maxPain || 0,
        callWall: summary?.callWall || 0,
        putWall: summary?.putWall || 0,
        gammaWall: summary?.gammaWall || 0,
        gammaFlip: summary?.gammaFlip || 0,
        expectedMove: summary?.expectedMove || 0,
        vix: summary?.indiaVIX || 0,
        futuresPrice: summary?.futuresPrice || 0,
      },
      source: toProvider(data.optionChain?.source || data.optionChain?.data?.dataSource, "nse"),
      timestamp: now.toISOString(),
      ageMs: 0,
      freshness: "LIVE",
      status: "SUCCESS",
      delayed: false,
      fallbackUsed: false,
    };
  } else {
    optionChain = wrapFresh(null, "unknown", "optionChain");
  }

  // VIX
  const vixValue = summary?.indiaVIX || data.regime?.vix || 15;
  const vix: FreshData<number> = {
    value: vixValue,
    source: toProvider(data.optionChain?.source || data.optionChain?.data?.dataSource, data.optionChain ? "nse" : "yahoo"),
    timestamp: now.toISOString(),
    ageMs: 0,
    freshness: vixValue > 0 ? "LIVE" : "UNAVAILABLE",
    status: vixValue > 0 ? "SUCCESS" : "UNAVAILABLE",
    delayed: false,
    fallbackUsed: false,
  };

  // FII/DII
  const fiiDII: FreshData<FIIDIIData> = data.fiiDii ? {
    value: {
      fiiNet: data.fiiDii.fiiNet ?? data.fiiDii.latest?.fiiNet ?? 0,
      diiNet: data.fiiDii.diiNet ?? data.fiiDii.latest?.diiNet ?? 0,
      fiiBias: (data.fiiDii.fiiNet ?? 0) > 0 ? "BULLISH_FLOW" : (data.fiiDii.fiiNet ?? 0) < 0 ? "BEARISH_FLOW" : "NEUTRAL_FLOW",
      dataDate: data.fiiDii.dataDate || now.toISOString().split("T")[0],
      publishedAt: data.fiiDii.publishedAt || now.toISOString(),
      participantOI: data.fiiDii.participantOI,
    },
    source: "nse",
    timestamp: now.toISOString(),
    ageMs: 0,
    freshness: "FRESH",
    status: "SUCCESS",
    delayed: false,
    fallbackUsed: false,
  } : wrapFresh(null, "nse", "fiiDii");

  // News
  const newsData = data.news?.data;
  const news: FreshData<NewsData> = newsData ? {
    value: {
      sentiment: newsData.market?.sentiment || "NEUTRAL",
      score: newsData.market?.score || 0,
      headlines: (newsData.articles || []).slice(0, 5).map((a: any) => a.title?.substring(0, 100) || ""),
      highImpactEvents: [],
    },
    source: "yahoo",
    timestamp: now.toISOString(),
    ageMs: 0,
    freshness: "FRESH",
    status: "SUCCESS",
    delayed: false,
    fallbackUsed: false,
  } : wrapFresh(null, "yahoo", "news");

  // Regime
  const regime: FreshData<RegimeData> = data.regime ? {
    value: {
      type: data.regime.regime || "UNCERTAIN",
      bias: data.regime.bias || "NEUTRAL",
      confidence: data.regime.confidence || 0,
      factors: data.regime.factors || {},
    },
    source: "nse",
    timestamp: now.toISOString(),
    ageMs: 0,
    freshness: "FRESH",
    status: "SUCCESS",
    delayed: false,
    fallbackUsed: false,
  } : wrapFresh(null, "nse", "regime");

  // Market structure (from SDM signal)
  const sdmData = data.structure?.signal || data.structure;
  const structure: FreshData<StructureData> = sdmData ? {
    value: {
      trend: sdmData.structure?.trend || "SIDEWAYS",
      swingHigh: sdmData.structure?.swingHigh || spotPrice,
      swingLow: sdmData.structure?.swingLow || spotPrice,
      supportLevels: sdmData.structure?.supportLevels || [],
      resistanceLevels: sdmData.structure?.resistanceLevels || [],
      lastEvent: sdmData.structure?.lastEvent || "NONE",
      pdh: sdmData.pdh || spotPrice,
      pdl: sdmData.pdl || spotPrice,
    },
    source: toProvider(data.structure?.source || data.optionChain?.source, "nse"),
    timestamp: now.toISOString(),
    ageMs: 0,
    freshness: "FRESH",
    status: "SUCCESS",
    delayed: false,
    fallbackUsed: false,
  } : wrapFresh(null, "nse", "structure");

  // Greeks (from option chain)
  const greeks: FreshData<GreeksData> = {
    value: {
      delta: summary?.atmDelta || 0.5,
      gamma: summary?.atmGamma || 0,
      theta: summary?.atmTheta || 0,
      vega: summary?.atmVega || 0,
      iv: summary?.atmIV || 0,
    },
    source: toProvider(data.structure?.source || data.optionChain?.source, "nse"),
    timestamp: now.toISOString(),
    ageMs: 0,
    freshness: "FRESH",
    status: "SUCCESS",
    delayed: false,
    fallbackUsed: false,
  };

  // Gamma
  const gamma: FreshData<GammaData> = data.gamma ? {
    value: {
      detected: data.gamma.detected || false,
      confidence: data.gamma.confidence || 0,
      dealerBias: data.gamma.dealerBias || "UNKNOWN",
      squeezePotential: data.gamma.squeezePotential || 0,
      gammaWallStrike: data.gamma.gammaWallStrike || 0,
      gammaWallType: data.gamma.gammaWallType || "NONE",
      estimatedGEX: data.gamma.estimatedGEX || 0,
      regime: "UNKNOWN",
    },
    source: toProvider(data.structure?.source || data.optionChain?.source, "nse"),
    timestamp: now.toISOString(),
    ageMs: 0,
    freshness: "FRESH",
    status: "SUCCESS",
    delayed: false,
    fallbackUsed: false,
  } : wrapFresh(null, "nse", "gamma");

  // Volume
  const volume: FreshData<VolumeData> = {
    value: {
      poc: 0,
      vah: 0,
      val: 0,
      cumulativeDelta: 0,
      totalVolume: summary?.totalVolume || 0,
      avgVolume: 0,
      absorptionLevels: [],
      exhaustionSignals: [],
    },
    source: toProvider(data.structure?.source || data.optionChain?.source, "nse"),
    timestamp: now.toISOString(),
    ageMs: 0,
    freshness: "FRESH",
    status: "SUCCESS",
    delayed: false,
    fallbackUsed: false,
  };

  // Expiry liquidity
  const expiryLiquidity: FreshData<ExpiryLiquidityData> = {
    value: {
      casDirection: "UNKNOWN",
      casConfidence: 0,
      gammaPressure: 0,
      oiShift: 0,
    },
    source: toProvider(data.structure?.source || data.optionChain?.source, "nse"),
    timestamp: now.toISOString(),
    ageMs: 0,
    freshness: "FRESH",
    status: "SUCCESS",
    delayed: false,
    fallbackUsed: false,
  };

  // Backtest
  const backtestResults: FreshData<BacktestData> = data.backtest ? {
    value: {
      winRate: data.backtest.summary?.winRate || 0,
      profitFactor: data.backtest.summary?.profitFactor || 0,
      netPnL: data.backtest.summary?.netPnL || 0,
      totalTrades: data.backtest.summary?.totalTrades || 0,
      avgWin: data.backtest.summary?.avgWin || 0,
      avgLoss: data.backtest.summary?.avgLoss || 0,
    },
    source: "yahoo",
    timestamp: now.toISOString(),
    ageMs: 0,
    freshness: "FRESH",
    status: "SUCCESS",
    delayed: false,
    fallbackUsed: false,
  } : wrapFresh(null, "yahoo", "backtest");

  // MCX Intelligence (only for MCX commodities)
  const mcxFresh = isMCX && data.mcxIntel ? {
    value: {
      regime: data.mcxIntel.regime || 'NO_TRADE',
      regimeConfidence: data.mcxIntel.regimeConfidence || 0,
      structureBias: data.mcxIntel.structureBias || 'NEUTRAL',
      structureEvent: data.mcxIntel.structureEvent || 'NONE',
      oiClassification: data.mcxIntel.oiClassification || 'NEUTRAL',
      oiDivergence: data.mcxIntel.oiDivergence || false,
      relativeVolume: data.mcxIntel.relativeVolume || 1,
      volumeState: data.mcxIntel.volumeState || 'NORMAL',
      atr: data.mcxIntel.atr || 0,
      atrPercent: data.mcxIntel.atrPercent || 0,
      volatilityRegime: data.mcxIntel.volatilityRegime || 'NORMAL_VOL',
      ivClassification: data.mcxIntel.ivClassification || 'NORMAL',
      expectedMove: data.mcxIntel.expectedMove || 0,
      chainQuality: data.mcxIntel.chainQuality || 'UNTRADEABLE',
      bestCandidateDirection: data.mcxIntel.bestCandidateDirection || 'NEUTRAL',
      bestCandidateScore: data.mcxIntel.bestCandidateScore || 0,
      bestCandidateRR: data.mcxIntel.bestCandidateRR || 0,
      longScore: data.mcxIntel.longScore || 0,
      shortScore: data.mcxIntel.shortScore || 0,
      dataFreshness: data.mcxIntel.dataFreshness || {
        candlesAvailable: false, candleCount: 0,
        optionChainAvailable: false, quoteAvailable: false,
      },
    },
    source: "yahoo",
    timestamp: now.toISOString(),
    ageMs: 0,
    freshness: "FRESH",
    status: "SUCCESS",
    delayed: false,
    fallbackUsed: false,
  } : undefined;

  // Determine market status
  const marketStatus = determineMarketStatus(now);

  return {
    timestamp: now.toISOString(),
    symbol,
    mode,
    marketStatus,
    exchange: getExchange(symbol),
    instrument: getInstrumentType(symbol),
    spot,
    optionChain,
    vix,
    fiiDII,
    news,
    regime,
    marketStructure: structure,
    greeks,
    gamma,
    volume,
    expiryLiquidity,
    backtestResults,
    ...(mcxFresh ? { mcxIntelligence: mcxFresh } : {}),
    ...(data.mtf ? { mtf: wrapFresh(data.mtf, "mtf-signal-api", "signal") } : {}),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function getRequiredToolsForMode(mode: HermesMode): string[] {
  switch (mode) {
    case "TRADE": return getRequiredTools("LIVE_TRADE");
    case "QUICK": return ["get_spot", "get_vix", "get_fii_dii"];
    case "RESEARCH": return getRequiredTools("RESEARCH");
    case "RISK": return ["get_risk_status", "get_trade_history"];
    case "BACKTEST": return ["get_backtest_results"];
    default: return ["get_spot", "get_option_chain"];
  }
}

// NSE/BSE trading holidays 2026
const NSE_HOLIDAYS = new Set([
  '2026-01-26', '2026-03-10', '2026-03-30', '2026-04-02', '2026-04-14',
  '2026-05-01', '2026-08-15', '2026-09-14', '2026-10-02', '2026-11-11', '2026-12-25',
]);

function determineMarketStatus(now: Date): any {
  // Shift epoch by +5:30 then read with UTC getters → correct IST wall-clock
  // regardless of process TZ. (getHours() after this shift double-counts IST.)
  const ist = new Date(now.getTime() + 5.5 * 3600000);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const day = ist.getUTCDay();
  const iso = ist.toISOString().split('T')[0];

  if (day === 0 || day === 6) return "WEEKEND";
  if (NSE_HOLIDAYS.has(iso)) return "HOLIDAY";
  if (mins < 555) return "PRE_MARKET";
  if (mins <= 930) return "MARKET_OPEN";
  return "MARKET_CLOSED";
}

function getExchange(symbol: string): "NSE" | "MCX" | "BSE" {
  if (["SENSEX"].includes(symbol)) return "BSE";
  if (["CRUDEOIL", "CRUDEOILM", "NATURALGAS", "NATGASMINI", "GOLD", "GOLDM", "GOLDGUINEA", "SILVER", "SILVERM", "SILVERMIC"].includes(symbol)) return "MCX";
  return "NSE";
}

function getInstrumentType(symbol: string): "index" | "fno-stock" | "cash-stock" | "commodity" {
  if (["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"].includes(symbol)) return "index";
  if (getExchange(symbol) === "MCX") return "commodity";
  return "fno-stock";
}
