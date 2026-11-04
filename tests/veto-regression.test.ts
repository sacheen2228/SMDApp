// tests/veto-regression.test.ts
// Frozen regression fixture: the verdict distribution per source must not change
// unless the veto configuration (GATE_CONFIG + BRAIN_FLAGS) changes.
//
// The fixture is a SNAPSHOT of the 530 closed-ledger rows (fields the veto is allowed
// to read). It is deliberately small and hand-checked so the test is fast and the
// expectation is auditable.
import { describe, test, expect } from "bun:test";
import { evaluateSignalVeto, type VetoVerdict } from "@/lib/signal-veto";
import { GATE_CONFIG } from "@/lib/agent-brain-gate";
import { configHash } from "@/lib/candidate-log";

interface FixtureRow {
  source: string;
  symbol: string;
  side: "call" | "put" | "other";
  direction: "BUY" | "SELL" | "UNKNOWN";
  entry: number | null;
  stop: number | null;
  target: number | null;
  confidence: number;
  expiry: string | null;
  spot: number | null;
}

// Hand-checked snapshot of the ledger (2026-10-19). 12 rows covering every
// branch the veto can take.
const FIXTURE: FixtureRow[] = [
  // SMART_MONEY: good R:R, high confidence → PASS
  { source: "SMART_MONEY", symbol: "NIFTY", side: "call", direction: "BUY", entry: 100, stop: 90, target: 130, confidence: 75, expiry: "2026-07-30", spot: 22600 },
  // SMART_MONEY: R:R 1.0 → hard block
  { source: "SMART_MONEY", symbol: "NIFTY", side: "call", direction: "BUY", entry: 100, stop: 90, target: 100, confidence: 75, expiry: "2026-07-30", spot: 22600 },
  // SMART_MONEY: low confidence → quality warning (WARN while shadow mode is on)
  { source: "SMART_MONEY", symbol: "NIFTY", side: "call", direction: "BUY", entry: 100, stop: 90, target: 130, confidence: 55, expiry: "2026-07-30", spot: 22600 },
  // option-chain-api: placeholder R:R 1.00 → hard block
  { source: "option-chain-api", symbol: "NIFTY", side: "call", direction: "BUY", entry: 100, stop: 90, target: 100, confidence: 0, expiry: null, spot: null },
  // option-chain-api: confidence 0 → quality warning
  { source: "option-chain-api", symbol: "NIFTY", side: "call", direction: "BUY", entry: 100, stop: 90, target: 130, confidence: 0, expiry: null, spot: null },
  // stock-scanner: missing target → fail closed
  { source: "stock-scanner", symbol: "NTPC", side: "call", direction: "BUY", entry: 4.2, stop: 3.57, target: null, confidence: 0, expiry: null, spot: null },
  // BTST: never touched
  { source: "BTST", symbol: "RELIANCE", side: "other", direction: "BUY", entry: 2800, stop: 2750, target: 2810, confidence: 40, expiry: null, spot: null },
  // morning-signal: bearish label with a long-style stop → hard block
  { source: "morning-signal", symbol: "NIFTY", side: "other", direction: "SELL", entry: 10.25, stop: 9.25, target: 11.5, confidence: 60, expiry: null, spot: null },
  // deep OTM (4 steps) → hard block
  { source: "SMART_MONEY", symbol: "NIFTY", side: "call", direction: "BUY", entry: 100, stop: 90, target: 130, confidence: 75, expiry: "2026-07-30", spot: 22600 - 4 * 50 },
  // expiry day → hard block (pinned to the fixture clock AT = 2026-07-15, not real today)
  { source: "SMART_MONEY", symbol: "NIFTY", side: "call", direction: "BUY", entry: 100, stop: 90, target: 130, confidence: 75, expiry: "2026-07-15", spot: 22600 },
  // unknown direction → warning (never a false block)
  { source: "option-chain-api", symbol: "NIFTY", side: "other", direction: "UNKNOWN", entry: 100, stop: 90, target: 130, confidence: 75, expiry: null, spot: null },
  // equity with a good R:R → PASS
  { source: "SMART_MONEY", symbol: "RELIANCE", side: "other", direction: "BUY", entry: 2800, stop: 2750, target: 2950, confidence: 75, expiry: null, spot: null },
];

// pinned to 10:05 IST — before the 13:00 option-buy cutoff
const AT = Date.parse("2026-07-15T10:05:00+05:30");

function verdictOf(r: FixtureRow): VetoVerdict {
  const action = r.side === "put" ? "SELL PE" : r.side === "call" ? "BUY CE" : r.direction === "SELL" ? "SELL" : r.direction === "BUY" ? "BUY" : "UNKNOWN";
  return evaluateSignalVeto({
    symbol: r.symbol,
    action,
    optionType: r.side === "call" ? "CE" : r.side === "put" ? "PE" : undefined,
    strike: r.side === "call" || r.side === "put" ? 22600 : undefined,
    entry: r.entry ?? undefined,
    stopLoss: r.stop ?? undefined,
    tp1: r.target ?? undefined,
    confidence: r.confidence,
    expiry: r.expiry ?? undefined,
    spot: r.spot ?? undefined,
    source: r.source,
    nowMs: AT,
  }).verdict;
}

// Frozen expectations — change ONLY together with a config_hash change.
const EXPECTED: Record<string, Record<string, number>> = {
  SMART_MONEY: { PASS: 2, WARN: 1, BLOCK: 3 },
  "option-chain-api": { PASS: 0, WARN: 2, BLOCK: 1 },
  "stock-scanner": { PASS: 0, WARN: 0, BLOCK: 1 },
  BTST: { PASS: 1, WARN: 0, BLOCK: 0 },
  "morning-signal": { PASS: 0, WARN: 0, BLOCK: 1 },
};

describe("veto regression — frozen ledger snapshot", () => {
  test("verdict counts per source match the frozen expectations", () => {
    const counts: Record<string, Record<string, number>> = {};
    for (const row of FIXTURE) {
      const v = verdictOf(row);
      counts[row.source] = counts[row.source] || { PASS: 0, WARN: 0, BLOCK: 0 };
      counts[row.source][v]++;
    }
    expect(counts).toEqual(EXPECTED);
  });

  test("the expectation is pinned to the current config hash", () => {
    // If the veto configuration changes, this hash changes and the frozen
    // expectations above must be re-checked on purpose.
    //
    // Re-pinned 2026-10-20 for the PER-TRADE capital model (GATE_CONFIG:
    // capital ₹25,000, riskPctOfTrade 20, tradeBudget ₹20,000, maxConsecutive
    // Losses 2, maxDailyLossPct 40). The frozen verdict counts above were
    // re-checked against the new config and are UNCHANGED.
    expect(configHash()).toBe("c317ce55972728ce");
  });
});
