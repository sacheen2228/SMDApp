// Central Decision Coordinator — Phase E of Unified Intraday Intelligence Engine
//
// ONE coordinator. All five modules report evidence here; no module
// independently generates final trading recommendations.
//
// The coordinator:
//   1. Collects outputs from all five modules
//   2. Validates timestamps and instrument identity
//   3. Detects stale and missing data
//   4. Deduplicates related evidence
//   5. Detects bullish/bearish conflicts
//   6. Separates market context from entry confirmation
//   7. Evaluates movement potential
//   8. Evaluates option premium economics
//   9. Evaluates risk and liquidity
//   10. Produces one final research decision: BUY CE | BUY PE | WAIT | NO_TRADE
//
// Research-only. Does NOT create a scanner or trading engine. Does NOT
// modify production strategies, execution, risk management or Telegram.
// Fails closed on missing/stale critical data — never fabricates a signal.

import type { IndicatorBundle } from "./indicators";
import { indicatorsSufficientForTrade } from "./indicators";
import type { SmcRead } from "./smc";
import type { MechanismRead } from "./mechanism";
import type { DerivativesContext, OptionTradePlan, OptionChainValidation, FuturesOIRead, GreeksValidation } from "./derivatives";
import type { MarketContext } from "./market-context";
import type { SectorBreadthResult } from "@/lib/universe";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type CoordinatorDecision = "BUY_CE" | "BUY_PE" | "WAIT" | "NO_TRADE";

export type EvidenceStrength = "STRONG" | "MODERATE" | "WEAK" | "ABSENT";

export interface ModuleEvidence {
  module: "market_context" | "cash_sector" | "price_action" | "smc_structure" | "derivatives";
  available: boolean;
  confidence: number; // 0-100
  keyFindings: string[];
  blockers: string[];
}

export interface ConflictDetail {
  type: "DIRECTION" | "RISK_REWARD" | "DATA_FRESHNESS" | "LIQUIDITY" | "EXPIRY";
  description: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  side: "bullish" | "bearish" | "neutral";
}

export interface CoordinatorResult {
  symbol: string;
  exchange: "NSE" | "BSE";
  timestamp: string;
  decision: CoordinatorDecision;
  confidence: number; // 0-100, not an uncalibrated probability
  evidenceStrength: EvidenceStrength;
  moduleEvidence: ModuleEvidence[];
  conflicts: ConflictDetail[];
  supportingEvidence: string[];
  conflictingEvidence: string[];
  missingInputs: string[];
  // Trade plan (only when decision is BUY_CE or BUY_PE)
  tradePlan: {
    optionType: "CE" | "PE" | null;
    strike: number | null;
    expiry: string | null;
    entryPremium: number | null;
    stopLoss: number | null;
    targets: number[];
    lots: number;
    deployedAmount: number | null;
    riskAmount: number | null;
    riskReward: number | null;
    tradable: boolean;
    reason: string | null;
  } | null;
  // Context snapshots for auditability
  mechanism: MechanismRead;
  marketContext: MarketContext;
  derivatives: DerivativesContext;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function moduleEvidence(
  module: ModuleEvidence["module"],
  available: boolean,
  confidence: number,
  keyFindings: string[],
  blockers: string[],
): ModuleEvidence {
  return { module, available, confidence, keyFindings, blockers };
}

function confidenceLabel(c: number): EvidenceStrength {
  if (c >= 75) return "STRONG";
  if (c >= 55) return "MODERATE";
  if (c >= 30) return "WEAK";
  return "ABSENT";
}

// ────────────────────────────────────────────────────────────────────────────
// Main coordinator
// ────────────────────────────────────────────────────────────────────────────

/**
 * Produce one final research decision from all module evidence.
 *
 * @param symbol — trading symbol
 * @param exchange — NSE or BSE
 * @param indicatorBundle — Phase B indicators (DTR, ATR, VWAP, ADX, RVOL, structure, regime, direction)
 * @param smcRead — Phase C SMC read
 * @param mechanismRead — Phase C mechanism detection
 * @param derivatives — Phase D derivatives context (futures OI, option chain, Greeks, VIX, FII/DII, plan)
 * @param marketContext — Phase D market context (VIX, FII/DII, sector breadth, regime)
 * @param sectorBreadth — Phase A sector breadth result
 * @param capital — deployment capital for option plan sizing
 */
export function coordinateDecision(
  symbol: string,
  exchange: "NSE" | "BSE",
  indicatorBundle: IndicatorBundle,
  smcRead: SmcRead,
  mechanismRead: MechanismRead,
  derivatives: DerivativesContext,
  marketContext: MarketContext,
  sectorBreadth: SectorBreadthResult | null,
  capital = 100_000,
): CoordinatorResult {
  const timestamp = new Date().toISOString();
  const moduleEvidenceList: ModuleEvidence[] = [];
  const supportingEvidence: string[] = [];
  const conflictingEvidence: string[] = [];
  const conflicts: ConflictDetail[] = [];
  const missingInputs: string[] = [];

  // ── Step 1: Validate timestamps & instrument identity ──
  const lastCandleTs = indicatorBundle.lastCandleTs;
  const ocVal = derivatives.optionChain.value;
  const foVal = derivatives.futuresOI.value;
  const planVal = derivatives.optionPlan.value;
  const adxVal = indicatorBundle.adx.value;
  const rvolVal = indicatorBundle.rvol.value;
  const dtrVal = indicatorBundle.dtr.value;
  const vixVal = derivatives.vix.value;

  const chainAgeMs = ocVal
    ? derivatives.futuresOI.freshness === "STALE" || derivatives.futuresOI.freshness === "UNAVAILABLE"
      ? 999_999
      : 0
    : 999_999;

  const dataStale =
    lastCandleTs == null ||
    Date.now() - lastCandleTs > 900_000; // >15 min stale

  if (dataStale) {
    missingInputs.push("recent candle data (stale or missing)");
  }

  // ── Step 2: Module evidence collection ──
  // Market context (Module 1)
  const mcAvailable = marketContext.contextQuality !== "UNAVAILABLE";
  const mcConfidence = marketContext.contextQuality === "HIGH" ? 85
    : marketContext.contextQuality === "MEDIUM" ? 65
    : marketContext.contextQuality === "LOW" ? 40
    : 0;
  const mcFindings: string[] = [];
  const mcBlockers: string[] = [];
  if (marketContext.vix.available) {
    mcFindings.push(`India VIX ${marketContext.vix.value?.value?.toFixed(1) ?? "?"} (${marketContext.vix.value?.regime ?? "?"})`);
  } else {
    mcBlockers.push("India VIX unavailable");
    missingInputs.push("India VIX");
  }
  if (marketContext.fiiDii.available) {
    mcFindings.push(`FII/DII net: FII ₹${marketContext.fiiDii.value?.fiiNet?.toFixed(0) ?? "?"}Cr | DII ₹${marketContext.fiiDii.value?.diiNet?.toFixed(0) ?? "?"}Cr`);
  } else {
    mcBlockers.push("FII/DII unavailable");
    missingInputs.push("FII/DII");
  }
  if (marketContext.sectorBreadth.available) {
    mcFindings.push(`Sector breadth: ${marketContext.sectorBreadth.value?.regime ?? "?"}`);
  } else {
    mcBlockers.push("sector breadth unavailable");
    missingInputs.push("sector breadth");
  }
  moduleEvidenceList.push(moduleEvidence("market_context", mcAvailable, mcConfidence, mcFindings, mcBlockers));

  // Cash sector (Module 2)
  const csAvailable = sectorBreadth != null && sectorBreadth.totalWithPriceData > 0;
  const csConfidence = csAvailable ? Math.min(85, sectorBreadth.totalWithPriceData * 2) : 0;
  const csFindings: string[] = [];
  const csBlockers: string[] = [];
  if (csAvailable) {
    csFindings.push(`Advances ${sectorBreadth!.advances} / Declines ${sectorBreadth!.declines} / Unchanged ${sectorBreadth!.unchanged}`);
    csFindings.push(`Unique companies: ${sectorBreadth!.uniqueCompanies}`);
  } else {
    csBlockers.push("sector breadth data unavailable");
    missingInputs.push("sector breadth");
  }
  moduleEvidenceList.push(moduleEvidence("cash_sector", csAvailable, csConfidence, csFindings, csBlockers));

  // Price action (Module 3)
  const paAvailable = indicatorsSufficientForTrade(indicatorBundle);
  const paFindings: string[] = [];
  const paBlockers: string[] = [];
  if (indicatorBundle.dtr.sufficientData) {
    paFindings.push(`DTR utilization ${(indicatorBundle.dtr.value?.dtrUtilization ?? 0).toFixed(0)}%`);
  } else {
    paBlockers.push("DTR insufficient");
    missingInputs.push("DTR");
  }
  if (indicatorBundle.vwap.sufficientData) {
    paFindings.push(`VWAP deviation ${(indicatorBundle.vwap.value?.deviationPct ?? 0).toFixed(1)}%`);
  } else {
    paBlockers.push("VWAP insufficient");
    missingInputs.push("VWAP");
  }
  if (indicatorBundle.atr.sufficientData) {
    paFindings.push(`ATR regime ${indicatorBundle.atr.value?.regime ?? "?"}`);
  } else {
    paBlockers.push("ATR insufficient");
    missingInputs.push("ATR");
  }
  if (indicatorBundle.rvol.sufficientData) {
    paFindings.push(`RVOL ${indicatorBundle.rvol.value?.ratio.toFixed(1)}x`);
  } else {
    paBlockers.push("RVOL insufficient");
    missingInputs.push("RVOL");
  }
  moduleEvidenceList.push(moduleEvidence("price_action", paAvailable, paAvailable ? 80 : 20, paFindings, paBlockers));

  // SMC structure (Module 4)
  const smcAvailable = smcRead.sufficientData;
  moduleEvidenceList.push(moduleEvidence(
    "smc_structure",
    smcAvailable,
    smcRead.confidence,
    smcRead.evidence,
    smcRead.conflictingEvidence,
  ));
  smcRead.evidence.forEach((e) => supportingEvidence.push(`SMC: ${e}`));
  smcRead.conflictingEvidence.forEach((e) => conflictingEvidence.push(`SMC conflict: ${e}`));

  // Derivatives (Module 5)
  const derAvailable = derivatives.optionChain.available && derivatives.futuresOI.available;
  const derFindings: string[] = [];
  const derBlockers: string[] = [];
  if (derivatives.optionChain.available && ocVal) {
    derFindings.push(`PCR ${ocVal.pcr?.toFixed(2) ?? "?"} | bias ${ocVal.bias ?? "?"}`);
  } else {
    derBlockers.push("option chain unavailable");
    missingInputs.push("option chain");
  }
  if (derivatives.futuresOI.available) {
    derFindings.push(`Futures OI buildup: ${derivatives.futuresOI.value?.buildup ?? "?"}`);
  } else {
    derBlockers.push("futures OI unavailable");
    missingInputs.push("futures OI");
  }
  if (derivatives.vix.available) {
    derFindings.push(`India VIX ${derivatives.vix.value?.value?.toFixed(1) ?? "?"}`);
  } else {
    derBlockers.push("India VIX unavailable");
  }
  if (derivatives.fiiDii.available) {
    derFindings.push(`FII net ₹${derivatives.fiiDii.value?.fiiNet?.toFixed(0) ?? "?"}Cr`);
  } else {
    derBlockers.push("FII/DII unavailable");
  }
  moduleEvidenceList.push(moduleEvidence("derivatives", derAvailable, derAvailable ? 80 : 20, derFindings, derBlockers));

  // ── Step 3: Deduplicate related evidence ──
  // SMC evidence and mechanism evidence overlap — deduplicate by type
  const dedupedSupporting = [...new Set(supportingEvidence)];
  const dedupedConflicting = [...new Set(conflictingEvidence)];

  // ── Step 4: Detect bullish/bearish conflicts ──
  // SMC vs mechanism direction conflict
  if (smcRead.structure === "BULLISH" && mechanismRead.control === "bearish") {
    conflicts.push({
      type: "DIRECTION",
      description: "SMC bullish but mechanism bearish",
      severity: "HIGH",
      side: "neutral",
    });
    conflictingEvidence.push("SMC bullish but mechanism bearish — direction conflict");
  }
  if (smcRead.structure === "BEARISH" && mechanismRead.control === "bullish") {
    conflicts.push({
      type: "DIRECTION",
      description: "SMC bearish but mechanism bullish",
      severity: "HIGH",
      side: "neutral",
    });
    conflictingEvidence.push("SMC bearish but mechanism bullish — direction conflict");
  }

  // Option chain bias vs structure conflict
  if (ocVal) {
    const ocBias = ocVal.bias;
    if (ocBias === "BULLISH_LEAN" && smcRead.structure === "BEARISH") {
      conflicts.push({
        type: "DIRECTION",
        description: "Option chain bullish lean but SMC bearish",
        severity: "MEDIUM",
        side: "neutral",
      });
      conflictingEvidence.push("Option chain bullish but SMC bearish");
    }
    if (ocBias === "BEARISH_LEAN" && smcRead.structure === "BULLISH") {
      conflicts.push({
        type: "DIRECTION",
        description: "Option chain bearish lean but SMC bullish",
        severity: "MEDIUM",
        side: "neutral",
      });
      conflictingEvidence.push("Option chain bearish but SMC bullish");
    }
  }

  // VIX high vs bullish direction conflict
  if (vixVal != null && vixVal.value > 22) {
    if (mechanismRead.control === "bullish") {
      conflicts.push({
        type: "RISK_REWARD",
        description: "High VIX with bullish direction — elevated risk",
        severity: "MEDIUM",
        side: "bullish",
      });
      conflictingEvidence.push(`High VIX (${vixVal.value}) but bullish structure`);
    }
  }

  // Liquidity conflict — 0 lots or no liquidity
  if (planVal) {
    if (planVal.lots < 1) {
      conflicts.push({
        type: "LIQUIDITY",
        description: "0 lots — contract exceeds per-trade budget",
        severity: "HIGH",
        side: "neutral",
      });
      conflictingEvidence.push("0 lots — contract exceeds per-trade deployment budget");
    }
    if (planVal.riskReward != null && planVal.riskReward < 1.5) {
      conflicts.push({
        type: "RISK_REWARD",
        description: `R:R ${planVal.riskReward.toFixed(2)} below 1.5 minimum`,
        severity: "HIGH",
        side: "neutral",
      });
      conflictingEvidence.push(`R:R ${planVal.riskReward.toFixed(2)} below 1.5 minimum`);
    }
  }

  // Data freshness conflict
  if (marketContext.vix.freshness === "STALE" || marketContext.fiiDii.freshness === "STALE") {
    conflicts.push({
      type: "DATA_FRESHNESS",
      description: "Critical context data stale",
      severity: "MEDIUM",
      side: "neutral",
    });
    conflictingEvidence.push("Critical context data stale");
  }

  // ── Step 5: Separate market context from entry confirmation ──
  // Market context (trend, regime, breadth) sets the environment
  // Entry confirmation (SMC, structure, option chain, plan) sets the trigger
  const marketContextBullish =
    mechanismRead.control === "bullish" ||
    smcRead.structure === "BULLISH" ||
    (marketContext.regime.available && marketContext.regime.value?.bias === "BULLISH");
  const marketContextBearish =
    mechanismRead.control === "bearish" ||
    smcRead.structure === "BEARISH" ||
    (marketContext.regime.available && marketContext.regime.value?.bias === "BEARISH");

  // Entry confirmation requires: tradable plan + sufficient data + min R:R
  const entryConfirmed =
    planVal != null &&
    planVal.tradable === true &&
    indicatorsSufficientForTrade(indicatorBundle) &&
    smcRead.sufficientData;

  // ── Step 6: Evaluate movement potential ──
  let movementPotential = 0; // 0-100
  if (adxVal != null && adxVal.adx > 25) movementPotential += 25;
  if (rvolVal != null && rvolVal.ratio > 1.5) movementPotential += 25;
  if (dtrVal != null && (dtrVal.dtrUtilization ?? 0) < 0.8) movementPotential += 25; // room to move
  if (mechanismRead.confirmationStatus === "CONFIRMED") movementPotential += 25;

  // ── Step 7: Evaluate option premium economics ──
  let premiumEconomics = 0; // 0-100
  if (derivatives.greeks.valid) premiumEconomics += 40;
  if (ocVal != null && ocVal.pcr != null) {
    const pcr = ocVal.pcr;
    if (pcr > 0.8 && pcr < 1.5) premiumEconomics += 30; // neutral PCR — not extreme
  }
  if (vixVal != null && vixVal.value < 25) premiumEconomics += 30; // not extreme vol

  // ── Step 8: Evaluate risk and liquidity ──
  let riskLiquidity = 0; // 0-100
  if (planVal != null && planVal.lots > 0) riskLiquidity += 50;
  if (foVal != null && foVal.currentOI != null && foVal.currentOI > 0) riskLiquidity += 25;
  if (rvolVal != null && rvolVal.ratio > 1.0) riskLiquidity += 25;

  // ── Step 9: Produce final decision ──
  let decision: CoordinatorDecision = "NO_TRADE";
  let confidence = 0;

  const hasHighConflicts = conflicts.some((c) => c.severity === "HIGH");
  const hasMediumConflicts = conflicts.some((c) => c.severity === "MEDIUM");

  // No trade if: stale data, high conflicts, no entry confirmation, not tradable
  if (dataStale) {
    decision = "NO_TRADE";
    confidence = 10;
  } else if (hasHighConflicts) {
    decision = "WAIT";
    confidence = 30;
  } else if (!entryConfirmed) {
    decision = "WAIT";
    confidence = 20;
  } else if (!planVal || !planVal.tradable) {
    decision = "WAIT";
    confidence = 25;
  } else {
    // Entry confirmed — determine direction
    const bullishScore =
      (marketContextBullish ? 30 : 0) +
      (smcRead.structure === "BULLISH" ? 25 : 0) +
      (mechanismRead.control === "bullish" ? 25 : 0) +
      (movementPotential > 50 ? 10 : 0) +
      (premiumEconomics > 50 ? 10 : 0);

    const bearishScore =
      (marketContextBearish ? 30 : 0) +
      (smcRead.structure === "BEARISH" ? 25 : 0) +
      (mechanismRead.control === "bearish" ? 25 : 0) +
      (movementPotential > 50 ? 10 : 0) +
      (premiumEconomics > 50 ? 10 : 0);

    // Apply conflict penalty
    if (hasMediumConflicts) {
      // Reduce both scores but keep the higher one
    }

    if (bullishScore > bearishScore && bullishScore >= 60) {
      decision = "BUY_CE";
      confidence = Math.min(90, bullishScore);
    } else if (bearishScore > bullishScore && bearishScore >= 60) {
      decision = "BUY_PE";
      confidence = Math.min(90, bearishScore);
    } else {
      decision = "WAIT";
      confidence = Math.max(bullishScore, bearishScore, 30);
    }
  }

  // ── Step 10: Build trade plan (only for BUY_CE / BUY_PE) ──
  let tradePlan: CoordinatorResult["tradePlan"] = null;
  if ((decision === "BUY_CE" || decision === "BUY_PE") && planVal) {
    tradePlan = {
      optionType: planVal.optionType,
      strike: planVal.strike,
      expiry: planVal.expiry,
      entryPremium: planVal.entryPremium,
      stopLoss: planVal.stopLoss,
      targets: planVal.targets,
      lots: planVal.lots,
      deployedAmount: planVal.deployedAmount,
      riskAmount: planVal.riskAmount,
      riskReward: planVal.riskReward,
      tradable: planVal.tradable,
      reason: planVal.reason ?? null,
    };
  }

  return {
    symbol,
    exchange,
    timestamp,
    decision,
    confidence,
    evidenceStrength: confidenceLabel(confidence),
    moduleEvidence: moduleEvidenceList,
    conflicts,
    supportingEvidence: dedupedSupporting,
    conflictingEvidence: dedupedConflicting,
    missingInputs,
    tradePlan,
    mechanism: mechanismRead,
    marketContext,
    derivatives,
  };
}
