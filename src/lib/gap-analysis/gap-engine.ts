import {
  GapInput, GapPrediction, GapWeights, DEFAULT_WEIGHTS,
  FactorContribution, GapDirection, DataAvailability,
  HistoricalRecord, ValidationResult,
} from "./types";

function norm(val: number | null, defaultVal: number = 0): number {
  return val !== null && val !== undefined && isFinite(val) ? val : defaultVal;
}

function avail(val: number | null): DataAvailability {
  return val !== null && val !== undefined && isFinite(val) ? "AVAILABLE" : "MISSING";
}

// ─── Factor Calculators ─────────────────────────────────────────
// Each returns { score: number in [-100, +100], explanation: string, dataStatus }

function factorGiftNifty(giftPrice: number | null, prevClose: number | null): { score: number; explanation: string; dataStatus: DataAvailability } {
  if (giftPrice === null || prevClose === null || prevClose === 0) {
    return { score: 0, explanation: "Gift Nifty data unavailable", dataStatus: "MISSING" };
  }
  const gapPct = ((giftPrice - prevClose) / prevClose) * 100;
  const score = Math.max(-100, Math.min(100, gapPct * 60));
  const dir = gapPct > 0 ? "premium" : "discount";
  return {
    score,
    explanation: `Gift Nifty ${giftPrice.toFixed(2)} vs prev close ${prevClose.toFixed(2)} (${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(2)}%) → ${dir} signal`,
    dataStatus: "AVAILABLE",
  };
}

function factorFuturesPremium(futures: number | null, spot: number | null): { score: number; explanation: string; dataStatus: DataAvailability } {
  if (futures === null || spot === null || spot === 0) {
    return { score: 0, explanation: "Futures premium data unavailable", dataStatus: "MISSING" };
  }
  const premiumPct = ((futures - spot) / spot) * 100;
  const score = Math.max(-100, Math.min(100, premiumPct * 300));
  const dir = premiumPct > 0 ? "bullish premium" : "bearish discount";
  return {
    score,
    explanation: `Futures ${futures.toFixed(2)} - Spot ${spot.toFixed(2)} = ${premiumPct >= 0 ? "+" : ""}${premiumPct.toFixed(3)}% → ${dir}`,
    dataStatus: "AVAILABLE",
  };
}

function factorPCR(pcrOI: number | null): { score: number; explanation: string; dataStatus: DataAvailability } {
  if (pcrOI === null || !isFinite(pcrOI)) {
    return { score: 0, explanation: "PCR OI unavailable", dataStatus: "MISSING" };
  }
  // PCR > 1.2 = put heavy (bearish sentiment against market = potential gap down)
  // PCR < 0.8 = call heavy (bullish sentiment = potential gap up)
  // Scale: -100 when PCR very high (>2), +100 when PCR very low (<0.5)
  const neutral = 1.1;
  const diff = (neutral - pcrOI) / 0.5;
  const score = Math.max(-100, Math.min(100, diff * 80));
  const dir = score > 0 ? "bullish (call writing)" : "bearish (put writing)";
  return {
    score,
    explanation: `PCR OI ${pcrOI.toFixed(2)} → ${dir}`,
    dataStatus: "AVAILABLE",
  };
}

function factorOIBuildup(ceOIChg: number | null, peOIChg: number | null): { score: number; explanation: string; dataStatus: DataAvailability } {
  if (ceOIChg === null || peOIChg === null) {
    return { score: 0, explanation: "OI Buildup data unavailable", dataStatus: "MISSING" };
  }
  // Positive = more PE buildup (bullish for gap up), negative = more CE buildup (bearish for gap down)
  const net = peOIChg - ceOIChg;
  const score = Math.max(-100, Math.min(100, net * 2));
  const dir = net > 0 ? "PE buildup" : "CE buildup";
  return {
    score,
    explanation: `PE OI chg ${peOIChg >= 0 ? "+" : ""}${peOIChg.toFixed(0)} | CE OI chg ${ceOIChg >= 0 ? "+" : ""}${ceOIChg.toFixed(0)} → ${dir}`,
    dataStatus: "AVAILABLE",
  };
}

function factorMaxPain(spot: number | null, maxPain: number | null): { score: number; explanation: string; dataStatus: DataAvailability } {
  if (spot === null || maxPain === null || spot === 0) {
    return { score: 0, explanation: "Max Pain data unavailable", dataStatus: "MISSING" };
  }
  const diffPct = ((spot - maxPain) / spot) * 100;
  // Spot above max pain → bullish gravity toward max pain = potential gap down
  // Spot below max pain → bearish gravity toward max pain = potential gap up
  const score = Math.max(-100, Math.min(100, -diffPct * 150));
  const dir = score > 0 ? "bullish (spot below max pain)" : score < 0 ? "bearish (spot above max pain)" : "neutral";
  return {
    score,
    explanation: `Spot ${spot.toFixed(2)} vs Max Pain ${maxPain.toFixed(2)} (${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(2)}%) → ${dir}`,
    dataStatus: "AVAILABLE",
  };
}

function factorVWAP(vwapDist: number | null): { score: number; explanation: string; dataStatus: DataAvailability } {
  if (vwapDist === null) {
    return { score: 0, explanation: "VWAP distance unavailable", dataStatus: "MISSING" };
  }
  const score = Math.max(-100, Math.min(100, -vwapDist * 50));
  const dir = score > 0 ? "below VWAP (reversion up)" : "above VWAP (reversion down)";
  return {
    score,
    explanation: `VWAP distance ${vwapDist >= 0 ? "+" : ""}${vwapDist.toFixed(3)}% → ${dir}`,
    dataStatus: "AVAILABLE",
  };
}

function factorATR(atr: number | null, spot: number | null): { score: number; explanation: string; dataStatus: DataAvailability } {
  if (atr === null || spot === null || spot === 0) {
    return { score: 0, explanation: "ATR data unavailable", dataStatus: "MISSING" };
  }
  const atrPct = (atr / spot) * 100;
  // High ATR = more uncertainty = wider gaps probable but direction uncertain → neutral
  // Low ATR = low volatility = smaller gaps
  const score = Math.max(-30, Math.min(30, (atrPct - 1) * 20));
  const dir = atrPct > 1.5 ? "high volatility" : atrPct < 0.5 ? "low volatility" : "normal";
  return {
    score: 0, // ATR influences confidence more than direction
    explanation: `ATR ${atr.toFixed(2)} (${atrPct.toFixed(2)}% of spot) → ${dir}`,
    dataStatus: "AVAILABLE",
  };
}

function factorVIX(vix: number | null): { score: number; explanation: string; dataStatus: DataAvailability } {
  if (vix === null) {
    return { score: 0, explanation: "VIX data unavailable", dataStatus: "MISSING" };
  }
  // VIX < 12 = complacency, VIX > 25 = fear
  // High VIX = gap-down risk, Very low VIX = potential gap-up
  const neutral = 15;
  // Negative: VIX above neutral increases gap-down risk
  let score: number;
  if (vix > neutral) {
    score = Math.max(-80, -(vix - neutral) * 5);
  } else {
    score = Math.min(60, (neutral - vix) * 6);
  }
  const dir = vix > 25 ? "extreme fear (gap down risk)" : vix > 18 ? "elevated fear" : vix < 12 ? "complacency" : "normal";
  return {
    score,
    explanation: `India VIX ${vix.toFixed(2)} → ${dir}`,
    dataStatus: "AVAILABLE",
  };
}

function factorBreadth(breadth: number | null): { score: number; explanation: string; dataStatus: DataAvailability } {
  if (breadth === null) {
    return { score: 0, explanation: "Breadth data unavailable", dataStatus: "MISSING" };
  }
  // Breadth = advance / decline ratio. >1.5 = strong, <0.67 = weak
  const score = Math.max(-100, Math.min(100, (breadth - 1) * 80));
  const dir = breadth > 1.3 ? "broad participation" : breadth < 0.7 ? "narrow participation" : "neutral";
  return {
    score,
    explanation: `Breadth ${breadth.toFixed(2)}:1 → ${dir}`,
    dataStatus: "AVAILABLE",
  };
}

function factorGlobalCues(
  usMarket: number | null,
  asianMarket: number | null
): { score: number; explanation: string; dataStatus: DataAvailability } {
  const parts: string[] = [];
  let score = 0;
  let dataStatus: DataAvailability = "MISSING";

  if (usMarket !== null) {
    const usScore = Math.max(-50, Math.min(50, usMarket * 200));
    score += usScore * 0.6;
    parts.push(`US ${usMarket >= 0 ? "+" : ""}${usMarket.toFixed(2)}%`);
    dataStatus = "AVAILABLE";
  } else {
    parts.push("US N/A");
  }

  if (asianMarket !== null) {
    const asScore = Math.max(-50, Math.min(50, asianMarket * 200));
    score += asScore * 0.4;
    parts.push(`Asia ${asianMarket >= 0 ? "+" : ""}${asianMarket.toFixed(2)}%`);
    dataStatus = dataStatus === "AVAILABLE" ? "AVAILABLE" : "MISSING";
  } else {
    parts.push("Asia N/A");
  }

  const dir = score > 0 ? "supportive" : score < 0 ? "negative" : "neutral";
  return {
    score: Math.round(score),
    explanation: `Global cues: ${parts.join(", ")} → ${dir}`,
    dataStatus,
  };
}

function factorExpectedMove(iv: number | null, spot: number | null): { score: number; explanation: string; dataStatus: DataAvailability } {
  if (iv === null || spot === null || spot === 0) {
    return { score: 0, explanation: "Option IV data unavailable", dataStatus: "MISSING" };
  }
  // Expected move = ±IV * sqrt(1/365) * spot ≈ IV% * 0.052 * spot
  // ATM IV ≈ expected daily move %
  const expectedMovePct = iv / 100 * 0.052;
  const score = 0; // Expected move doesn't give direction, just magnitude
  return {
    score,
    explanation: `ATM IV ${iv.toFixed(1)}% → expected daily move ±${(expectedMovePct * 100).toFixed(2)}%`,
    dataStatus: "AVAILABLE",
  };
}

function factorHistoricalStats(
  hist: { gapUpProb: number; gapDownProb: number; last20Accuracy: number; totalSamples: number } | null
): { score: number; explanation: string; dataStatus: DataAvailability } {
  if (!hist || hist.totalSamples < 10) {
    if (hist && hist.totalSamples > 0) {
      return { score: 0, explanation: `Only ${hist.totalSamples} historical samples (insufficient)`, dataStatus: "ESTIMATED" };
    }
    return { score: 0, explanation: "Historical gap stats unavailable", dataStatus: "MISSING" };
  }
  // Bias toward the historically more likely direction
  const netBias = hist.gapUpProb - hist.gapDownProb; // -1 to +1
  const accuracyWeight = Math.min(1, hist.last20Accuracy / 100 * 2);
  const score = Math.max(-100, Math.min(100, netBias * 80 * accuracyWeight));
  const dir = score > 0 ? "historically gaps up more" : score < 0 ? "historically gaps down more" : "neutral";
  return {
    score,
    explanation: `Historical: ${(hist.gapUpProb * 100).toFixed(0)}% up / ${(hist.gapDownProb * 100).toFixed(0)}% down (${hist.totalSamples} sessions, last20 acc ${hist.last20Accuracy.toFixed(0)}%) → ${dir}`,
    dataStatus: "AVAILABLE",
  };
}

// ─── Main Prediction ────────────────────────────────────────────

export function predictGap(input: GapInput, weights: GapWeights = DEFAULT_WEIGHTS): GapPrediction {
  const missingFields: string[] = [];
  const factors: FactorContribution[] = [];

  // 1. Gift Nifty
  const f1 = factorGiftNifty(input.giftNiftyPrice, input.prevClose);
  if (f1.dataStatus === "MISSING" && input.prevClose === null) missingFields.push("PreviousClose");
  if (input.giftNiftyPrice === null) missingFields.push("GiftNifty");
  factors.push({ ...f1, name: "Gift Nifty", weight: weights.giftNifty, weightedScore: f1.score * weights.giftNifty });

  // 2. Futures Premium
  const f2 = factorFuturesPremium(input.currentFutures, input.currentSpot);
  if (f2.dataStatus === "MISSING") { if (input.currentFutures === null) missingFields.push("Futures"); if (input.currentSpot === null) missingFields.push("Spot"); }
  factors.push({ ...f2, name: "Futures Premium", weight: weights.futuresPremium, weightedScore: f2.score * weights.futuresPremium });

  // 3. PCR OI
  const f3 = factorPCR(input.pcrOI);
  if (f3.dataStatus === "MISSING") missingFields.push("PCR");
  factors.push({ ...f3, name: "PCR OI", weight: weights.pcrOI, weightedScore: f3.score * weights.pcrOI });

  // 4. OI Buildup
  const f4 = factorOIBuildup(input.ceOIChange, input.peOIChange);
  if (f4.dataStatus === "MISSING") missingFields.push("OIChange");
  factors.push({ ...f4, name: "OI Buildup", weight: weights.oiBuildup, weightedScore: f4.score * weights.oiBuildup });

  // 5. Max Pain Distance
  const f5 = factorMaxPain(input.currentSpot, input.maxPain);
  if (f5.dataStatus === "MISSING") missingFields.push("MaxPain");
  factors.push({ ...f5, name: "Max Pain", weight: weights.maxPainDistance, weightedScore: f5.score * weights.maxPainDistance });

  // 6. VWAP Distance
  const f6 = factorVWAP(input.vwapDistance);
  if (f6.dataStatus === "MISSING") missingFields.push("VWAP");
  factors.push({ ...f6, name: "VWAP", weight: weights.vwapDistance, weightedScore: f6.score * weights.vwapDistance });

  // 7. ATR
  const f7 = factorATR(input.atr, input.currentSpot);
  factors.push({ ...f7, name: "ATR", weight: weights.atr, weightedScore: f7.score * weights.atr });

  // 8. VIX
  const f8 = factorVIX(input.indiaVIX);
  if (f8.dataStatus === "MISSING") missingFields.push("VIX");
  factors.push({ ...f8, name: "India VIX", weight: weights.vix, weightedScore: f8.score * weights.vix });

  // 9. Breadth
  const f9 = factorBreadth(input.breadth);
  if (f9.dataStatus === "MISSING") missingFields.push("Breadth");
  factors.push({ ...f9, name: "Breadth", weight: weights.breadth, weightedScore: f9.score * weights.breadth });

  // 10. Global Cues
  const f10 = factorGlobalCues(input.usMarketChange, input.asianMarketChange);
  factors.push({ ...f10, name: "Global Cues", weight: weights.globalCues, weightedScore: f10.score * weights.globalCues });

  // 11. Expected Move
  const f11 = factorExpectedMove(input.optionIV, input.currentSpot);
  factors.push({ ...f11, name: "Expected Move", weight: weights.expectedMove, weightedScore: f11.score * weights.expectedMove });

  // 12. Historical Stats
  const f12 = factorHistoricalStats(input.historicalGapStats);
  factors.push({ ...f12, name: "Historical Stats", weight: weights.historicalStats, weightedScore: f12.score * weights.historicalStats });

  // ─── Check for INSUFFICIENT DATA ─────────────────────────────
  const essentialMissing = ["PreviousClose", "GiftNifty"].filter(f => missingFields.includes(f));
  const hasGiftNifty = input.giftNiftyPrice !== null;
  const hasPrevClose = input.prevClose !== null;

  if (!hasPrevClose || !hasGiftNifty) {
    return {
      prediction: "FLAT",
      probability: 0,
      confidence: 0,
      maxConfidence: 100,
      confidenceCapped: false,
      insufficientData: true,
      missingFields: [...new Set(missingFields)],
      score: 0,
      factors,
      bullScore: 0,
      bearScore: 0,
      neutralScore: 100,
    };
  }

  // ─── Compute total score ─────────────────────────────────────
  const totalScore = factors.reduce((s, f) => s + f.weightedScore, 0);
  // Rescale to [-100, +100] range (12 factors, each -100..+100 with weights summing to 1.0)
  const normalizedScore = Math.max(-100, Math.min(100, totalScore));

  // ─── Direction ───────────────────────────────────────────────
  let prediction: GapDirection;
  const upThreshold = 15;
  const downThreshold = -15;
  if (normalizedScore > upThreshold) prediction = "UP";
  else if (normalizedScore < downThreshold) prediction = "DOWN";
  else prediction = "FLAT";

  // ─── Probability ──────────────────────────────────────────────
  // Map score [-100, +100] → probability [0, 100] for UP direction
  // Sigmoid-like: 50 + score * 0.5 (approximately logistic with slope 0.5)
  let probability: number;
  if (prediction === "UP") {
    probability = 50 + (normalizedScore - upThreshold) * 0.8;
    probability = Math.max(51, Math.min(98, probability));
  } else if (prediction === "DOWN") {
    probability = 50 + (-normalizedScore - Math.abs(downThreshold)) * 0.8;
    probability = Math.max(51, Math.min(98, probability));
  } else {
    probability = 50 - Math.abs(normalizedScore) * 1.5;
    probability = Math.max(30, Math.min(60, probability));
  }

  // ─── Confidence ──────────────────────────────────────────────
  let confidence = Math.min(95, Math.abs(normalizedScore) * 1.2 + 10);

  // Cap confidence based on historical accuracy if available
  let maxConfidence = 95;
  let confidenceCapped = false;
  if (input.historicalGapStats && input.historicalGapStats.totalSamples >= 20) {
    const histAcc = input.historicalGapStats.last20Accuracy;
    maxConfidence = Math.min(95, Math.round(histAcc * 1.15));
    if (confidence > maxConfidence) {
      confidence = maxConfidence;
      confidenceCapped = true;
    }
  }

  confidence = Math.round(Math.max(5, Math.min(maxConfidence, confidence)));

  // ─── Bull/Bear/Neutral scores ────────────────────────────────
  const bullScore = factors.filter(f => f.score > 0).reduce((s, f) => s + f.weightedScore, 0);
  const bearScore = factors.filter(f => f.score < 0).reduce((s, f) => s + f.weightedScore, 0);
  const neutralScore = bullScore + bearScore; // bearScore is negative

  return {
    prediction,
    probability: Math.round(probability),
    confidence,
    maxConfidence,
    confidenceCapped,
    insufficientData: false,
    missingFields: [...new Set(missingFields)],
    score: Math.round(normalizedScore),
    factors: factors.map(f => ({
      ...f,
      score: Math.round(f.score),
      weightedScore: Math.round(f.weightedScore * 10) / 10,
    })),
    bullScore: Math.round(bullScore),
    bearScore: Math.round(bearScore),
    neutralScore: Math.round(Math.abs(neutralScore)),
  };
}

// ─── Historical Validation ──────────────────────────────────────

export function validatePredictions(records: HistoricalRecord[]): ValidationResult {
  const total = records.length;
  if (total === 0) {
    return {
      total: 0, correct: 0, incorrect: 0, accuracy: 0, precision: 0, recall: 0, f1: 0,
      confusionMatrix: { upTP: 0, upFP: 0, upFN: 0, downTP: 0, downFP: 0, downFN: 0, flatTP: 0, flatFP: 0, flatFN: 0 },
      avgError: 0, maxError: 0, worstPredictions: [], bestPredictions: [],
      byDirection: { UP: { total: 0, correct: 0, accuracy: 0 }, FLAT: { total: 0, correct: 0, accuracy: 0 }, DOWN: { total: 0, correct: 0, accuracy: 0 } },
    };
  }

  const labeled = records.filter(r => r.correct !== null);
  const correct = labeled.filter(r => r.correct).length;
  const incorrect = labeled.filter(r => !r.correct).length;

  // Confusion matrix: among predictions (not just labeled)
  const cm = {
    upTP: 0, upFP: 0, upFN: 0,
    downTP: 0, downFP: 0, downFN: 0,
    flatTP: 0, flatFP: 0, flatFN: 0,
  };

  for (const r of labeled) {
    const pred = r.predictedDirection!;
    const actual = r.actualDirection;
    if (pred === "UP" && actual === "UP") cm.upTP++;
    else if (pred === "UP" && actual !== "UP") cm.upFP++;
    else if (pred !== "UP" && actual === "UP") cm.upFN++;
    if (pred === "DOWN" && actual === "DOWN") cm.downTP++;
    else if (pred === "DOWN" && actual !== "DOWN") cm.downFP++;
    else if (pred !== "DOWN" && actual === "DOWN") cm.downFN++;
    if (pred === "FLAT" && actual === "FLAT") cm.flatTP++;
    else if (pred === "FLAT" && actual !== "FLAT") cm.flatFP++;
    else if (pred !== "FLAT" && actual === "FLAT") cm.flatFN++;
  }

  // Overall metrics (macro-averaged across 3 classes)
  const upPrec = cm.upTP + cm.upFP > 0 ? cm.upTP / (cm.upTP + cm.upFP) : 0;
  const upRec = cm.upTP + cm.upFN > 0 ? cm.upTP / (cm.upTP + cm.upFN) : 0;
  const downPrec = cm.downTP + cm.downFP > 0 ? cm.downTP / (cm.downTP + cm.downFP) : 0;
  const downRec = cm.downTP + cm.downFN > 0 ? cm.downTP / (cm.downTP + cm.downFN) : 0;
  const flatPrec = cm.flatTP + cm.flatFP > 0 ? cm.flatTP / (cm.flatTP + cm.flatFP) : 0;
  const flatRec = cm.flatTP + cm.flatFN > 0 ? cm.flatTP / (cm.flatTP + cm.flatFN) : 0;

  const precision = (upPrec + downPrec + flatPrec) / 3;
  const recall = (upRec + downRec + flatRec) / 3;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

  // Error calculations
  let totalError = 0;
  let maxError = 0;
  let errorCount = 0;
  for (const r of labeled) {
    if (r.predictedProbability !== null && r.actualGapPct !== null) {
      const error = Math.abs(r.predictedProbability - (r.actualDirection === "UP" ? 100 : r.actualDirection === "DOWN" ? 0 : 50));
      totalError += error;
      maxError = Math.max(maxError, error);
      errorCount++;
    }
  }
  const avgError = errorCount > 0 ? totalError / errorCount : 0;

  // Sort by absolute probability error for best/worst
  const sorted = [...labeled].filter(r => r.predictedProbability !== null)
    .sort((a, b) => {
      const errA = Math.abs(a.predictedProbability! - (a.actualDirection === "UP" ? 100 : a.actualDirection === "DOWN" ? 0 : 50));
      const errB = Math.abs(b.predictedProbability! - (b.actualDirection === "UP" ? 100 : b.actualDirection === "DOWN" ? 0 : 50));
      return errB - errA;
    });

  const byDirection: Record<string, { total: number; correct: number; accuracy: number }> = {};
  for (const dir of ["UP", "FLAT", "DOWN"] as const) {
    const d = labeled.filter(r => r.actualDirection === dir);
    const c = d.filter(r => r.correct).length;
    byDirection[dir] = { total: d.length, correct: c, accuracy: d.length > 0 ? c / d.length * 100 : 0 };
  }

  return {
    total,
    correct,
    incorrect,
    accuracy: labeled.length > 0 ? correct / labeled.length * 100 : 0,
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1: Math.round(f1 * 1000) / 1000,
    confusionMatrix: cm,
    avgError: Math.round(avgError * 10) / 10,
    maxError: Math.round(maxError * 10) / 10,
    worstPredictions: sorted.slice(0, 20),
    bestPredictions: sorted.slice(-20).reverse(),
    byDirection: byDirection as ValidationResult["byDirection"],
  };
}

export { DEFAULT_WEIGHTS };
