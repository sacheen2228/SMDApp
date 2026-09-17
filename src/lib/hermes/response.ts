// Hermes Response — formats HermesDecision into structured output
// Trade card, no-trade card, research card.

import type { HermesDecision, TradeCandidate, Decision } from "./types";

// ── Main Formatter ─────────────────────────────────────────────────────

export function formatHermesDecision(decision: HermesDecision): string {
  switch (decision.decision) {
    case "BUY_CE":
    case "BUY_PE":
      return formatTradeCard(decision);
    case "NO_TRADE":
      return formatNoTradeCard(decision);
    case "RESEARCH_ONLY":
      return formatResearchCard(decision);
    default:
      return decision.explanation;
  }
}

// ── Trade Card ─────────────────────────────────────────────────────────

function formatTradeCard(decision: HermesDecision): string {
  const c = decision.candidate;
  if (!c) return decision.explanation;

  const lines: string[] = [];

  lines.push(`${decision.decision === "BUY_CE" ? "CE BUY" : "PE BUY"}`);
  lines.push("");
  lines.push(`${c.symbol} — ${c.exchange}`);
  lines.push("");
  lines.push(`Strike: ₹${c.strike.toLocaleString("en-IN")} ${c.optionSide}`);
  lines.push(`Expiry: ${c.expiry}`);
  lines.push("");
  lines.push(`Entry: ₹${c.entry.toFixed(2)}`);
  lines.push(`SL: ₹${c.stopLoss.toFixed(2)}`);
  lines.push(`TP1: ₹${c.tp1.toFixed(2)}`);
  lines.push(`TP2: ₹${c.tp2.toFixed(2)}`);
  lines.push(`TP3: ₹${c.tp3.toFixed(2)}`);
  lines.push("");
  lines.push(`RR: ${c.riskReward.toFixed(1)}:1`);
  lines.push(`Score: ${c.score}/100 (Grade ${c.grade})`);
  lines.push(`Confidence: ${c.confidence}%`);
  lines.push("");
  lines.push(`Regime: ${decision.marketRegime}`);
  lines.push("");

  if (c.reasons.length > 0) {
    lines.push("Why:");
    for (const r of c.reasons.slice(0, 5)) {
      lines.push(`• ${r}`);
    }
    lines.push("");
  }

  if (c.risks.length > 0) {
    lines.push("Risks:");
    for (const r of c.risks.slice(0, 3)) {
      lines.push(`• ${r}`);
    }
    lines.push("");
  }

  lines.push(`Invalidation: ${c.invalidation.join("; ")}`);
  lines.push("");
  lines.push(`Data: ${decision.dataQuality.status}`);
  lines.push(`Source: ${decision.dataQuality.provider}`);
  lines.push(`Age: ${(decision.dataQuality.ageMs / 1000).toFixed(0)}s`);

  return lines.join("\n");
}

// ── No Trade Card ──────────────────────────────────────────────────────

function formatNoTradeCard(decision: HermesDecision): string {
  const lines: string[] = [];

  lines.push("NO TRADE");
  lines.push("");
  lines.push(decision.explanation);
  lines.push("");
  lines.push(`Data Health: ${decision.dataHealth}%`);
  lines.push(`Market: ${decision.marketRegime}`);

  if (decision.validation.failures.length > 0) {
    lines.push("");
    lines.push("Validation failures:");
    for (const f of decision.validation.failures) {
      lines.push(`• ${f}`);
    }
  }

  if (decision.validation.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of decision.validation.warnings) {
      lines.push(`• ${w}`);
    }
  }

  return lines.join("\n");
}

// ── Research Card ──────────────────────────────────────────────────────

function formatResearchCard(decision: HermesDecision): string {
  const lines: string[] = [];

  lines.push("RESEARCH");
  lines.push("");
  lines.push(decision.explanation);
  lines.push("");
  lines.push(`Data: ${decision.dataQuality.status}`);
  lines.push(`Source: ${decision.dataQuality.provider}`);

  return lines.join("\n");
}
