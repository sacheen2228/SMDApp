/// <reference types="bun-types" />
// TDD for the Institutional Positioning "smart money bias" read.
//
// THE BUG THIS LOCKS DOWN: the card said
//   "Smart money bias: neutral · 0% bull / 20% bear"
// while the same card's narrative said "FIIs increased Index Futures Long by
// 26%, aggressively. PRO desks accumulated Calls (+1.5L contracts)".
//
// Two causes:
//   1. computeStrengthScore() labelled a score of 58 "Mild Bullish" but set
//      direction='neutral' (its cut was >=60). The bias aggregator counts
//      `direction`, so a mildly bullish participant was read as neutral.
//   2. computeSmartMoneyBias() folded RETAIL (Client) into the smart-money
//      weights with a default 0.25 (Client was not even in the weight map),
//      diluting the institutional read.

import { describe, test, expect } from "bun:test";
import {
  computeSmartMoneyBias,
  computeStrengthScore,
  type ParticipantChanges,
  type SmartMoneyBias,
} from "@/lib/institutional-positioning-engine";

type Score = Parameters<typeof computeSmartMoneyBias>[0][number];

const FLAT = { raw: 0, pct: 0, classification: "flat" as const };

function changes(netRaw: number): ParticipantChanges {
  const delta = (raw: number) => ({ raw, pct: raw === 0 ? 0 : 50, classification: raw > 0 ? "moderate_add" : raw < 0 ? "moderate_reduce" : "flat" });
  return {
    clientType: "FII",
    current: {
      futureIndexLong: 0, futureIndexShort: 0, futureStockLong: 0, futureStockShort: 0,
      optionIndexCallLong: 0, optionIndexCallShort: 0, optionIndexPutLong: 0, optionIndexPutShort: 0,
      optionStockCallLong: 0, optionStockCallShort: 0, optionStockPutLong: 0, optionStockPutShort: 0,
      totalLong: 0, totalShort: 0,
    },
    dailyDelta: {
      futureIndexLong: delta(0), futureIndexShort: delta(0),
      optionIndexCallLong: delta(0), optionIndexPutLong: delta(0),
      optionIndexCallShort: delta(0), optionIndexPutShort: delta(0),
      totalLong: delta(0), totalShort: delta(0),
      netPosition: delta(netRaw),
    },
    weeklyDelta: { netPosition: FLAT },
    monthlyDelta: { netPosition: FLAT },
    rollingTrend: "neutral",
    momentum: 0,
    acceleration: 0,
  };
}

function score(participant: string, s: number, direction: Score["direction"]): Score {
  return {
    participant,
    score: s,
    direction,
    label: s >= 55 ? "Mild Bullish" : s < 45 ? "Mild Bearish" : "Neutral",
    conviction: "moderate",
  };
}

describe("computeStrengthScore — direction and label must agree", () => {
  test("a mildly bullish score is direction bullish (was 'Mild Bullish' + neutral)", () => {
    // net delta +100_000 → score 50 + min(45, 10) = 60 → 'Bullish'
    const s = computeStrengthScore("Pro", changes(100_000), 0);
    expect(s.score).toBe(60);
    expect(s.direction).toBe("bullish");
    expect(s.label).toBe("Mild Bullish");
  });

  test("score 58 (the live Pro reading) is bullish, not neutral", () => {
    // net delta +80_000 → score 50 + 8 = 58 → 'Mild Bullish'
    const s = computeStrengthScore("Pro", changes(80_000), 0);
    expect(s.score).toBe(58);
    expect(s.label).toBe("Mild Bullish");
    expect(s.direction).toBe("bullish");
  });

  test("a mildly bearish score is direction bearish", () => {
    const s = computeStrengthScore("DII", changes(-120_000), 0);
    expect(s.score).toBe(38);
    expect(s.label).toBe("Mild Bearish");
    expect(s.direction).toBe("bearish");
  });

  test("a mid score stays neutral", () => {
    const s = computeStrengthScore("FII", changes(0), 0);
    expect(s.score).toBe(50);
    expect(s.direction).toBe("neutral");
    expect(s.label).toBe("Neutral");
  });

  test("no data → neutral, never a fabricated directional score", () => {
    const s = computeStrengthScore("FII", null, 0);
    expect(s).toEqual({ participant: "FII", score: 50, direction: "neutral", label: "Neutral", conviction: "low" });
  });
});

describe("computeSmartMoneyBias — institutional participants only", () => {
  test("retail (Client) is NOT part of the smart-money read", () => {
    const withoutRetail = computeSmartMoneyBias([
      score("FII", 48, "neutral"),
      score("Pro", 58, "bullish"),
      score("DII", 38, "bearish"),
    ]);
    const withRetail = computeSmartMoneyBias([
      score("FII", 48, "neutral"),
      score("Pro", 58, "bullish"),
      score("DII", 38, "bearish"),
      score("Client", 56, "bullish"),
    ]);
    expect(withRetail).toEqual(withoutRetail);
    expect(withRetail.bullishPct).toBe(35);   // Pro 0.35 of 1.00
    expect(withRetail.bearishPct).toBe(25);   // DII 0.25
    expect(withRetail.neutralPct).toBe(40);   // FII 0.40
    // The FII is neutral, so the read stays neutral — but it now carries the
    // 35% bull tilt instead of the old "0% bull".
    expect(withRetail.dominantDirection).toBe("neutral");
  });

  test("two bullish institutions → bullish dominance", () => {
    const bias = computeSmartMoneyBias([
      score("FII", 60, "bullish"),
      score("Pro", 58, "bullish"),
      score("DII", 50, "neutral"),
    ]);
    expect(bias.bullishPct).toBe(75);
    expect(bias.neutralPct).toBe(25);
    expect(bias.dominantDirection).toBe("bullish");
  });

  test("a retail-only bull cannot turn the smart money bullish", () => {
    const bias: SmartMoneyBias = computeSmartMoneyBias([
      score("FII", 50, "neutral"),
      score("Pro", 50, "neutral"),
      score("DII", 50, "neutral"),
      score("Client", 90, "bullish"),
    ]);
    expect(bias.bullishPct).toBe(0);
    expect(bias.dominantDirection).toBe("neutral");
  });

  test("weights: FII 0.40, Pro 0.35, DII 0.25", () => {
    const bias = computeSmartMoneyBias([
      score("FII", 70, "bullish"),
      score("Pro", 70, "bullish"),
      score("DII", 70, "bullish"),
    ]);
    expect(bias.bullishPct).toBe(100);
    expect(bias.bearishPct).toBe(0);
    expect(bias.neutralPct).toBe(0);
    expect(bias.dominantDirection).toBe("bullish");
  });

  test("all neutral → neutral, never a fabricated 0/0", () => {
    const bias = computeSmartMoneyBias([
      score("FII", 50, "neutral"),
      score("Pro", 50, "neutral"),
      score("DII", 50, "neutral"),
    ]);
    expect(bias).toEqual({ bullishPct: 0, bearishPct: 0, neutralPct: 100, dominantDirection: "neutral" });
  });

  test("a bearish DII with a neutral FII/Pro reads bearish-weighted", () => {
    const bias = computeSmartMoneyBias([
      score("FII", 50, "neutral"),
      score("Pro", 50, "neutral"),
      score("DII", 30, "bearish"),
    ]);
    expect(bias.bearishPct).toBe(25);
    expect(bias.neutralPct).toBe(75);
    expect(bias.dominantDirection).toBe("neutral");
  });
});
