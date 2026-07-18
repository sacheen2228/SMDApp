// ─── Daily Trade Recommendation Engine (derivatives-driven) ───────────────
//
// Wraps the Institutional Derivatives Engine to emit a single DAILY trade
// recommendation: BUY_CALL / BUY_PUT / NO_TRADE, with full trade plan
// (entry, strike, SL, TP1/2/3), confidence, expected move, S/R and a complete
// reasoning built ONLY from Option Chain + Greeks + OI + PCR + IV + FII/DII.
//
// This is the derivatives-only equivalent of the SDM daily recommendation,
// reusing the same IDE decision logic so chat / UI / alerts never diverge.

import { runInstitutionalDerivativesEngine, type DerivativeInput, type IDESignal, type ChainContext, type StrikeLeg } from "./institutional-derivatives-engine";

export interface DailyDerivativesRecommendation {
  symbol: string;
  generatedAt: string;
  action: "BUY_CALL" | "BUY_PUT" | "NO_TRADE";
  strike: number | null;
  type: "CE" | "PE" | null;
  entry: number | null;
  stopLoss: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  confidence: number;
  expectedMove: number;
  expectedMovePct: number;
  support: number;
  resistance: number;
  supportStrength: number;
  resistanceStrength: number;
  callProbability: number;
  putProbability: number;
  reasoning: string[];
  engine: IDESignal;
}

export function buildDailyDerivativesRecommendation(
  symbol: string,
  input: DerivativeInput,
  opts?: { strikes?: { strike: number; type: "CE" | "PE"; leg: StrikeLeg }[]; ctx?: ChainContext; daysToExpiry?: number },
): DailyDerivativesRecommendation {
  const sig = runInstitutionalDerivativesEngine(symbol, input, opts);

  const reasoning: string[] = [];

  // Always-on context lines (derivatives only).
  reasoning.push(
    `ATM ${sig.raw.atm} — ATM CE ₹${sig.raw.ce.toFixed(1)}, ATM PE ₹${sig.raw.pe.toFixed(1)} → Expected Move ₹${sig.expectedMove} (${sig.expectedMovePct}% of spot).`,
  );
  reasoning.push(
    `Dynamic S/R from Expected Move: Support ₹${sig.support}, Resistance ₹${sig.resistance} (IV factor ${sig.raw.iv > 22 ? "1.20" : sig.raw.iv > 18 ? "1.10" : "1.00"}, Gamma ${sig.raw.gamma > 0.03 ? "boost" : "neutral"}, Volume ${sig.raw.volumeRatio > 1.5 ? "boost" : "neutral"}).`,
  );
  reasoning.push(
    `Oscillators: PCR ${sig.raw.pcr.toFixed(2)} | IV ${sig.raw.iv.toFixed(1)} | ATM Delta ${sig.raw.delta.toFixed(2)} | Gamma ${sig.raw.gamma.toFixed(3)} | Vega ${sig.raw.vega.toFixed(2)} | Theta ${sig.raw.theta.toFixed(2)}.`,
  );
  reasoning.push(
    `OI posture: highest Call OI ${sig.raw.highestCallOI.toLocaleString("en-IN")}, highest Put OI ${sig.raw.highestPutOI.toLocaleString("en-IN")} → Support strength ${sig.supportStrength}/100, Resistance strength ${sig.resistanceStrength}/100.`,
  );
  reasoning.push(
    `Flows: ${sig.raw.callWriting ? "Call writing" : sig.raw.callUnwind ? "Call OI unwinding" : "Call OI steady"}, ${sig.raw.putWriting ? "Put writing" : sig.raw.putUnwind ? "Put OI unwinding" : "Put OI steady"}; FII long ${sig.raw.fiiLong}% / short ${sig.raw.fiiShort}%, DII buy ${sig.raw.diiBuy}% / sell ${sig.raw.diiSell}%.`,
  );

  if (sig.decision === "BUY_CALL") {
    reasoning.push(`CALL setup confirmed: spot ${sig.raw.spot > sig.resistance ? "above resistance" : "at/near resistance"}, call OI unwinding, put writing increasing, PCR ${sig.raw.pcr > 1 ? "rising" : " supportive"}, delta positive, gamma & vega expanding, volume ${sig.raw.volumeRatio > 1.5 ? ">1.5× (confirmed)" : "low"}. CE probability ${sig.callProbability}%.`);
    reasoning.push(`Plan: BUY ${sig.recommendedType} @ strike ${sig.recommendedStrike}, entry ₹${sig.entry}, SL ₹${sig.stopLoss}, TP1 ₹${sig.target1} / TP2 ₹${sig.target2} / TP3 ₹${sig.target3}.`);
  } else if (sig.decision === "BUY_PUT") {
    reasoning.push(`PUT setup confirmed: spot ${sig.raw.spot < sig.support ? "below support" : "at/near support"}, put OI unwinding, call writing increasing, PCR ${sig.raw.pcr < 1 ? "falling" : " supportive"}, delta negative, gamma & vega expanding, volume ${sig.raw.volumeRatio > 1.5 ? ">1.5× (confirmed)" : "low"}. PE probability ${sig.putProbability}%.`);
    reasoning.push(`Plan: BUY ${sig.recommendedType} @ strike ${sig.recommendedStrike}, entry ₹${sig.entry}, SL ₹${sig.stopLoss}, TP1 ₹${sig.target1} / TP2 ₹${sig.target2} / TP3 ₹${sig.target3}.`);
  } else {
    reasoning.push(`NO TRADE: ${sig.reasons.join("; ")}. Engine waits for price to break the Expected-Move band with confirming OI/FII/DII flow before initiating.`);
  }

  return {
    symbol,
    generatedAt: new Date().toISOString(),
    action: sig.decision,
    strike: sig.recommendedStrike,
    type: sig.recommendedType,
    entry: sig.entry,
    stopLoss: sig.stopLoss,
    tp1: sig.target1,
    tp2: sig.target2,
    tp3: sig.target3,
    confidence: sig.confidence,
    expectedMove: sig.expectedMove,
    expectedMovePct: sig.expectedMovePct,
    support: sig.support,
    resistance: sig.resistance,
    supportStrength: sig.supportStrength,
    resistanceStrength: sig.resistanceStrength,
    callProbability: sig.callProbability,
    putProbability: sig.putProbability,
    reasoning,
    engine: sig,
  };
}
