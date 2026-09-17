// Factor Analyzer — discovers which OI/Greek/Volume/Institutional combos predict wins
// Uses correlation analysis on resolved trades

import { getResolvedTrades, type TradeRecord, type TrainingInsight } from "./trade-trainer";

export interface FactorCombination {
  factors: string[];
  winRate: number;
  avgPnl: number;
  avgRMultiple: number;
  sampleSize: number;
  confidence: number;
}

export interface FactorCorrelation {
  factor1: string;
  factor2: string;
  correlation: number; // -1 to 1
  combinedWinRate: number;
  sampleSize: number;
}

// ─── Individual Factor Analysis ──────────────────────────────────

export function analyzeAllFactors(): TrainingInsight[] {
  const trades = getResolvedTrades();
  if (trades.length < 10) return [];

  const insights: TrainingInsight[] = [];

  function analyze(
    name: string,
    condition: (t: TradeRecord) => boolean | null
  ): void {
    const matches = trades.filter(t => condition(t) === true);
    const nonMatches = trades.filter(t => condition(t) === false);
    if (matches.length < 3 || nonMatches.length < 3) return;

    const wrMatch = matches.filter(t => t.outcome === "WIN").length / matches.length;
    const wrNonMatch = nonMatches.filter(t => t.outcome === "WIN").length / nonMatches.length;
    const pnlMatch = matches.reduce((s, t) => s + (t.pnl || 0), 0) / matches.length;
    const diff = wrMatch - wrNonMatch;

    insights.push({
      factor: name,
      winRate: wrMatch * 100,
      avgPnl: pnlMatch,
      sampleSize: matches.length,
      confidence: Math.min(1, matches.length / 20),
      direction: diff > 0.05 ? "POSITIVE" : diff < -0.05 ? "NEGATIVE" : "NEUTRAL",
    });
  }

  // === OI FACTORS ===
  analyze("PCR_BULLISH", t => (t.snapshot?.pcr || 0) > 1.2);
  analyze("PCR_BEARISH", t => (t.snapshot?.pcr || 0) < 0.8);
  analyze("PCR_NEUTRAL", t => { const p = t.snapshot?.pcr || 0; return p >= 0.8 && p <= 1.2; });

  analyze("CALL_OI_BUILDUP", t => (t.snapshot?.callOiChange || 0) > 50000);
  analyze("PUT_OI_BUILDUP", t => (t.snapshot?.putOiChange || 0) > 50000);
  analyze("CALL_OI_UNWINDING", t => (t.snapshot?.callOiChange || 0) < -50000);
  analyze("PUT_OI_UNWINDING", t => (t.snapshot?.putOiChange || 0) < -50000);

  // === GREEK FACTORS ===
  analyze("HIGH_CE_IV", t => (t.snapshot?.strikeData?.ceIV || 0) > 25);
  analyze("HIGH_PE_IV", t => (t.snapshot?.strikeData?.peIV || 0) > 25);
  analyze("LOW_CE_IV", t => { const iv = t.snapshot?.strikeData?.ceIV; return iv !== undefined && iv > 0 && iv < 15; });
  analyze("LOW_PE_IV", t => { const iv = t.snapshot?.strikeData?.peIV; return iv !== undefined && iv > 0 && iv < 15; });
  analyze("HIGH_CE_DELTA", t => (t.snapshot?.strikeData?.ceDelta || 0) > 0.5);
  analyze("HIGH_PE_DELTA", t => (t.snapshot?.strikeData?.peDelta || 0) > 0.5);
  analyze("HIGH_GAMMA", t => ((t.snapshot?.strikeData?.ceGamma || 0) + (t.snapshot?.strikeData?.peGamma || 0)) > 0.01);

  // === VOLUME FACTORS ===
  analyze("CE_VOLUME_SPIKE", t => (t.snapshot?.strikeData?.ceVolume || 0) > 100000);
  analyze("PE_VOLUME_SPIKE", t => (t.snapshot?.strikeData?.peVolume || 0) > 100000);
  analyze("CE_VOLUME_DRY", t => { const v = t.snapshot?.strikeData?.ceVolume; return v !== undefined && v < 5000; });
  analyze("PE_VOLUME_DRY", t => { const v = t.snapshot?.strikeData?.peVolume; return v !== undefined && v < 5000; });

  // === VIX FACTORS ===
  analyze("VIX_VERY_HIGH", t => (t.snapshot?.vix || 0) > 25);
  analyze("VIX_HIGH", t => { const v = t.snapshot?.vix || 0; return v > 18 && v <= 25; });
  analyze("VIX_LOW", t => (t.snapshot?.vix || 0) < 12);
  analyze("VIX_NORMAL", t => { const v = t.snapshot?.vix || 0; return v >= 12 && v <= 18; });

  // === FUTURES FACTORS ===
  analyze("STRONG_CONTANGO", t => (t.snapshot?.futuresBasis || 0) > 50);
  analyze("STRONG_BACKWARDATION", t => (t.snapshot?.futuresBasis || 0) < -50);
  analyze("FAIR_VALUE", t => Math.abs(t.snapshot?.futuresBasis || 0) < 20);

  // === INSTITUTIONAL FACTORS ===
  analyze("FII_STRONG_BUYING", t => (t.snapshot?.fiiNet || 0) > 1000);
  analyze("FII_BUYING", t => { const f = t.snapshot?.fiiNet || 0; return f > 200 && f <= 1000; });
  analyze("FII_STRONG_SELLING", t => (t.snapshot?.fiiNet || 0) < -1000);
  analyze("FII_SELLING", t => { const f = t.snapshot?.fiiNet || 0; return f < -200 && f >= -1000; });
  analyze("DII_BUYING", t => (t.snapshot?.diiNet || 0) > 500);
  analyze("DII_SELLING", t => (t.snapshot?.diiNet || 0) < -500);

  analyze("FII_LONG_DOMINANT", t => {
    const poi = t.snapshot?.participantOI;
    return poi ? poi.fiiLong > poi.fiiShort * 1.2 : null;
  });
  analyze("FII_SHORT_DOMINANT", t => {
    const poi = t.snapshot?.participantOI;
    return poi ? poi.fiiShort > poi.fiiLong * 1.2 : null;
  });
  analyze("CLIENT_LONG_DOMINANT", t => {
    const poi = t.snapshot?.participantOI;
    return poi ? poi.clientLong > poi.clientShort * 1.2 : null;
  });
  analyze("CLIENT_SHORT_DOMINANT", t => {
    const poi = t.snapshot?.participantOI;
    return poi ? poi.clientShort > poi.clientLong * 1.2 : null;
  });

  // === REGIME FACTORS ===
  analyze("REGIME_STRONG_UPTREND", t => (t.snapshot?.regime || "").includes("STRONG") && (t.snapshot?.regimeBias || "") === "BULLISH");
  analyze("REGIME_UPTREND", t => (t.snapshot?.regimeBias || "") === "BULLISH");
  analyze("REGIME_DOWNTREND", t => (t.snapshot?.regimeBias || "") === "BEARISH");
  analyze("REGIME_RANGE_BOUND", t => (t.snapshot?.regime || "").includes("RANGE"));
  analyze("REGIME_HIGH_VOLATILITY", t => (t.snapshot?.regime || "").includes("VOLATIL"));

  // === NEWS FACTORS ===
  analyze("NEWS_STRONG_BULLISH", t => (t.snapshot?.newsScore || 0) > 50);
  analyze("NEWS_BULLISH", t => { const s = t.snapshot?.newsScore || 0; return s > 20 && s <= 50; });
  analyze("NEWS_STRONG_BEARISH", t => (t.snapshot?.newsScore || 0) < -50);
  analyze("NEWS_BEARISH", t => { const s = t.snapshot?.newsScore || 0; return s < -20 && s >= -50; });
  analyze("NEWS_NEUTRAL", t => Math.abs(t.snapshot?.newsScore || 0) <= 20);

  // === SPOT PRICE FACTORS ===
  analyze("SPOT_STRONG_UP", t => (t.snapshot?.spotChangePct || 0) > 0.5);
  analyze("SPOT_UP", t => { const c = t.snapshot?.spotChangePct || 0; return c > 0.1 && c <= 0.5; });
  analyze("SPOT_STRONG_DOWN", t => (t.snapshot?.spotChangePct || 0) < -0.5);
  analyze("SPOT_DOWN", t => { const c = t.snapshot?.spotChangePct || 0; return c < -0.1 && c >= -0.5; });
  analyze("SPOT_FLAT", t => Math.abs(t.snapshot?.spotChangePct || 0) <= 0.1);

  // === PROXIMITY FACTORS ===
  analyze("NEAR_MAX_PAIN", t => {
    if (!t.snapshot?.maxPain || !t.snapshot?.spot) return null;
    return Math.abs(t.snapshot.maxPain - t.snapshot.spot) / t.snapshot.spot < 0.005;
  });
  analyze("ATM_TRADE", t => t.strike !== undefined && t.snapshot?.atmStrike !== undefined && t.strike === t.snapshot.atmStrike);

  // === TIME FACTORS ===
  analyze("FIRST_HOUR", t => {
    const time = t.snapshot?.sessionTime || "";
    const match = time.match(/^(\d+):/);
    return match ? parseInt(match[1]) === 9 : null;
  });
  analyze("MORNING_SESSION", t => {
    const time = t.snapshot?.sessionTime || "";
    const match = time.match(/^(\d+):/);
    return match ? parseInt(match[1]) >= 9 && parseInt(match[1]) <= 11 : null;
  });
  analyze("AFTERNOON_SESSION", t => {
    const time = t.snapshot?.sessionTime || "";
    const match = time.match(/^(\d+):/);
    return match ? parseInt(match[1]) >= 12 && parseInt(match[1]) <= 14 : null;
  });

  // === EXPIRY FACTORS ===
  analyze("EXPIRY_DAY", t => t.snapshot?.isExpiryDay === true);
  analyze("NEAR_EXPIRY", t => (t.snapshot?.daysToExpiry || 99) <= 2);
  analyze("WEEKLY_EXPIRY", t => (t.snapshot?.daysToExpiry || 99) <= 7);

  // Sort by win rate
  insights.sort((a, b) => b.winRate - a.winRate);
  return insights;
}

// ─── Factor Combination Analysis ─────────────────────────────────

export function findBestCombinations(maxFactors: number = 3): FactorCombination[] {
  const trades = getResolvedTrades();
  if (trades.length < 30) return [];

  const allFactors = analyzeAllFactors()
    .filter(f => f.sampleSize >= 5 && f.direction !== "NEUTRAL")
    .slice(0, 20); // Top 20 factors

  const factorDefs: { name: string; test: (t: TradeRecord) => boolean }[] = [
    { name: "PCR_BULLISH", test: t => (t.snapshot?.pcr || 0) > 1.2 },
    { name: "PCR_BEARISH", test: t => (t.snapshot?.pcr || 0) < 0.8 },
    { name: "HIGH_VIX", test: t => (t.snapshot?.vix || 0) > 20 },
    { name: "LOW_VIX", test: t => (t.snapshot?.vix || 0) < 12 },
    { name: "FII_BUYING", test: t => (t.snapshot?.fiiNet || 0) > 500 },
    { name: "FII_SELLING", test: t => (t.snapshot?.fiiNet || 0) < -500 },
    { name: "DII_BUYING", test: t => (t.snapshot?.diiNet || 0) > 500 },
    { name: "CE_VOLUME_SPIKE", test: t => (t.snapshot?.strikeData?.ceVolume || 0) > 100000 },
    { name: "PE_VOLUME_SPIKE", test: t => (t.snapshot?.strikeData?.peVolume || 0) > 100000 },
    { name: "NEWS_BULLISH", test: t => (t.snapshot?.newsScore || 0) > 20 },
    { name: "NEWS_BEARISH", test: t => (t.snapshot?.newsScore || 0) < -20 },
    { name: "STRONG_CONTANGO", test: t => (t.snapshot?.futuresBasis || 0) > 50 },
    { name: "STRONG_BACKWARDATION", test: t => (t.snapshot?.futuresBasis || 0) < -50 },
    { name: "REGIME_UPTREND", test: t => (t.snapshot?.regimeBias || "") === "BULLISH" },
    { name: "REGIME_DOWNTREND", test: t => (t.snapshot?.regimeBias || "") === "BEARISH" },
    { name: "EXPIRY_DAY", test: t => t.snapshot?.isExpiryDay === true },
    { name: "ATM_TRADE", test: t => t.strike !== undefined && t.snapshot?.atmStrike !== undefined && t.strike === t.snapshot.atmStrike },
    { name: "HIGH_CONFIDENCE", test: t => (t.confidence || 0) > 80 },
    { name: "FII_LONG_DOMINANT", test: t => { const p = t.snapshot?.participantOI; return p ? p.fiiLong > p.fiiShort * 1.2 : false; } },
    { name: "CLIENT_SHORT_DOMINANT", test: t => { const p = t.snapshot?.participantOI; return p ? p.clientShort > p.clientLong * 1.2 : false; } },
  ];

  const relevantFactors = factorDefs.filter(f => allFactors.some(af => af.factor === f.name));
  const combinations: FactorCombination[] = [];

  // Generate all 2-factor and 3-factor combinations
  for (let size = 2; size <= Math.min(maxFactors, relevantFactors.length); size++) {
    for (let i = 0; i < relevantFactors.length; i++) {
      for (let j = i + 1; j < relevantFactors.length; j++) {
        if (size === 2) {
          const factors = [relevantFactors[i], relevantFactors[j]];
          const matching = trades.filter(t => factors.every(f => f.test(t)));
          if (matching.length < 5) continue;
          const wins = matching.filter(t => t.outcome === "WIN").length;
          combinations.push({
            factors: factors.map(f => f.name),
            winRate: (wins / matching.length) * 100,
            avgPnl: matching.reduce((s, t) => s + (t.pnl || 0), 0) / matching.length,
            avgRMultiple: matching.reduce((s, t) => s + (t.rMultiple || 0), 0) / matching.length,
            sampleSize: matching.length,
            confidence: Math.min(1, matching.length / 15),
          });
        }
        for (let k = j + 1; k < relevantFactors.length; k++) {
          if (size === 3) {
            const factors = [relevantFactors[i], relevantFactors[j], relevantFactors[k]];
            const matching = trades.filter(t => factors.every(f => f.test(t)));
            if (matching.length < 3) continue;
            const wins = matching.filter(t => t.outcome === "WIN").length;
            combinations.push({
              factors: factors.map(f => f.name),
              winRate: (wins / matching.length) * 100,
              avgPnl: matching.reduce((s, t) => s + (t.pnl || 0), 0) / matching.length,
              avgRMultiple: matching.reduce((s, t) => s + (t.rMultiple || 0), 0) / matching.length,
              sampleSize: matching.length,
              confidence: Math.min(1, matching.length / 10),
            });
          }
        }
      }
    }
  }

  return combinations
    .filter(c => c.sampleSize >= 5)
    .sort((a, b) => b.winRate - a.winRate || b.sampleSize - a.sampleSize)
    .slice(0, 20);
}
