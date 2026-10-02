// ═══════════════════════════════════════════════════════════════════════════
// MODE B — STOCK F&O
// Scans all NSE F&O stocks for the strongest setup.
// Uses: Intraday Scanner + F&O Scanner + IDE + Technical Analysis +
//       OI Buildup + IV + Volume + Sector Strength
// ═══════════════════════════════════════════════════════════════════════════

import type { MarketIntelligenceContext } from "./market-context";
import { deriveIvStats, findAtmStrike } from "@/lib/option-chain-normalizer";

// ── Types ──
export type StockTradeDirection = "LONG" | "SHORT" | "BUY_CE" | "BUY_PE" | "NO_TRADE";

export interface StockFOSignal {
  symbol: string;
  name: string;
  sector: string;
  direction: StockTradeDirection;
  confidence: number;
  score: number;
  reasoning: string[];
  factors: {
    oiSignal: number;
    ivPercentile: number;
    premiumVelocity: number;
    volumeConfirmation: number;
    technicalAlignment: number;
    sectorStrength: number;
    institutionalFlow: number;
    futuresPositioning: number;
  };
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  holdingPeriod: string;
  recommendedInstrument: string;
  strike: number;
  expiry: string;
  premium: number;
  maxRisk: string;
  invalidation: string;
  setupType: string;
}

// ── Fetch live option chain for a stock ──
/**
 * The /api/option-chain route nests the chain at `data.summary` /
 * `data.strikes` — reading a top-level `summary` always returned null and
 * this mode ran chainless (no PCR, no real premium). Accept both the
 * nested envelope and an unwrapped legacy shape; require real content.
 */
export function parseStockChainResponse(json: any): any | null {
  if (!json || typeof json !== "object") return null;
  const inner =
    json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
  if (inner?.summary) return inner;
  if (Array.isArray(inner?.strikes) && inner.strikes.length > 0) return inner;
  return null;
}

/**
 * Options-first direction policy. This mode has no real futures-positioning
 * evidence (the old LONG/SHORT branches scored against a hardcoded 50), so
 * any directional edge ≥60 confidence becomes a CE/PE recommendation —
 * never futures.
 */
export function determineStockFODirection(
  bullScore: number,
  bearScore: number
): { direction: StockTradeDirection; confidence: number } {
  const total = bullScore + bearScore;
  if (total <= 0) return { direction: "NO_TRADE", confidence: 0 };
  if (bullScore > bearScore) {
    const confidence = Math.min(95, Math.round((bullScore / total) * 100));
    return { direction: confidence >= 60 ? "BUY_CE" : "NO_TRADE", confidence };
  }
  if (bearScore > bullScore) {
    const confidence = Math.min(95, Math.round((bearScore / total) * 100));
    return { direction: confidence >= 60 ? "BUY_PE" : "NO_TRADE", confidence };
  }
  return { direction: "NO_TRADE", confidence: 0 };
}

async function fetchStockOptionChain(symbol: string): Promise<any | null> {
  try {
    const res = await fetch(`http://localhost:3000/api/option-chain?symbol=${symbol}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return parseStockChainResponse(json);
  } catch {
    return null;
  }
}

// ── Score a single stock ──
function scoreStock(
  quote: any,
  chainData: any,
  ctx: MarketIntelligenceContext
): StockFOSignal {
  const reasoning: string[] = [];
  let bullScore = 0;
  let bearScore = 0;

  const symbol = quote.symbol;
  const price = quote.price || 0;
  const changePercent = quote.changePercent || 0;
  const rvol = quote.relativeVolume || 1;

  // Factor 1: Price action + trend (0-20 points)
  if (changePercent > 2) {
    bullScore += 20;
    reasoning.push(`Strong up move +${changePercent.toFixed(1)}%`);
  } else if (changePercent > 0.5) {
    bullScore += 12;
    reasoning.push(`Mild up move +${changePercent.toFixed(1)}%`);
  } else if (changePercent < -2) {
    bearScore += 20;
    reasoning.push(`Strong down move ${changePercent.toFixed(1)}%`);
  } else if (changePercent < -0.5) {
    bearScore += 12;
    reasoning.push(`Mild down move ${changePercent.toFixed(1)}%`);
  } else {
    bullScore += 5;
    bearScore += 5;
  }

  // Factor 2: Relative volume (0-15 points)
  if (rvol > 2) {
    bullScore += 15;
    bearScore += 15;
    reasoning.push(`High relative volume ${rvol.toFixed(1)}x — institutional interest`);
  } else if (rvol > 1.2) {
    bullScore += 10;
    bearScore += 10;
    reasoning.push(`Above-average volume ${rvol.toFixed(1)}x`);
  } else {
    bullScore += 3;
    bearScore += 3;
  }

  // Factor 3: Sector strength (0-15 points)
  const sector = ctx.sectors.find(s => s.sector === quote.sector);
  if (sector) {
    if (sector.strength > 60) {
      bullScore += 15;
      reasoning.push(`Sector ${quote.sector} strong (${sector.strength}/100)`);
    } else if (sector.strength < 40) {
      bearScore += 15;
      reasoning.push(`Sector ${quote.sector} weak (${sector.strength}/100)`);
    } else {
      bullScore += 7;
      bearScore += 7;
    }
  }

  // Factor 4: Option chain analysis (0-20 points) — REAL chain required.
  // chainData is the route's inner envelope: { summary, strikes, selectedExpiry }
  const summary = chainData?.summary || null;
  const rawStrikes: any[] = Array.isArray(chainData?.strikes) ? chainData.strikes : [];
  const atmStrike =
    summary?.atmStrike ||
    (rawStrikes.length > 0 ? findAtmStrike(rawStrikes.map((s: any) => s.strike), price) : 0);
  const chainStats =
    rawStrikes.length > 0 && atmStrike > 0 ? deriveIvStats(rawStrikes, atmStrike) : null;

  if (summary) {
    const pcr = (typeof summary.pcr === "number" && Number.isFinite(summary.pcr))
      ? summary.pcr
      : null;
    if (pcr == null) {
      reasoning.push("PCR unavailable");
    } else if (pcr > 1.3) {
      bullScore += 20;
      reasoning.push(`PCR ${pcr.toFixed(2)} — heavy put writing, support building`);
    } else if (pcr > 1.0) {
      bullScore += 12;
      reasoning.push(`PCR ${pcr.toFixed(2)} — mild bullish`);
    } else if (pcr < 0.7) {
      bearScore += 20;
      reasoning.push(`PCR ${pcr.toFixed(2)} — heavy call writing, resistance building`);
    } else if (pcr < 1.0) {
      bearScore += 12;
      reasoning.push(`PCR ${pcr.toFixed(2)} — mild bearish`);
    } else {
      bullScore += 6;
      bearScore += 6;
    }

    // IV percentile — only from real IVs (0 = unavailable, never "50 = normal")
    const ivRank = chainStats && chainStats.ivRank > 0 ? chainStats.ivRank : null;
    if (ivRank != null) {
      if (ivRank > 70) {
        reasoning.push(`IV rank ${ivRank}% — elevated, selling favored`);
      } else if (ivRank < 30) {
        reasoning.push(`IV rank ${ivRank}% — cheap, buying favored`);
      }
    }
  }

  // Factor 5: Market regime alignment (0-15 points)
  const regime = ctx.regime;
  if (regime.trend === "BULLISH" && changePercent > 0) {
    bullScore += 15;
    reasoning.push(`Regime bullish + stock rising — aligned`);
  } else if (regime.trend === "BEARISH" && changePercent < 0) {
    bearScore += 15;
    reasoning.push(`Regime bearish + stock falling — aligned`);
  } else if (regime.trend === "BULLISH" && changePercent < 0) {
    bullScore += 7;
    bearScore += 5;
    reasoning.push(`Regime bullish but stock pulling back — potential entry`);
  } else {
    bullScore += 7;
    bearScore += 7;
  }

  // Factor 6: Breadth confirmation (0-10 points)
  const breadthScore = ctx.breadth.breadthScore;
  if (changePercent > 0 && breadthScore > 60) {
    bullScore += 10;
    reasoning.push(`Breadth confirms rally (${breadthScore}/100)`);
  } else if (changePercent < 0 && breadthScore < 40) {
    bearScore += 10;
    reasoning.push(`Breadth confirms selloff (${breadthScore}/100)`);
  }

  // Factor 7: Institutional flow (0-5 points)
  const fiiNet = ctx.fiiDii.fii.net;
  if (fiiNet > 0 && changePercent > 0) {
    bullScore += 5;
    reasoning.push(`FII inflow supports stock rally`);
  } else if (fiiNet < 0 && changePercent < 0) {
    bearScore += 5;
    reasoning.push(`FII outflow pressures stock`);
  }

  // Factor 8: MSS sweep-gated structure (0-12 points)
  const stockTech = ctx.technicals[quote.symbol];
  if (stockTech && stockTech.mssBias !== 'NEUTRAL') {
    if (stockTech.mssBias === 'BULLISH') {
      bullScore += stockTech.mssSweepGated ? 12 : 8;
      reasoning.push(`MSS ${stockTech.mssSweepGated ? 'sweep-gated ' : ''}bullish (score ${stockTech.mssScore})`);
    } else if (stockTech.mssBias === 'BEARISH') {
      bearScore += stockTech.mssSweepGated ? 12 : 8;
      reasoning.push(`MSS ${stockTech.mssSweepGated ? 'sweep-gated ' : ''}bearish (score ${stockTech.mssScore})`);
    }
  }

  // Factor 9: SuperTrend filter (0-8 points)
  if (stockTech && stockTech.supertrendDirection !== 'NEUTRAL') {
    if (stockTech.supertrendAligned) {
      bullScore += 8;
      reasoning.push(`SuperTrend ${stockTech.supertrendDirection} confirms trend`);
    } else {
      bearScore += 4;
      reasoning.push(`SuperTrend counter to direction — caution`);
    }
  }

  // Determine direction — options-only (see determineStockFODirection)
  const totalScore = bullScore + bearScore;
  const netBias = bullScore - bearScore;
  const { direction, confidence } = determineStockFODirection(bullScore, bearScore);

  // Calculate levels
  const atr = price * 0.015;
  let entry = price;
  let stopLoss = 0;
  let target1 = 0;
  let target2 = 0;

  if (direction === "LONG" || direction === "BUY_CE") {
    stopLoss = price - atr * 1.5;
    target1 = price + atr * 2;
    target2 = price + atr * 3;
  } else if (direction === "SHORT" || direction === "BUY_PE") {
    stopLoss = price + atr * 1.5;
    target1 = price - atr * 2;
    target2 = price - atr * 3;
  }

  const riskReward = direction !== "NO_TRADE"
    ? Math.abs(target1 - entry) / Math.abs(entry - stopLoss)
    : 0;

  // Instrument — real ATM premium from the chain (never IV-as-premium);
  // 0 means "chain had no premium", reported as-is.
  let recommendedInstrument = "NO_TRADE";
  let strike = 0;
  let premium = 0;
  const expiry = chainData?.selectedExpiry || summary?.expiry || "";

  if (direction === "BUY_CE") {
    strike = atmStrike || price;
    recommendedInstrument = `${symbol} ${strike} CE`;
    premium = chainStats?.atmCePremium || 0;
  } else if (direction === "BUY_PE") {
    strike = atmStrike || price;
    recommendedInstrument = `${symbol} ${strike} PE`;
    premium = chainStats?.atmPePremium || 0;
  } else if (direction === "LONG") {
    recommendedInstrument = `${symbol} Futures`;
  } else if (direction === "SHORT") {
    recommendedInstrument = `${symbol} Short Futures`;
  }

  return {
    symbol,
    name: quote.name || symbol,
    sector: quote.sector || "",
    direction,
    confidence,
    score: Math.round((totalScore / 100) * 100),
    reasoning,
    factors: {
      oiSignal: summary
        ? (typeof summary.pcr === "number" && summary.pcr > 1 ? 70 : 30)
        : 50,
      ivPercentile: chainStats?.ivRank || 0,
      premiumVelocity: 50,
      volumeConfirmation: rvol > 1.5 ? 80 : rvol > 1 ? 60 : 40,
      technicalAlignment: changePercent > 0 ? 60 : 40,
      sectorStrength: sector?.strength || 50,
      institutionalFlow: fiiNet > 0 ? 70 : 30,
      futuresPositioning: 50,
    },
    entry,
    stopLoss,
    target1,
    target2,
    riskReward,
    holdingPeriod: "Intraday to 3 days",
    recommendedInstrument,
    strike,
    expiry,
    premium,
    maxRisk: `${Math.abs(entry - stopLoss).toFixed(0)} pts`,
    invalidation: direction === "LONG" || direction === "BUY_CE"
      ? `Break below ${stopLoss.toFixed(0)}`
      : direction === "SHORT" || direction === "BUY_PE"
        ? `Break above ${stopLoss.toFixed(0)}`
        : "N/A",
    setupType: netBias > 0 ? "BULLISH" : netBias < 0 ? "BEARISH" : "NEUTRAL",
  };
}

// ── Main: Scan all F&O stocks ──
export interface StockFOScanOpts {
  /** Pre-filtered quote universe (e.g. affordable lots) — replaces ctx slice */
  quotes?: { symbol: string; price: number; changePercent: number }[];
  /** Max option chains to fetch (default 5) — fetched in waves of 6 */
  maxChains?: number;
}

export async function analyzeStockFO(
  ctx: MarketIntelligenceContext,
  maxStocks = 20,
  opts?: StockFOScanOpts
): Promise<StockFOSignal[]> {
  const signals: StockFOSignal[] = [];

  // Get stock quotes from context (or caller-provided universe)
  const quotes = opts?.quotes ?? ctx.stockQuotes.slice(0, maxStocks);
  const maxChains = opts?.maxChains ?? 5;

  // Pick scan candidates: session-range prices, most active first
  // (bounds match buildStockOptionUniverse in challenge-engine)
  const topStocks = quotes
    .filter(q => q.price >= 20 && q.price <= 10000)
    .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
    .slice(0, Math.max(maxChains, 10));

  // Fetch option chains in waves of 6 (bounded concurrency — avoids
  // hammering Breeze/NSE when the universe grows to 12+ symbols)
  const chainTargets = topStocks.slice(0, maxChains);
  const chainMap = new Map<string, any>();
  const WAVE = 6;
  for (let i = 0; i < chainTargets.length; i += WAVE) {
    const wave = chainTargets.slice(i, i + WAVE);
    const results = await Promise.allSettled(wave.map(q => fetchStockOptionChain(q.symbol)));
    wave.forEach((q, j) => {
      const r = results[j];
      if (r.status === "fulfilled" && r.value) chainMap.set(q.symbol, r.value);
    });
  }

  // Score each stock
  for (const quote of topStocks) {
    const chainData = chainMap.get(quote.symbol) || null;
    signals.push(scoreStock(quote, chainData, ctx));
  }

  // Sort by confidence
  signals.sort((a, b) => b.confidence - a.confidence);

  console.log(
    `[StockFO] quotes=${quotes.length} top=${topStocks.length} chains=${chainMap.size} signals=${signals.length} ` +
    `dirs=${signals.map(s => s.direction).join(",")}`
  );

  return signals;
}
