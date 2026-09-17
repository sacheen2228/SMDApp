// Hermes No-Trade Engine — evaluates all reasons to reject a trade
// Hermes must be comfortable saying NO TRADE.

import type { HermesContext, NoTradeReason, TradeCandidate } from "./types";
import { evaluateDataHealth, shouldBlockTrades } from "../data-health";

// ── No-Trade Evaluation ────────────────────────────────────────────────

export function evaluateNoTrade(
  ctx: HermesContext,
  candidate?: TradeCandidate
): NoTradeReason[] {
  const reasons: NoTradeReason[] = [];

  // Data quality
  const spotPrice = ctx.spot.value?.price || 0;
  if (spotPrice <= 0) {
    reasons.push({ category: "DATA", reason: "Spot price is zero or negative", severity: "CRITICAL" });
  }
  if (ctx.spot.freshness === "UNAVAILABLE") {
    reasons.push({ category: "DATA", reason: "Spot price unavailable", severity: "CRITICAL" });
  }
  if (ctx.spot.freshness === "STALE") {
    reasons.push({ category: "DATA", reason: "Spot data is stale", severity: "CRITICAL" });
  }
  if (ctx.spot.delayed) {
    reasons.push({ category: "DATA", reason: "Spot data is delayed — research only", severity: "CRITICAL" });
  }
  if (ctx.optionChain.freshness === "UNAVAILABLE") {
    reasons.push({ category: "DATA", reason: "Option chain unavailable", severity: "CRITICAL" });
  }
  if (ctx.optionChain.freshness === "STALE") {
    reasons.push({ category: "DATA", reason: "Option chain is stale", severity: "CRITICAL" });
  }
  if (ctx.optionChain.delayed) {
    reasons.push({ category: "DATA", reason: "Option chain is delayed — research only", severity: "CRITICAL" });
  }

  // Market status
  if (ctx.marketStatus === "WEEKEND") {
    reasons.push({ category: "MARKET", reason: "Market closed (weekend)", severity: "CRITICAL" });
  }
  if (ctx.marketStatus === "MARKET_CLOSED" && ctx.exchange === "NSE") {
    reasons.push({ category: "MARKET", reason: "NSE market closed", severity: "CRITICAL" });
  }

  // MCX-specific
  if (ctx.exchange === "MCX") {
    if (ctx.spot.delayed || ctx.optionChain.delayed) {
      reasons.push({
        category: "MCX",
        reason: "MCX data delayed — live trading blocked",
        severity: "CRITICAL",
        suggestion: "Use MOAPI or Breeze for live MCX data",
      });
    }

    // MCX Intelligence hard gates
    const intel = ctx.mcxIntelligence?.value;
    if (intel) {
      // Regime gate
      if (intel.regime === 'NO_TRADE' || intel.regime === 'HIGH_VOLATILITY') {
        reasons.push({
          category: "MCX_REGIME",
          reason: `MCX regime: ${intel.regime} — no trade`,
          severity: "CRITICAL",
        });
      }
      // Chain quality gate
      if (intel.chainQuality === 'UNTRADEABLE') {
        reasons.push({
          category: "MCX_CHAIN",
          reason: "MCX option chain UNTRADEABLE — no liquid contracts",
          severity: "CRITICAL",
        });
      }
      // OI divergence gate
      if (intel.oiDivergence) {
        reasons.push({
          category: "MCX_OI",
          reason: `MCX OI divergence: ${intel.oiClassification} — conflicting signals`,
          severity: "WARNING",
        });
      }
      // RR gate for MCX
      if (intel.bestCandidateRR > 0 && intel.bestCandidateRR < 1.2) {
        reasons.push({
          category: "MCX_RR",
          reason: `MCX RR ${intel.bestCandidateRR.toFixed(1)}:1 below MCX minimum (1.2)`,
          severity: "WARNING",
        });
      }
      // Extreme volatility gate
      if (intel.volatilityRegime === 'EXTREME_VOL') {
        reasons.push({
          category: "MCX_VOL",
          reason: "MCX extreme volatility — avoid option buying",
          severity: "CRITICAL",
        });
      }
      // IV crush risk
      if (intel.ivClassification === 'EXTREME') {
        reasons.push({
          category: "MCX_IV",
          reason: "MCX IV extremely elevated — options overpriced",
          severity: "WARNING",
        });
      }
      // Data freshness gate
      if (!intel.dataFreshness.candlesAvailable || intel.dataFreshness.candleCount < 10) {
        reasons.push({
          category: "MCX_DATA",
          reason: `MCX candle data insufficient (${intel.dataFreshness.candleCount} candles)`,
          severity: "CRITICAL",
        });
      }
    }
  }

  // VIX
  const vix = ctx.vix.value;
  if (vix > 30) {
    reasons.push({ category: "VOLATILITY", reason: `VIX very high (${vix.toFixed(1)}) — extreme risk`, severity: "CRITICAL" });
  }
  if (vix > 25) {
    reasons.push({ category: "VOLATILITY", reason: `VIX elevated (${vix.toFixed(1)}) — reduced confidence`, severity: "WARNING" });
  }

  // News risk
  const news = ctx.news.value;
  if (news?.score && Math.abs(news.score) > 70) {
    reasons.push({
      category: "NEWS",
      reason: `Strong opposing news sentiment (${news.score.toFixed(0)})`,
      severity: "WARNING",
      suggestion: "Wait for news to settle",
    });
  }

  // Liquidity
  const chain = ctx.optionChain.value;
  if (chain?.strikes) {
    const liquidStrikes = chain.strikes.filter(s =>
      ((s.ce?.volume || 0) + (s.pe?.volume || 0)) > 100
    );
    if (liquidStrikes.length < 3) {
      reasons.push({ category: "LIQUIDITY", reason: "Very few liquid strikes available", severity: "WARNING" });
    }
  }

  // Candidate-specific checks
  if (candidate) {
    // Spread
    if (candidate.entry > 0) {
      const entryRange = candidate.entryRange;
      if (entryRange && (entryRange.max - entryRange.min) / entryRange.min > 0.05) {
        reasons.push({ category: "SPREAD", reason: "Wide entry range — execution risk", severity: "WARNING" });
      }
    }

    // RR
    if (candidate.riskReward > 0 && candidate.riskReward < 1.5) {
      reasons.push({ category: "RISK", reason: `RR ${candidate.riskReward.toFixed(1)}:1 below minimum`, severity: "CRITICAL" });
    }

    // Score
    if (candidate.score < 50) {
      reasons.push({ category: "QUALITY", reason: `Score ${candidate.score}/100 below minimum`, severity: "CRITICAL" });
    }

    // Expected move
    if (chain?.expectedMove && candidate.tp1 > 0) {
      const spot = chain.spot || ctx.spot.value?.price || 0;
      if (spot > 0) {
        const targetMove = Math.abs(candidate.tp1 - candidate.entry);
        if (targetMove > chain.expectedMove * 1.5) {
          reasons.push({
            category: "TARGET",
            reason: "TP1 exceeds 1.5x expected move — unrealistic",
            severity: "WARNING",
          });
        }
      }
    }
  }

  // Data Health Gate — evaluate overall data quality
  try {
    const spotPrice = ctx.spot.value?.price || 0;
    const chain = ctx.optionChain.value;
    const strikes = chain?.strikes || [];
    const strikesWithMissing = strikes.filter(s =>
      !s.ce || !s.pe || s.ce.ltp <= 0 || s.pe.ltp <= 0
    ).length;
    const atmStrike = strikes.reduce((best, s) =>
      Math.abs(s.strike - spotPrice) < Math.abs(best.strike - spotPrice) ? s : best,
      strikes[0]
    );
    const atmHasGreeks = atmStrike ? Boolean(atmStrike.ce?.delta || atmStrike.pe?.delta) : false;

    const healthReport = evaluateDataHealth({
      latencyMs: 0,
      lastUpdateMs: ctx.spot.timestamp ? new Date(ctx.spot.timestamp).getTime() : Date.now(),
      totalStrikes: strikes.length,
      strikesWithMissingData: strikesWithMissing,
      atmHasGreeks,
      source: ctx.spot.value?.source || "unknown",
    });

    if (shouldBlockTrades(healthReport)) {
      reasons.push({
        category: "DATA_HEALTH",
        reason: `Data health ${healthReport.status} (score ${healthReport.score}/100) — trades blocked`,
        severity: "CRITICAL",
        suggestion: healthReport.issues.join("; ") || "Check data providers",
      });
    } else if (healthReport.status === "DEGRADED") {
      reasons.push({
        category: "DATA_HEALTH",
        reason: `Data health DEGRADED (score ${healthReport.score}/100)`,
        severity: "WARNING",
        suggestion: healthReport.issues.join("; "),
      });
    }
  } catch {
    // Data health evaluation is best-effort — don't block on internal errors
  }

  return reasons;
}

// ── Decision ───────────────────────────────────────────────────────────

export function shouldRejectTrade(reasons: NoTradeReason[]): boolean {
  return reasons.some(r => r.severity === "CRITICAL");
}

export function getCriticalReasons(reasons: NoTradeReason[]): NoTradeReason[] {
  return reasons.filter(r => r.severity === "CRITICAL");
}

export function getWarnings(reasons: NoTradeReason[]): NoTradeReason[] {
  return reasons.filter(r => r.severity === "WARNING");
}

export function formatNoTradeResponse(reasons: NoTradeReason[]): string {
  const critical = getCriticalReasons(reasons);
  const warnings = getWarnings(reasons);

  let response = "NO TRADE\n\n";

  if (critical.length > 0) {
    response += "Critical blockers:\n";
    for (const r of critical) {
      response += `  - ${r.reason}\n`;
    }
  }

  if (warnings.length > 0) {
    response += "\nWarnings:\n";
    for (const r of warnings) {
      response += `  - ${r.reason}\n`;
    }
  }

  return response;
}
