// Strike Selector
// Selects optimal strike for option buying (CE/PE) from option chain.
// Evaluates: delta, gamma, theta, IV, spread, volume, OI, liquidity.
// Option buying ONLY — never selling.

import type { SDMOptionStrike } from '@/types/sdm';

// ─── Types ─────────────────────────────────────────────────────────

export type OptionSide = "CE" | "PE";

export interface StrikeScore {
  strike: number;
  score: number;         // 0-100
  side: OptionSide;
  reasons: string[];
  premium: number;
  delta: number;
  theta: number;
  iv: number;
  spread: number;
  volume: number;
  oi: number;
  moneyness: "ATM" | "ITM" | "OTM";
}

export interface StrikeSelectionResult {
  best: StrikeScore | null;
  alternatives: StrikeScore[];
  spot: number;
  totalStrikesEvaluated: number;
  selectionCriteria: string;
}

// ─── Helpers ───────────────────────────────────────────────────────

function classifyMoneyness(strike: number, spot: number, side: OptionSide): "ATM" | "ITM" | "OTM" {
  const diff = Math.abs(strike - spot);
  const pctDiff = spot > 0 ? diff / spot * 100 : 999;

  if (pctDiff < 0.3) return "ATM";
  if (side === "CE") {
    return strike < spot ? "ITM" : "OTM";
  } else {
    return strike > spot ? "ITM" : "OTM";
  }
}

// ─── Scoring Engine ────────────────────────────────────────────────

function scoreStrike(
  strike: SDMOptionStrike,
  side: OptionSide,
  spot: number,
  direction: "BULLISH" | "BEARISH",
): StrikeScore {
  const data = side === "CE" ? strike.ce : strike.pe;
  const reasons: string[] = [];
  let score = 0;

  if (!data) {
    return {
      strike: strike.strike,
      score: 0,
      side,
      reasons: ["No data for this strike"],
      premium: 0,
      delta: 0,
      theta: 0,
      iv: 0,
      spread: 999,
      volume: 0,
      oi: 0,
      moneyness: classifyMoneyness(strike.strike, spot, side),
    };
  }

  const moneyness = classifyMoneyness(strike.strike, spot, side);
  const spread = data.ask && data.bid ? data.ask - data.bid : data.ltp * 0.02;
  const spreadPercent = data.ltp > 0 ? (spread / data.ltp) * 100 : 999;

  // Delta (weight: 25) — higher delta = more responsive, but not too high (ITM)
  if (moneyness === "ATM") {
    score += 20;
    reasons.push(`ATM strike — optimal delta ${data.delta.toFixed(2)}`);
  } else if (moneyness === "OTM") {
    const deltaScore = data.delta >= 0.3 && data.delta <= 0.5 ? 25
      : data.delta > 0.2 ? 15
      : data.delta > 0.1 ? 10
      : 5;
    score += deltaScore;
    reasons.push(`OTM delta ${data.delta.toFixed(2)} (+${deltaScore})`);
  } else {
    score += 12;
    reasons.push(`ITM delta ${data.delta.toFixed(2)} — higher premium (+12)`);
  }

  // Theta decay (weight: 20) — lower theta = slower decay for option buyer
  const thetaPerDay = Math.abs(data.theta);
  const thetaRatio = data.ltp > 0 ? thetaPerDay / data.ltp * 100 : 999;
  if (thetaRatio < 1) { score += 20; reasons.push(`Low theta decay ${thetaRatio.toFixed(1)}% (+20)`); }
  else if (thetaRatio < 2) { score += 15; reasons.push(`Moderate theta ${thetaRatio.toFixed(1)}% (+15)`); }
  else if (thetaRatio < 3) { score += 10; reasons.push(`Theta ${thetaRatio.toFixed(1)}% (+10)`); }
  else { score += 5; reasons.push(`High theta ${thetaRatio.toFixed(1)}% (+5)`); }

  // IV percentile (weight: 15) — prefer moderate IV (not too high, not too low)
  if (data.iv > 0 && data.iv < 25) { score += 15; reasons.push(`Low IV ${data.iv.toFixed(0)}% — cheap premium (+15)`); }
  else if (data.iv >= 25 && data.iv < 40) { score += 12; reasons.push(`Moderate IV ${data.iv.toFixed(0)}% (+12)`); }
  else if (data.iv >= 40 && data.iv < 60) { score += 8; reasons.push(`Elevated IV ${data.iv.toFixed(0)}% (+8)`); }
  else if (data.iv >= 60) { score += 3; reasons.push(`High IV ${data.iv.toFixed(0)}% — expensive (+3)`); }

  // Spread (weight: 15) — tighter is better for entry/exit
  if (spreadPercent < 2) { score += 15; reasons.push(`Tight spread ${spreadPercent.toFixed(1)}% (+15)`); }
  else if (spreadPercent < 5) { score += 10; reasons.push(`Spread ${spreadPercent.toFixed(1)}% (+10)`); }
  else if (spreadPercent < 10) { score += 5; reasons.push(`Wide spread ${spreadPercent.toFixed(1)}% (+5)`); }
  else { reasons.push(`Very wide spread ${spreadPercent.toFixed(1)}% — poor liquidity`); }

  // Volume (weight: 15) — higher volume = better liquidity
  if (data.volume > 100000) { score += 15; reasons.push(`Very high volume ${data.volume} (+15)`); }
  else if (data.volume > 50000) { score += 12; reasons.push(`High volume ${data.volume} (+12)`); }
  else if (data.volume > 10000) { score += 8; reasons.push(`Volume ${data.volume} (+8)`); }
  else if (data.volume > 1000) { score += 4; reasons.push(`Low volume ${data.volume} (+4)`); }
  else { reasons.push(`Very low volume ${data.volume} — avoid`); }

  // OI (weight: 10) — higher OI = more participation, better exit
  if (data.oi > 500000) { score += 10; reasons.push(`Very high OI ${data.oi} (+10)`); }
  else if (data.oi > 100000) { score += 7; reasons.push(`High OI ${data.oi} (+7)`); }
  else if (data.oi > 10000) { score += 4; reasons.push(`OI ${data.oi} (+4)`); }
  else { reasons.push(`Low OI ${data.oi}`); }

  return {
    strike: strike.strike,
    score: Math.min(100, score),
    side,
    reasons,
    premium: data.ltp,
    delta: data.delta,
    theta: data.theta,
    iv: data.iv,
    spread,
    volume: data.volume,
    oi: data.oi,
    moneyness,
  };
}

// ─── Main Entry Point ──────────────────────────────────────────────

export function selectOptimalStrike(
  strikes: SDMOptionStrike[],
  direction: "BULLISH" | "BEARISH",
  spot: number,
): StrikeSelectionResult {
  if (!strikes || strikes.length === 0 || spot <= 0) {
    return {
      best: null,
      alternatives: [],
      spot,
      totalStrikesEvaluated: 0,
      selectionCriteria: "No strikes or spot available",
    };
  }

  // Only CE for BULLISH, only PE for BEARISH (option buying only)
  const side: OptionSide = direction === "BULLISH" ? "CE" : "PE";

  // Filter strikes with data on the relevant side
  const validStrikes = strikes.filter(s => side === "CE" ? s.ce !== null : s.pe !== null);

  // Score all valid strikes
  const scored = validStrikes.map(s => scoreStrike(s, side, spot, direction));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0] || null;
  const alternatives = scored.slice(1, 5); // top 4 alternatives

  return {
    best,
    alternatives,
    spot,
    totalStrikesEvaluated: scored.length,
    selectionCriteria: [
      `Direction: ${direction}`,
      `Side: ${side}`,
      `Spot: ${spot}`,
      `Criteria: delta(25) + theta(20) + IV(15) + spread(15) + volume(15) + OI(10)`,
    ].join("; "),
  };
}
