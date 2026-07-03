// Self-Learning Advisory Module
// Post-trade analysis and weight suggestions — advisory only, never auto-applied

import type {
  TradeRecord,
  TradeAnalysis,
  WeightSuggestion,
  FactorPerformance,
} from "@/types/sdm";

// ─── Constants ──────────────────────────────────────────────────

const ROLLING_WINDOW = 50;
const MIN_SAMPLE_SIZE = 10;
const CONFIDENCE_HIGH = 30;
const CONFIDENCE_MEDIUM = 15;
const FALSE_POSITIVE_THRESHOLD = 0.6;
const TRUE_POSITIVE_THRESHOLD = 0.8;
const MIN_WEIGHT = 0.02;
const MAX_WEIGHT = 0.30;
const WEIGHT_STEP = 0.01;

const ALL_FACTORS = [
  "Trend",
  "Market Structure",
  "Volume",
  "OI",
  "OI Change",
  "Greeks",
  "VWAP",
  "Liquidity",
  "Gamma Exposure",
  "Dealer Positioning",
  "Volatility",
  "Risk:Reward",
  "Time of Day",
  "Spread",
];

// Reason keyword → directional implication mapping
// Used to determine if a reason string implied a specific direction
const DIRECTIONAL_KEYWORDS: Record<string, "CALL" | "PUT"> = {
  // Bullish / CALL signals
  uptrend: "CALL",
  bullish: "CALL",
  "long buildup": "CALL",
  "put writing": "CALL",
  "put short covering": "CALL",
  "above vwap": "CALL",
  "above poc": "CALL",
  "positive delta": "CALL",
  "buy absorption": "CALL",
  bos_bullish: "CALL",
  support: "CALL",
  "dealer long gamma": "CALL",
  "dealer bullish": "CALL",
  // Bearish / PUT signals
  downtrend: "PUT",
  bearish: "PUT",
  "short buildup": "PUT",
  "call writing": "PUT",
  "call long unwinding": "PUT",
  "below vwap": "PUT",
  "below poc": "PUT",
  "negative delta": "PUT",
  "sell absorption": "PUT",
  bos_bearish: "PUT",
  resistance: "PUT",
  "dealer short gamma": "PUT",
  "dealer bearish": "PUT",
};

// ─── Helpers ──────────────────────────────────────────────────────

function isWinning(trade: TradeRecord): boolean {
  return trade.status === "tp_hit" && trade.pnl > 0;
}

function isClosed(trade: TradeRecord): boolean {
  return (
    trade.status === "tp_hit" ||
    trade.status === "sl_hit" ||
    trade.status === "expired" ||
    trade.status === "partial_exit"
  );
}

function parseReasons(trade: TradeRecord): string[] {
  const raw = trade.reason;
  if (!raw) return [];

  // Try JSON parse — the reason field may be a JSON array string
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((r): r is string => typeof r === "string");
    }
    if (typeof parsed === "string") {
      return [parsed];
    }
  } catch {
    // Not JSON — treat as comma-separated or single string
  }

  // Fallback: split by newline or semicolon
  return raw
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function inferDirectionFromReason(reason: string): "CALL" | "PUT" | null {
  const lower = reason.toLowerCase();
  for (const [keyword, dir] of Object.entries(DIRECTIONAL_KEYWORDS)) {
    if (lower.includes(keyword)) return dir;
  }
  return null;
}

function reasonWasValid(
  reason: string,
  tradeDirection: TradeRecord["direction"],
  pnl: number
): boolean {
  const impliedDir = inferDirectionFromReason(reason);
  if (!impliedDir) return true; // neutral reasons are not penalized

  // For buys: aligned = impliedDir matches trade direction
  // For sells: aligned = impliedDir opposes trade direction (e.g. bearish reason + SELL_CALL = aligned)
  const isSellCall = tradeDirection === "SELL_CALL";
  const isSellPut = tradeDirection === "SELL_PUT";
  const isBuyCall = tradeDirection === "CALL";
  const isBuyPut = tradeDirection === "PUT";

  const aligned =
    (isBuyCall && impliedDir === "CALL") ||
    (isBuyPut && impliedDir === "PUT") ||
    (isSellCall && impliedDir === "PUT") ||
    (isSellPut && impliedDir === "CALL");

  // Aligned reason + profit = valid; aligned + loss = invalid
  // Opposed reason + loss = valid (reason correctly opposed trade); opposed + profit = invalid
  if (aligned) return pnl > 0;
  return pnl <= 0;
}

function estimateMFE(
  trade: TradeRecord,
  currentLTP?: number
): number {
  // Estimate max favorable excursion from exit price relative to entry
  if (trade.pnl === 0) return 0;
  const exitProxy = trade.exitReason ? trade.entry + trade.pnl / 65 : trade.entry;
  const excursion = Math.abs(exitProxy - trade.entry);
  return trade.entry > 0 ? (excursion / trade.entry) * 100 : 0;
}

function estimateMAE(
  trade: TradeRecord
): number {
  // If SL was hit, MAE ≈ |entry - SL|. Otherwise estimate from grade.
  if (trade.status === "sl_hit") {
    const slDist = Math.abs(trade.entry - trade.sl);
    return trade.entry > 0 ? (slDist / trade.entry) * 100 : 0;
  }
  // Rough estimate based on grade
  if (trade.grade === "D") return 1.5;
  if (trade.grade === "C") return 1.0;
  if (trade.grade === "B") return 0.7;
  return 0.4;
}

function getConfidence(sampleSize: number): "HIGH" | "MEDIUM" | "LOW" {
  if (sampleSize > CONFIDENCE_HIGH) return "HIGH";
  if (sampleSize > CONFIDENCE_MEDIUM) return "MEDIUM";
  return "LOW";
}

// ─── Core Functions ──────────────────────────────────────────────

export function analyzeCompletedTrade(trade: TradeRecord): TradeAnalysis {
  const reasons = parseReasons(trade);
  const tradePnl = trade.pnl;

  const validReasons: string[] = [];
  const failedReasons: string[] = [];

  for (const reason of reasons) {
    if (reasonWasValid(reason, trade.direction, tradePnl)) {
      validReasons.push(reason);
    } else {
      failedReasons.push(reason);
    }
  }

  const outcome = isWinning(trade) ? "WIN" : "LOSS";
  const holdingTime = trade.holdingTime ?? 0;

  // Entry timing: did trade go against first?
  // Heuristic: SL hit without TP → entered against momentum (LATE)
  // TP hit directly → entered with momentum (OPTIMAL)
  // Partial exit then SL → entered slightly early (EARLY)
  let entryTiming: "EARLY" | "OPTIMAL" | "LATE";
  if (trade.status === "sl_hit") {
    entryTiming = "LATE";
  } else if (
    trade.status === "tp_hit" &&
    trade.partialExits.length === 0
  ) {
    entryTiming = "OPTIMAL";
  } else if (trade.status === "partial_exit") {
    entryTiming = "EARLY";
  } else if (trade.status === "expired") {
    entryTiming = "LATE";
  } else {
    entryTiming = "OPTIMAL";
  }

  // Exit quality: BOOK_FULL at best = OPTIMAL; gave back >50% max gain = POOR
  let exitQuality: "GOOD" | "POOR" | "OPTIMAL";
  const mfe = estimateMFE(trade);

  if (trade.status === "tp_hit" && trade.partialExits.length > 0) {
    // Partial exits indicate managed exit
    const bestExitPrice = Math.max(
      ...trade.partialExits.map((e) => e.price),
      trade.entry
    );
    const excursionFromBest =
      ((bestExitPrice - trade.entry) / trade.entry) * 100;
    const gaveBackPercent =
      excursionFromBest > 0
        ? ((excursionFromBest - Math.abs(tradePnl / 65 / trade.entry) * 100) /
            excursionFromBest) *
          100
        : 0;

    if (gaveBackPercent <= 20) {
      exitQuality = "OPTIMAL";
    } else if (gaveBackPercent <= 50) {
      exitQuality = "GOOD";
    } else {
      exitQuality = "POOR";
    }
  } else if (trade.status === "sl_hit") {
    exitQuality = "POOR";
  } else if (trade.status === "expired") {
    exitQuality = "POOR";
  } else {
    exitQuality = "GOOD";
  }

  return {
    tradeId: trade.id,
    outcome,
    validReasons,
    failedReasons,
    entryTiming,
    exitQuality,
    holdingTimeMinutes: holdingTime,
    maxFavorableExcursion: mfe,
    maxAdverseExcursion: estimateMAE(trade),
  };
}

export function generateWeightSuggestions(
  trades: TradeRecord[]
): WeightSuggestion[] {
  const closed = trades.filter(isClosed);
  const window = closed.slice(-ROLLING_WINDOW);

  if (window.length < MIN_SAMPLE_SIZE) return [];

  const suggestions: WeightSuggestion[] = [];

  // Track per-factor: present in wins, present in losses
  const factorStats: Record<
    string,
    { presentInWins: number; presentInLosses: number; totalWins: number; totalLosses: number }
  > = {};

  for (const f of ALL_FACTORS) {
    factorStats[f] = { presentInWins: 0, presentInLosses: 0, totalWins: 0, totalLosses: 0 };
  }

  for (const trade of window) {
    const reasons = parseReasons(trade);
    const reasonsLower = reasons.map((r) => r.toLowerCase());
    const win = isWinning(trade);

    for (const f of ALL_FACTORS) {
      const factorLower = f.toLowerCase();
      const present = reasonsLower.some((r) => r.includes(factorLower));

      if (win) {
        factorStats[f].totalWins++;
        if (present) factorStats[f].presentInWins++;
      } else {
        factorStats[f].totalLosses++;
        if (present) factorStats[f].presentInLosses++;
      }
    }
  }

  for (const f of ALL_FACTORS) {
    const stats = factorStats[f];
    const totalPresent = stats.presentInWins + stats.presentInLosses;

    if (totalPresent < MIN_SAMPLE_SIZE) continue;

    const falsePositiveRate =
      stats.presentInLosses / (stats.presentInWins + stats.presentInLosses || 1);
    const truePositiveRate =
      stats.presentInWins / (stats.totalWins || 1);

    // Current weight from the quality score engine (static defaults)
    const currentWeight = getStaticWeight(f);
    let suggestedWeight = currentWeight;
    let rationale = "";
    let needsChange = false;

    if (falsePositiveRate > FALSE_POSITIVE_THRESHOLD) {
      // Factor appears too often in losing trades — reduce weight
      suggestedWeight = Math.max(MIN_WEIGHT, currentWeight - WEIGHT_STEP * 2);
      rationale = `${f} present in ${(falsePositiveRate * 100).toFixed(0)}% of losing trades — reducing weight`;
      needsChange = suggestedWeight !== currentWeight;
    } else if (truePositiveRate > TRUE_POSITIVE_THRESHOLD) {
      // Factor appears reliably in winning trades — increase weight
      suggestedWeight = Math.min(MAX_WEIGHT, currentWeight + WEIGHT_STEP);
      rationale = `${f} present in ${(truePositiveRate * 100).toFixed(0)}% of winning trades — increasing weight`;
      needsChange = suggestedWeight !== currentWeight;
    }

    if (needsChange) {
      suggestions.push({
        factorName: f,
        currentWeight,
        suggestedWeight: Math.round(suggestedWeight * 100) / 100,
        rationale,
        sampleSize: totalPresent,
        confidence: getConfidence(totalPresent),
      });
    }
  }

  return suggestions;
}

export function getFactorPerformance(trades: TradeRecord[]): FactorPerformance[] {
  const closed = trades.filter(isClosed);
  const window = closed.slice(-ROLLING_WINDOW);

  const performance: FactorPerformance[] = [];

  for (const f of ALL_FACTORS) {
    let timesPresent = 0;
    let winsWhenPresent = 0;
    let lossesWhenPresent = 0;

    for (const trade of window) {
      const reasons = parseReasons(trade);
      const reasonsLower = reasons.map((r) => r.toLowerCase());
      const factorLower = f.toLowerCase();
      const present = reasonsLower.some((r) => r.includes(factorLower));

      if (present) {
        timesPresent++;
        if (isWinning(trade)) {
          winsWhenPresent++;
        } else {
          lossesWhenPresent++;
        }
      }
    }

    const winRateWhenPresent =
      timesPresent > 0 ? (winsWhenPresent / timesPresent) * 100 : 0;
    const falsePositiveRate =
      timesPresent > 0 ? (lossesWhenPresent / timesPresent) * 100 : 0;
    const truePositiveRate = winRateWhenPresent;

    performance.push({
      factorName: f,
      timesPresent,
      winRateWhenPresent: Math.round(winRateWhenPresent * 10) / 10,
      falsePositiveRate: Math.round(falsePositiveRate * 10) / 10,
      truePositiveRate: Math.round(truePositiveRate * 10) / 10,
    });
  }

  return performance;
}

// ─── Static Weight Lookup ────────────────────────────────────────
// Mirrors the default weights in sdm-scores.ts

function getStaticWeight(factorName: string): number {
  const weightMap: Record<string, number> = {
    Trend: 0.15,
    "Market Structure": 0.15,
    Volume: 0.10,
    OI: 0.10,
    "OI Change": 0.05,
    Greeks: 0.10,
    VWAP: 0.10,
    Liquidity: 0.05,
    "Gamma Exposure": 0.05,
    "Dealer Positioning": 0.05,
    Volatility: 0.05,
    "Risk:Reward": 0.05,
    "Time of Day": 0.05,
    Spread: 0.05,
  };
  return weightMap[factorName] ?? 0.05;
}
