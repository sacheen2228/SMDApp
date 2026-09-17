// Confidence Calibrator — maps confidence scores to actual win rates
// Answers: "If the system says 80% confidence, does it actually win 80%?"

import { getResolvedTrades, type CalibrationBucket, type TradeRecord } from "./trade-trainer";

export interface CalibrationResult {
  buckets: CalibrationBucket[];
  overallCalibrationError: number; // avg |predicted - actual|
  reliabilityDiagram: { predicted: number; actual: number; count: number }[];
  recommendation: string;
}

export function calibrateConfidence(): CalibrationResult {
  const trades = getResolvedTrades();
  if (trades.length < 20) {
    return {
      buckets: [],
      overallCalibrationError: 0,
      reliabilityDiagram: [],
      recommendation: `Need more trades (have ${trades.length}, need 20+) for reliable calibration`,
    };
  }

  const ranges = [
    { label: "0-20%", min: 0, max: 20 },
    { label: "20-40%", min: 20, max: 40 },
    { label: "40-50%", min: 40, max: 50 },
    { label: "50-60%", min: 50, max: 60 },
    { label: "60-70%", min: 60, max: 70 },
    { label: "70-80%", min: 70, max: 80 },
    { label: "80-90%", min: 80, max: 90 },
    { label: "90-100%", min: 90, max: 100 },
  ];

  const buckets: CalibrationBucket[] = ranges.map(r => {
    const inBucket = trades.filter(t => t.confidence >= r.min && t.confidence < r.max);
    const wins = inBucket.filter(t => t.outcome === "WIN").length;
    const losses = inBucket.filter(t => t.outcome === "LOSS").length;
    const total = inBucket.length;
    const pnls = inBucket.map(t => t.pnl || 0);
    const rMults = inBucket.map(t => t.rMultiple || 0);

    return {
      range: r.label,
      minScore: r.min,
      maxScore: r.max,
      totalTrades: total,
      wins,
      losses,
      winRate: total > 0 ? (wins / total) * 100 : 0,
      avgPnl: total > 0 ? pnls.reduce((a, b) => a + b, 0) / total : 0,
      avgRMultiple: total > 0 ? rMults.reduce((a, b) => a + b, 0) / total : 0,
    };
  });

  // Reliability diagram (predicted vs actual)
  const reliabilityDiagram = buckets
    .filter(b => b.totalTrades >= 3)
    .map(b => ({
      predicted: (b.minScore + b.maxScore) / 2,
      actual: b.winRate,
      count: b.totalTrades,
    }));

  // Calibration error (ECE - Expected Calibration Error)
  const totalTrades = trades.length;
  let ece = 0;
  for (const b of buckets) {
    if (b.totalTrades === 0) continue;
    const predicted = (b.minScore + b.maxScore) / 2;
    const actual = b.winRate;
    ece += (b.totalTrades / totalTrades) * Math.abs(predicted - actual);
  }

  // Generate recommendation
  let recommendation = "";
  const highConfBuckets = buckets.filter(b => b.minScore >= 70 && b.totalTrades >= 3);
  const avgHighConfWR = highConfBuckets.length > 0
    ? highConfBuckets.reduce((s, b) => s + b.winRate, 0) / highConfBuckets.length
    : 0;

  if (ece > 20) {
    recommendation = `HIGH calibration error (${ece.toFixed(1)}%). Confidence scores are NOT reliable. Consider lowering all confidence thresholds by 15-20 points.`;
  } else if (ece > 10) {
    recommendation = `MODERATE calibration error (${ece.toFixed(1)}%). Confidence scores are somewhat reliable. High-confidence trades (${avgHighConfWR.toFixed(0)}% actual WR) are acceptable.`;
  } else {
    recommendation = `LOW calibration error (${ece.toFixed(1)}%). Confidence scores are reliable. High-confidence trades win ${avgHighConfWR.toFixed(0)}% of the time.`;
  }

  return {
    buckets,
    overallCalibrationError: ece,
    reliabilityDiagram,
    recommendation,
  };
}

// ─── Dynamic Confidence Adjustment ───────────────────────────────
// Adjusts raw confidence based on calibration data

export function adjustConfidence(rawConfidence: number, regime?: string): number {
  const { buckets } = calibrateConfidence();
  if (buckets.length === 0) return rawConfidence;

  // Find the bucket for this confidence level
  const bucket = buckets.find(b => rawConfidence >= b.minScore && rawConfidence < b.maxScore);
  if (!bucket || bucket.totalTrades < 5) return rawConfidence;

  // If actual win rate is lower than predicted, reduce confidence
  const predicted = (bucket.minScore + bucket.maxScore) / 2;
  const actual = bucket.winRate;
  const adjustment = actual - predicted;

  // Apply adjustment with dampening (don't swing too wildly)
  const dampened = adjustment * 0.5; // 50% dampening
  const adjusted = Math.max(0, Math.min(100, rawConfidence + dampened));

  return Math.round(adjusted);
}

// ─── Minimum Confidence Threshold ────────────────────────────────
// Based on calibration, what's the minimum confidence for profitable trading?

export function getOptimalConfidenceThreshold(): {
  minForProfit: number;
  minForHighWinRate: number;
  sweetSpot: { min: number; max: number; expectedWR: number };
} {
  const { buckets } = calibrateConfidence();
  if (buckets.length === 0) {
    return { minForProfit: 65, minForHighWinRate: 80, sweetSpot: { min: 70, max: 90, expectedWR: 65 } };
  }

  // Find minimum confidence where avg PnL > 0
  let minForProfit = 65;
  for (const b of buckets) {
    if (b.avgPnl > 0 && b.totalTrades >= 3) {
      minForProfit = b.minScore;
      break;
    }
  }

  // Find minimum confidence where win rate > 60%
  let minForHighWinRate = 80;
  for (const b of buckets) {
    if (b.winRate > 60 && b.totalTrades >= 3) {
      minForHighWinRate = b.minScore;
      break;
    }
  }

  // Sweet spot: highest R-multiple with decent sample size
  let bestBucket = buckets[0];
  for (const b of buckets) {
    if (b.totalTrades >= 5 && b.avgRMultiple > (bestBucket?.avgRMultiple || 0)) {
      bestBucket = b;
    }
  }

  return {
    minForProfit,
    minForHighWinRate,
    sweetSpot: {
      min: bestBucket?.minScore || 70,
      max: bestBucket?.maxScore || 90,
      expectedWR: bestBucket?.winRate || 65,
    },
  };
}
