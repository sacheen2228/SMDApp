// Regime Learner — adapts scoring weights based on market regime
// Learns: "In trending markets, FII buying matters more. In range-bound, OI levels matter more."

import { getResolvedTrades, type TradeRecord } from "./trade-trainer";

export interface RegimeProfile {
  regime: string;
  totalTrades: number;
  winRate: number;
  avgPnl: number;
  avgRMultiple: number;
  bestFactors: { factor: string; winRate: number; sampleSize: number }[];
  worstFactors: { factor: string; winRate: number; sampleSize: number }[];
  optimalConfidenceMin: number;
  optimalInstruments: { type: string; winRate: number }[];
  regimeDescription: string;
}

export interface RegimeWeights {
  regime: string;
  weights: Record<string, number>; // factor -> weight (0-100)
  confidenceMultiplier: number;
  preferredDirection: "BUY_CE" | "BUY_PE" | "EITHER";
  maxPositions: number;
}

// ─── Regime Detection ────────────────────────────────────────────

export function detectRegime(trade: TradeRecord): string {
  const snap = trade.snapshot;
  if (!snap) return "UNKNOWN";

  const regime = snap.regime || "";
  const bias = snap.regimeBias || "";
  const vix = snap.vix || 0;
  const spotChange = snap.spotChangePct || 0;

  // Use existing regime if available and specific
  if (regime.includes("STRONG")) return regime;
  if (regime.includes("TREND")) return bias === "BULLISH" ? "UPTREND" : bias === "BEARISH" ? "DOWNTREND" : "TREND_UNKNOWN";
  if (regime.includes("RANGE")) return "RANGE_BOUND";
  if (regime.includes("VOLATIL")) return "HIGH_VOLATILITY";

  // Fallback: infer from data
  if (vix > 25) return "HIGH_VOLATILITY";
  if (Math.abs(spotChange) > 1) return spotChange > 0 ? "STRONG_UPTREND" : "STRONG_DOWNTREND";
  if (Math.abs(spotChange) > 0.3) return spotChange > 0 ? "UPTREND" : "DOWNTREND";
  return "RANGE_BOUND";
}

// ─── Regime Profile Analysis ─────────────────────────────────────

export function computeRegimeProfiles(): RegimeProfile[] {
  const trades = getResolvedTrades();
  if (trades.length < 20) return [];

  // Tag each trade with regime
  const taggedTrades = trades.map(t => ({ ...t, detectedRegime: detectRegime(t) }));
  const regimes = [...new Set(taggedTrades.map(t => t.detectedRegime))];

  return regimes.map(regime => {
    const regimeTrades = taggedTrades.filter(t => t.detectedRegime === regime);
    const wins = regimeTrades.filter(t => t.outcome === "WIN").length;
    const winRate = regimeTrades.length > 0 ? (wins / regimeTrades.length) * 100 : 0;
    const avgPnl = regimeTrades.length > 0
      ? regimeTrades.reduce((s, t) => s + (t.pnl || 0), 0) / regimeTrades.length : 0;
    const avgRMultiple = regimeTrades.length > 0
      ? regimeTrades.reduce((s, t) => s + (t.rMultiple || 0), 0) / regimeTrades.length : 0;

    // Analyze which factors work best in this regime
    const factorPerformance = analyzeFactorsInRegime(regimeTrades);
    const bestFactors = factorPerformance
      .filter(f => f.winRate > winRate + 5 && f.sampleSize >= 3)
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 5);
    const worstFactors = factorPerformance
      .filter(f => f.winRate < winRate - 5 && f.sampleSize >= 3)
      .sort((a, b) => a.winRate - b.winRate)
      .slice(0, 5);

    // Optimal confidence threshold for this regime
    const sorted = [...regimeTrades].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const topQuarter = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.25)));
    const optimalConfidenceMin = topQuarter.length > 0
      ? Math.min(...topQuarter.map(t => t.confidence || 0)) : 65;

    // Optimal instrument types
    const byType: Record<string, { wins: number; total: number }> = {};
    for (const t of regimeTrades) {
      const type = t.instrumentType || "EQ";
      if (!byType[type]) byType[type] = { wins: 0, total: 0 };
      byType[type].total++;
      if (t.outcome === "WIN") byType[type].wins++;
    }
    const optimalInstruments = Object.entries(byType)
      .map(([type, v]) => ({ type, winRate: v.total > 0 ? (v.wins / v.total) * 100 : 0 }))
      .sort((a, b) => b.winRate - a.winRate);

    const descriptions: Record<string, string> = {
      STRONG_UPTREND: "Strong bullish momentum — favor CE trades, momentum plays",
      UPTREND: "Moderate bullish bias — CE preferred, watch for continuation",
      DOWNTREND: "Moderate bearish bias — PE preferred, watch for continuation",
      STRONG_DOWNTREND: "Strong bearish momentum — favor PE trades, momentum plays",
      RANGE_BOUND: "No clear trend — mean reversion plays, sell premium, wider strikes",
      HIGH_VOLATILITY: "Elevated VIX — larger moves expected, wider stops, premium buying",
      UNKNOWN: "Unclear regime — reduce position size, wait for clarity",
    };

    return {
      regime,
      totalTrades: regimeTrades.length,
      winRate,
      avgPnl,
      avgRMultiple,
      bestFactors,
      worstFactors,
      optimalConfidenceMin,
      optimalInstruments,
      regimeDescription: descriptions[regime] || "No description available",
    };
  }).sort((a, b) => b.totalTrades - a.totalTrades);
}

function analyzeFactorsInRegime(trades: TradeRecord[]): { factor: string; winRate: number; sampleSize: number }[] {
  const results: { factor: string; winRate: number; sampleSize: number }[] = [];

  function check(name: string, test: (t: TradeRecord) => boolean | null) {
    const matches = trades.filter(t => test(t) === true);
    if (matches.length < 3) return;
    const wins = matches.filter(t => t.outcome === "WIN").length;
    results.push({ factor: name, winRate: (wins / matches.length) * 100, sampleSize: matches.length });
  }

  check("PCR_BULLISH", t => (t.snapshot?.pcr || 0) > 1.2);
  check("PCR_BEARISH", t => (t.snapshot?.pcr || 0) < 0.8);
  check("FII_BUYING", t => (t.snapshot?.fiiNet || 0) > 500);
  check("FII_SELLING", t => (t.snapshot?.fiiNet || 0) < -500);
  check("HIGH_VIX", t => (t.snapshot?.vix || 0) > 20);
  check("LOW_VIX", t => (t.snapshot?.vix || 0) < 12);
  check("CE_VOLUME_SPIKE", t => (t.snapshot?.strikeData?.ceVolume || 0) > 100000);
  check("PE_VOLUME_SPIKE", t => (t.snapshot?.strikeData?.peVolume || 0) > 100000);
  check("NEWS_BULLISH", t => (t.snapshot?.newsScore || 0) > 20);
  check("NEWS_BEARISH", t => (t.snapshot?.newsScore || 0) < -20);
  check("EXPIRY_DAY", t => t.snapshot?.isExpiryDay === true);
  check("ATM_TRADE", t => t.strike !== undefined && t.snapshot?.atmStrike !== undefined && t.strike === t.snapshot.atmStrike);
  check("STRONG_CONTANGO", t => (t.snapshot?.futuresBasis || 0) > 50);
  check("STRONG_BACKWARDATION", t => (t.snapshot?.futuresBasis || 0) < -50);
  check("FII_LONG_DOMINANT", t => { const p = t.snapshot?.participantOI; return p ? p.fiiLong > p.fiiShort * 1.2 : false; });
  check("CLIENT_SHORT_DOMINANT", t => { const p = t.snapshot?.participantOI; return p ? p.clientShort > p.clientLong * 1.2 : false; });

  return results.sort((a, b) => b.winRate - a.winRate);
}

// ─── Regime-Specific Weights ─────────────────────────────────────

export function getRegimeWeights(regime: string): RegimeWeights {
  const profiles = computeRegimeProfiles();
  const profile = profiles.find(p => p.regime === regime);

  const defaultWeights: RegimeWeights = {
    regime,
    weights: {
      "PCR": 15, "FII_DII": 15, "VIX": 10, "NEWS": 10,
      "VOLUME": 15, "GREEKS": 10, "REGIME": 10, "OI_MOMENTUM": 15,
    },
    confidenceMultiplier: 1.0,
    preferredDirection: "EITHER",
    maxPositions: 3,
  };

  if (!profile || profile.totalTrades < 5) return defaultWeights;

  // Adjust weights based on what works in this regime
  const weights = { ...defaultWeights.weights };

  // Boost factors that work well in this regime
  for (const f of profile.bestFactors) {
    if (f.factor.includes("PCR")) weights["PCR"] += 10;
    if (f.factor.includes("FII") || f.factor.includes("DII")) weights["FII_DII"] += 10;
    if (f.factor.includes("VIX")) weights["VIX"] += 10;
    if (f.factor.includes("NEWS")) weights["NEWS"] += 10;
    if (f.factor.includes("VOLUME")) weights["VOLUME"] += 10;
    if (f.factor.includes("CONTANGO") || f.factor.includes("BACKWARDATION")) weights["OI_MOMENTUM"] += 10;
  }

  // Reduce factors that don't work in this regime
  for (const f of profile.worstFactors) {
    if (f.factor.includes("PCR")) weights["PCR"] -= 5;
    if (f.factor.includes("FII") || f.factor.includes("DII")) weights["FII_DII"] -= 5;
    if (f.factor.includes("VIX")) weights["VIX"] -= 5;
  }

  // Normalize weights to sum to 100
  const total = Object.values(weights).reduce((a, b) => a + Math.max(0, b), 0);
  for (const k of Object.keys(weights)) {
    weights[k] = Math.max(0, Math.round((weights[k] / total) * 100));
  }

  // Confidence multiplier based on regime win rate
  const confidenceMultiplier = profile.winRate > 60 ? 1.1 : profile.winRate < 40 ? 0.85 : 1.0;

  // Preferred direction based on best instruments
  let preferredDirection: "BUY_CE" | "BUY_PE" | "EITHER" = "EITHER";
  if (profile.optimalInstruments.length > 0) {
    const best = profile.optimalInstruments[0];
    if (best.type === "CE" && best.winRate > 55) preferredDirection = "BUY_CE";
    else if (best.type === "PE" && best.winRate > 55) preferredDirection = "BUY_PE";
  }

  // Max positions based on regime confidence
  const maxPositions = profile.winRate > 60 ? 4 : profile.winRate > 50 ? 3 : 2;

  return {
    regime,
    weights,
    confidenceMultiplier,
    preferredDirection,
    maxPositions,
  };
}

// ─── Real-Time Regime Adaptation ─────────────────────────────────

export function adaptScoreForRegime(
  rawScore: number,
  regime: string,
  factors: Record<string, number>
): { adjustedScore: number; adjustments: string[] } {
  const regimeWeights = getRegimeWeights(regime);
  const adjustments: string[] = [];
  let adjustment = 0;

  // Apply regime confidence multiplier
  if (regimeWeights.confidenceMultiplier !== 1.0) {
    const mult = regimeWeights.confidenceMultiplier;
    adjustment += (rawScore * mult - rawScore);
    adjustments.push(`Regime ${regime}: confidence x${mult}`);
  }

  // Apply factor-specific adjustments
  for (const [factor, value] of Object.entries(factors)) {
    const weight = regimeWeights.weights[factor] || 0;
    if (weight > 20) {
      adjustment += value * 0.1; // Boost high-weight factors
      adjustments.push(`${factor}: +${(value * 0.1).toFixed(1)} (weight: ${weight})`);
    }
  }

  const adjustedScore = Math.max(0, Math.min(100, rawScore + adjustment));
  return { adjustedScore, adjustments };
}
