// Hermes Explainer — generates evidence-based explanations from deterministic data
// Never invents reasons. Only explains what the data shows.

import type { TradeCandidate, ScoreResult, HermesContext, ScoreBreakdown } from "./types";

// ── Explanation Generator ──────────────────────────────────────────────

export function generateExplanation(
  candidate: TradeCandidate,
  score: ScoreResult,
  ctx: HermesContext
): string {
  const parts: string[] = [];

  // Main recommendation
  parts.push(`${candidate.symbol} — ${candidate.optionSide} BUY`);
  parts.push(`Strike: ₹${candidate.strike.toLocaleString("en-IN")} ${candidate.optionSide}`);
  parts.push(`Entry: ₹${candidate.entry.toFixed(2)}`);
  parts.push(`SL: ₹${candidate.stopLoss.toFixed(2)}`);
  parts.push(`TP1: ₹${candidate.tp1.toFixed(2)}`);
  parts.push(`TP2: ₹${candidate.tp2.toFixed(2)}`);
  parts.push(`TP3: ₹${candidate.tp3.toFixed(2)}`);
  parts.push(`RR: ${candidate.riskReward.toFixed(1)}:1`);
  parts.push(`Score: ${candidate.score}/100 (Grade ${candidate.grade})`);
  parts.push("");

  // Evidence (strongest factors)
  parts.push("Why:");
  const strongFactors = score.breakdown
    .filter(b => b.score >= 60 && b.available)
    .sort((a, b) => b.weighted - a.weighted)
    .slice(0, 5);

  if (strongFactors.length > 0) {
    for (const f of strongFactors) {
      parts.push(`  • ${f.reason}`);
    }
  } else {
    parts.push("  • No strong confirming factors found");
  }

  // Risks
  const weakFactors = score.breakdown
    .filter(b => b.score < 40 && b.available)
    .sort((a, b) => a.weighted - b.weighted)
    .slice(0, 3);

  if (weakFactors.length > 0) {
    parts.push("");
    parts.push("Risks:");
    for (const f of weakFactors) {
      parts.push(`  • ${f.reason}`);
    }
  }

  // Invalidation
  parts.push("");
  parts.push(`Invalidation: ${candidate.invalidation.join("; ")}`);

  // Data quality
  parts.push("");
  parts.push(`Data: ${ctx.spot.freshness} (Source: ${ctx.spot.source})`);

  return parts.join("\n");
}

// ── Evidence Summary ───────────────────────────────────────────────────

export function formatEvidence(breakdown: ScoreBreakdown[]): string {
  const lines: string[] = [];

  lines.push("Evidence Summary:");
  lines.push("");

  for (const b of breakdown) {
    const indicator = b.score >= 70 ? "+" : b.score < 40 ? "-" : "~";
    lines.push(`  ${indicator} ${b.factor}: ${b.score}/100 (weight: ${b.weight}) — ${b.reason}`);
  }

  return lines.join("\n");
}

// ── Quick Summary ──────────────────────────────────────────────────────

export function formatQuickSummary(ctx: HermesContext): string {
  const spot = ctx.spot.value?.price || 0;
  const change = ctx.spot.value?.changePct || 0;
  const vix = ctx.vix.value;

  return [
    `${ctx.symbol}: ₹${spot.toLocaleString("en-IN")} (${change >= 0 ? "+" : ""}${change.toFixed(2)}%)`,
    `VIX: ${vix?.toFixed(1) || "N/A"}`,
    `Market: ${ctx.marketStatus}`,
    `Data: ${ctx.spot.freshness}`,
  ].join(" | ");
}
