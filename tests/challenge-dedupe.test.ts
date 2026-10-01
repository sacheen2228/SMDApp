/// <reference types="bun-types" />
// challenge dedupe — keyed per (symbol, instrument-kind) so an option setup
// is never erased by a higher-scoring equity setup on the same symbol
// (previously: Map keyed by symbol only → options silently dropped).

import { describe, it, expect } from "bun:test";
import { dedupeOpportunities } from "@/lib/challenge/challenge-engine";
import type { ChallengeOpportunity } from "@/lib/challenge/challenge-engine";

function opp(symbol: string, instrument: string, score: number): ChallengeOpportunity {
  return { symbol, instrument, score } as ChallengeOpportunity;
}

describe("dedupeOpportunities", () => {
  it("keeps both an equity setup and an option setup on the same symbol", () => {
    const out = dedupeOpportunities([
      opp("ICICIBANK", "EQUITY", 87),
      opp("ICICIBANK", "CALL", 65),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.instrument).sort()).toEqual(["CALL", "EQUITY"]);
  });

  it("keeps the higher-scoring of two option setups on the same symbol", () => {
    const out = dedupeOpportunities([
      opp("NIFTY", "PUT", 70),
      opp("NIFTY", "PUT", 82),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(82);
  });

  it("keeps the higher-scoring of two equity setups on the same symbol", () => {
    const out = dedupeOpportunities([
      opp("RVNL", "EQUITY", 61),
      opp("RVNL", "EQUITY", 81),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(81);
  });

  it("treats FUTURES and EQUITY as the same base kind (no duplicate non-option stacks)", () => {
    const out = dedupeOpportunities([
      opp("SBIN", "EQUITY", 74),
      opp("SBIN", "FUTURES", 70),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].instrument).toBe("EQUITY");
  });

  it("keeps PUT and CALL as separate option setups on the same symbol", () => {
    const out = dedupeOpportunities([
      opp("BANKNIFTY", "CALL", 66),
      opp("BANKNIFTY", "PUT", 78),
    ]);
    expect(out).toHaveLength(2);
  });

  it("handles empty input and preserves distinct symbols", () => {
    expect(dedupeOpportunities([])).toHaveLength(0);
    const out = dedupeOpportunities([
      opp("A", "EQUITY", 60),
      opp("B", "PUT", 70),
      opp("C", "CALL", 55),
    ]);
    expect(out).toHaveLength(3);
  });
});
