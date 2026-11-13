// brain-flags.ts
// ONE config file for every behavioural switch in the trading brain.
// Default = current behaviour. The only exception is the shadow logging, which
// defaults ON (it must not change what is sent).
//
// Thresholds live in GATE_CONFIG (agent-brain-gate.ts) — never duplicate them here.

export const BRAIN_FLAGS = {
  /** Shadow mode: the veto computes verdicts and records would_block, but a QUALITY
   *  block does not suppress the alert. Hard safety gates (R:R, expiry day, |delta|,
   *  OTM steps, lots, loss limits, stale feed) and the fail-closed rule for missing
   *  critical fields ALWAYS suppress — shadowing never loosens a hard gate. */
  shadowVeto: true,
  /** Log every candidate (sent / blocked / paper) into candidate_log. */
  candidateLog: true,
  /** Strict gate in the agent path. hybrid:true is an explicit fallback, off by default. */
  strictGate: false,
  /** Tier output (A / B / C / NONE) replaces "TRADE + halve size" in alerts. */
  tiering: false,
  /** No NEW option premium buys after 13:00 IST.
   *  Ledger evidence: option entries at 13:00-14:59 went 0 wins / 34 trades
   *  (option-chain-api 13h 0/12, 14h 0/22) while the same engine at 10:00 was 63%. */
  noOptionBuysAfter13: false,
  /** Apply the cost model when resolving candidate outcomes (off = gross R). */
  resolverCosts: false,
  /** Promotion rule: a tier-C candidate may only be promoted (sent) after this many
   *  RESOLVED candidates in that tier with a Wilson lower bound on expectancy R above
   *  minExpectancyCiLowerR. */
  promotion: { minResolvedTrades: 175, minExpectancyCiLowerR: 0 },
  /** Simple Tab direction engine (Phase 6):
   *  "legacy" = PCR-only (runFullAnalysis default, current production behaviour).
   *  "v2"    = multi-factor OI vote (PCR + OI-change balance + max-pain pull +
   *            near-ATM wall). Same fail-closed NEUTRAL rules; no candle fabricaton.
   *  Override at load with SIMPLE_ENGINE=legacy|v2. */
  simpleEngine: readSimpleEngine(),
} as const;

export type BrainFlags = typeof BRAIN_FLAGS;

function readSimpleEngine(): "legacy" | "v2" {
  return process.env.SIMPLE_ENGINE === "v2" ? "v2" : "legacy";
}

/**
 * Switch the Simple Tab direction engine (tests / runtime override).
 * Mutates BRAIN_FLAGS.simpleEngine — production default is legacy.
 */
export function setSimpleEngine(mode: "legacy" | "v2"): void {
  (BRAIN_FLAGS as { simpleEngine: "legacy" | "v2" }).simpleEngine = mode;
}

/** Cost model (per option round-trip) used when resolverCosts is ON. */
export const COST_MODEL = {
  perTradePremiumPct: 0.012, // brokerage + STT + exchange + GST approx on premium turnover
  perUnit: 0,                // extra per-unit cost (kept 0 until measured)
} as const;
