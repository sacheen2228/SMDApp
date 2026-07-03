// SDM Scoring Engine
// 10 scoring functions that analyze option chain data and return directional signals

import type { SDMOptionStrike, ScoreObject } from "@/types/sdm";

// ─── 1. PCR Score ────────────────────────────────────────────────
// Put-Call Ratio: total PE OI / total CE OI
// PCR > 1.2 → Bullish (put writing = support), PCR < 0.8 → Bearish (call writing = resistance)
export function scorePCR(
  optionChain: SDMOptionStrike[],
  spot: number
): ScoreObject {
  let totalCEOI = 0;
  let totalPEOI = 0;

  for (const strike of optionChain) {
    if (strike.ce) totalCEOI += strike.ce.oi;
    if (strike.pe) totalPEOI += strike.pe.oi;
  }

  const pcr = totalCEOI > 0 ? totalPEOI / totalCEOI : 1;

  if (pcr > 1.2) {
    const score = Math.min(100, 50 + (pcr - 1.2) * 100);
    return {
      score,
      direction: "CALL",
      details: `PCR at ${pcr.toFixed(2)} — Bullish (put writing = support)`,
    };
  }

  if (pcr < 0.8) {
    const score = Math.min(100, 50 + (0.8 - pcr) * 100);
    return {
      score,
      direction: "PUT",
      details: `PCR at ${pcr.toFixed(2)} — Bearish (call writing = resistance)`,
    };
  }

  return {
    score: 20,
    direction: "NEUTRAL",
    details: `PCR at ${pcr.toFixed(2)} — Neutral zone`,
  };
}

// ─── 2. OI Concentration Score ───────────────────────────────────
// Where is the biggest CE wall (resistance) and PE wall (support)?
// Spot near PE support → CALL, spot near CE resistance → PUT
export function scoreOIConcentration(
  optionChain: SDMOptionStrike[],
  spot: number
): ScoreObject {
  let maxCEOI = 0;
  let ceResistanceStrike = 0;
  let maxPEOI = 0;
  let peSupportStrike = 0;

  for (const strike of optionChain) {
    if (strike.ce && strike.ce.oi > maxCEOI) {
      maxCEOI = strike.ce.oi;
      ceResistanceStrike = strike.strike;
    }
    if (strike.pe && strike.pe.oi > maxPEOI) {
      maxPEOI = strike.pe.oi;
      peSupportStrike = strike.strike;
    }
  }

  const ceDistance = Math.abs(spot - ceResistanceStrike) / spot * 100;
  const peDistance = Math.abs(spot - peSupportStrike) / spot * 100;

  // OI-weighted proximity: which wall exerts more pull?
  // Higher OI wall = stronger magnet/repellent
  const totalOI = maxCEOI + maxPEOI;
  const ceOIRatio = totalOI > 0 ? maxCEOI / totalOI : 0.5;
  const peOIRatio = totalOI > 0 ? maxPEOI / totalOI : 0.5;

  // Effective proximity = distance weighted by OI strength
  const ceEffective = ceDistance / Math.max(0.1, ceOIRatio);
  const peEffective = peDistance / Math.max(0.1, peOIRatio);

  // Spot near PE support AND closer to PE wall → CALL (bounce)
  // Spot near CE resistance AND closer to CE wall → PUT (rejection)
  if (peEffective < ceEffective && peDistance < 1.5) {
    const score = Math.max(30, 90 - peDistance * 30);
    return {
      score,
      direction: "CALL",
      details: `CE wall at ${ceResistanceStrike} (${(maxCEOI / 100000).toFixed(1)}L OI), PE wall at ${peSupportStrike} (${(maxPEOI / 100000).toFixed(1)}L OI)`,
    };
  }

  if (ceEffective < peEffective && ceDistance < 1.5) {
    const score = Math.max(30, 90 - ceDistance * 30);
    return {
      score,
      direction: "PUT",
      details: `CE wall at ${ceResistanceStrike} (${(maxCEOI / 100000).toFixed(1)}L OI), PE wall at ${peSupportStrike} (${(maxPEOI / 100000).toFixed(1)}L OI)`,
    };
  }

  // Both equidistant — use OI weight as tiebreaker
  if (Math.abs(peEffective - ceEffective) < 0.3) {
    const score = 50;
    return {
      score,
      direction: ceOIRatio > peOIRatio ? "PUT" : "CALL",
      details: `CE wall at ${ceResistanceStrike} (${(maxCEOI / 100000).toFixed(1)}L OI), PE wall at ${peSupportStrike} (${(maxPEOI / 100000).toFixed(1)}L OI)`,
    };
  }

  return {
    score: 35,
    direction: "NEUTRAL",
    details: `CE wall at ${ceResistanceStrike} (${(maxCEOI / 100000).toFixed(1)}L OI), PE wall at ${peSupportStrike} (${(maxPEOI / 100000).toFixed(1)}L OI)`,
  };
}

// ─── 3. OI Change Score ──────────────────────────────────────────
// Where is fresh OI being added? Fresh PE OI = support building → CALL
// Fresh CE OI = resistance building → PUT
export function scoreOIChange(
  optionChain: SDMOptionStrike[],
  spot: number
): ScoreObject {
  let maxCEOIChg = 0;
  let ceChangeStrike = 0;
  let maxPEOIChg = 0;
  let peChangeStrike = 0;
  let totalCEOI = 0;
  let totalPEOI = 0;

  for (const strike of optionChain) {
    if (strike.ce) {
      totalCEOI += strike.ce.oi;
      if (strike.ce.oiChg > maxCEOIChg) {
        maxCEOIChg = strike.ce.oiChg;
        ceChangeStrike = strike.strike;
      }
    }
    if (strike.pe) {
      totalPEOI += strike.pe.oi;
      if (strike.pe.oiChg > maxPEOIChg) {
        maxPEOIChg = strike.pe.oiChg;
        peChangeStrike = strike.strike;
      }
    }
  }

  const ceChangePercent = totalCEOI > 0 ? (maxCEOIChg / totalCEOI) * 100 : 0;
  const peChangePercent = totalPEOI > 0 ? (maxPEOIChg / totalPEOI) * 100 : 0;

  let score = 30;
  if (ceChangePercent > 20 || peChangePercent > 20) score = 90;
  else if (ceChangePercent > 10 || peChangePercent > 10) score = 70;
  else if (ceChangePercent > 5 || peChangePercent > 5) score = 50;

  // CE OI added more → PUT signal (call writing = bearish)
  if (maxCEOIChg > maxPEOIChg) {
    return {
      score,
      direction: "PUT",
      details: `CE OI added ${(maxCEOIChg / 100000).toFixed(1)}L at ${ceChangeStrike}, PE OI added ${(maxPEOIChg / 100000).toFixed(1)}L at ${peChangeStrike}`,
    };
  }

  // PE OI added more → CALL signal (put writing = bullish)
  return {
    score,
    direction: "CALL",
    details: `CE OI added ${(maxCEOIChg / 100000).toFixed(1)}L at ${ceChangeStrike}, PE OI added ${(maxPEOIChg / 100000).toFixed(1)}L at ${peChangeStrike}`,
  };
}

// ─── 4. Delta Score ──────────────────────────────────────────────
// ATM delta indicates directional bias. Delta > 0.5 → CALL, < -0.5 → PUT
export function scoreDelta(
  optionChain: SDMOptionStrike[],
  spot: number
): ScoreObject {
  // Find ATM strike (closest to spot)
  let atmStrike = optionChain[0]?.strike || 0;
  let minDist = Infinity;

  for (const strike of optionChain) {
    const dist = Math.abs(strike.strike - spot);
    if (dist < minDist) {
      minDist = dist;
      atmStrike = strike.strike;
    }
  }

  const atmData = optionChain.find((s) => s.strike === atmStrike);
  const delta = atmData?.ce?.delta || 0;

  if (delta > 0.5) {
    return {
      score: Math.min(100, delta * 100),
      direction: "CALL",
      details: `ATM delta: ${delta.toFixed(3)} at ${atmStrike}`,
    };
  }

  if (delta < -0.5) {
    return {
      score: Math.min(100, Math.abs(delta) * 100),
      direction: "PUT",
      details: `ATM delta: ${delta.toFixed(3)} at ${atmStrike}`,
    };
  }

  return {
    score: 40,
    direction: "NEUTRAL",
    details: `ATM delta: ${delta.toFixed(3)} at ${atmStrike}`,
  };
}

// ─── 5. IV Score ─────────────────────────────────────────────────
// High IV → mean reversion (PUT bias), Low IV → expansion (CALL bias)
export function scoreIV(
  optionChain: SDMOptionStrike[],
  spot: number
): ScoreObject {
  let totalIV = 0;
  let count = 0;
  let atmIV = 0;
  let minDist = Infinity;
  let atmStrike = 0;

  for (const strike of optionChain) {
    const dist = Math.abs(strike.strike - spot);
    if (dist < minDist) {
      minDist = dist;
      atmStrike = strike.strike;
      if (strike.ce) atmIV = strike.ce.iv;
    }
    if (strike.ce) {
      totalIV += strike.ce.iv;
      count++;
    }
  }

  const avgIV = count > 0 ? totalIV / count : 0;

  if (atmIV > avgIV * 1.2) {
    return {
      score: 60,
      direction: "PUT",
      details: `ATM IV: ${atmIV.toFixed(1)}% vs avg: ${avgIV.toFixed(1)}% — High IV, mean reversion expected`,
    };
  }

  if (atmIV < avgIV * 0.8) {
    return {
      score: 60,
      direction: "CALL",
      details: `ATM IV: ${atmIV.toFixed(1)}% vs avg: ${avgIV.toFixed(1)}% — Low IV, expansion expected`,
    };
  }

  return {
    score: 40,
    direction: "NEUTRAL",
    details: `ATM IV: ${atmIV.toFixed(1)}% vs avg: ${avgIV.toFixed(1)}%`,
  };
}

// ─── 6. Volume Score ─────────────────────────────────────────────
// High volume at a strike = institutional activity
// High CE volume → call writing → PUT, High PE volume → put writing → CALL
export function scoreVolume(
  optionChain: SDMOptionStrike[],
  spot: number
): ScoreObject {
  let maxVolume = 0;
  let maxVolStrike = 0;
  let maxVolIsCE = false;
  let totalVolume = 0;
  let count = 0;

  for (const strike of optionChain) {
    if (strike.ce) {
      totalVolume += strike.ce.volume;
      count++;
      if (strike.ce.volume > maxVolume) {
        maxVolume = strike.ce.volume;
        maxVolStrike = strike.strike;
        maxVolIsCE = true;
      }
    }
    if (strike.pe) {
      totalVolume += strike.pe.volume;
      count++;
      if (strike.pe.volume > maxVolume) {
        maxVolume = strike.pe.volume;
        maxVolStrike = strike.strike;
        maxVolIsCE = false;
      }
    }
  }

  const avgVolume = count > 0 ? totalVolume / count : 0;
  const multiplier = avgVolume > 0 ? maxVolume / avgVolume : 1;

  let score = 40;
  if (multiplier > 3) score = 90;
  else if (multiplier > 2) score = 75;
  else if (multiplier > 1.5) score = 60;

  // High CE volume → call writing → PUT signal
  // High PE volume → put writing → CALL signal
  const direction = maxVolIsCE ? "PUT" : "CALL";

  return {
    score,
    direction,
    details: `Max volume ${(maxVolume / 1000).toFixed(0)}K at ${maxVolStrike} (${multiplier.toFixed(1)}x average)`,
  };
}

// ─── 7. Max Pain Score ───────────────────────────────────────────
// Max pain = strike where total option buyer loss is maximum
// Spot below max pain → expected UP → CALL, above → expected DOWN → PUT
export function scoreMaxPain(
  optionChain: SDMOptionStrike[],
  spot: number
): ScoreObject {
  let minPain = Infinity;
  let maxPainStrike = 0;

  // For each potential strike, calculate total pain for option buyers
  for (const testStrike of optionChain) {
    let totalPain = 0;
    for (const strike of optionChain) {
      if (strike.ce) {
        totalPain += Math.abs(testStrike.strike - strike.strike) * strike.ce.oi;
      }
      if (strike.pe) {
        totalPain += Math.abs(testStrike.strike - strike.strike) * strike.pe.oi;
      }
    }
    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = testStrike.strike;
    }
  }

  const diff = (maxPainStrike - spot) / spot * 1000;

  if (spot < maxPainStrike) {
    const score = Math.min(90, 60 + Math.abs(diff));
    return {
      score,
      direction: "CALL",
      details: `Max pain: ${maxPainStrike}, spot: ${spot.toFixed(0)} — Below max pain, expected UP`,
    };
  }

  if (spot > maxPainStrike) {
    const score = Math.min(90, 60 + Math.abs(diff));
    return {
      score,
      direction: "PUT",
      details: `Max pain: ${maxPainStrike}, spot: ${spot.toFixed(0)} — Above max pain, expected DOWN`,
    };
  }

  return {
    score: 40,
    direction: "NEUTRAL",
    details: `Max pain: ${maxPainStrike}, spot: ${spot.toFixed(0)} — At max pain`,
  };
}

// ─── 8. Liquidity Score ──────────────────────────────────────────
// Tight spread at ATM = good liquidity for entries/exits
export function scoreLiquidity(
  optionChain: SDMOptionStrike[],
  spot: number
): ScoreObject {
  let atmStrike = optionChain[0]?.strike || 0;
  let minDist = Infinity;

  for (const strike of optionChain) {
    const dist = Math.abs(strike.strike - spot);
    if (dist < minDist) {
      minDist = dist;
      atmStrike = strike.strike;
    }
  }

  const atmData = optionChain.find((s) => s.strike === atmStrike);
  if (!atmData?.ce || !atmData?.pe) {
    return { score: 30, direction: "NEUTRAL", details: "ATM data unavailable" };
  }

  const ceBid = atmData.ce.bid || atmData.ce.ltp * 0.98;
  const ceAsk = atmData.ce.ask || atmData.ce.ltp * 1.02;
  const peBid = atmData.pe.bid || atmData.pe.ltp * 0.98;
  const peAsk = atmData.pe.ask || atmData.pe.ltp * 1.02;

  const ceSpread = ceAsk > 0 ? ((ceAsk - ceBid) / ceAsk) * 100 : 5;
  const peSpread = peAsk > 0 ? ((peAsk - peBid) / peAsk) * 100 : 5;
  const avgSpread = (ceSpread + peSpread) / 2;

  if (avgSpread < 0.5) return { score: 95, direction: "NEUTRAL", details: `ATM spread: ${avgSpread.toFixed(2)}% — Excellent` };
  if (avgSpread < 1) return { score: 80, direction: "NEUTRAL", details: `ATM spread: ${avgSpread.toFixed(2)}% — Good` };
  if (avgSpread < 2) return { score: 60, direction: "NEUTRAL", details: `ATM spread: ${avgSpread.toFixed(2)}% — Acceptable` };
  if (avgSpread < 5) return { score: 35, direction: "NEUTRAL", details: `ATM spread: ${avgSpread.toFixed(2)}% — Poor` };
  return { score: 15, direction: "NEUTRAL", details: `ATM spread: ${avgSpread.toFixed(2)}% — Terrible` };
}

// ─── 9. Seller Stop Loss Score ───────────────────────────────────
// THE MOST IMPORTANT SCORE
// Finds where CE/PE sellers are trapped and calculates distance to their SL
// If sellers are exhausting (OI dropping), it's a strong signal
export function scoreSellerStopLoss(
  optionChain: SDMOptionStrike[],
  spot: number
): ScoreObject {
  if (optionChain.length < 3) {
    return { score: 25, direction: "NEUTRAL", details: "Insufficient data for seller SL analysis" };
  }

  // Find strike step (assume uniform)
  const strikeStep = optionChain[1].strike - optionChain[0].strike;

  // A) Find CE seller trap (highest CE OI)
  let maxCEOI = 0;
  let ceTrapStrike = 0;
  for (const strike of optionChain) {
    if (strike.ce && strike.ce.oi > maxCEOI) {
      maxCEOI = strike.ce.oi;
      ceTrapStrike = strike.strike;
    }
  }

  // B) Find PE seller trap (highest PE OI)
  let maxPEOI = 0;
  let peTrapStrike = 0;
  for (const strike of optionChain) {
    if (strike.pe && strike.pe.oi > maxPEOI) {
      maxPEOI = strike.pe.oi;
      peTrapStrike = strike.strike;
    }
  }

  // CE seller SL zone = 2 strikes above highest CE OI
  const ceSellerSL = ceTrapStrike + 2 * strikeStep;
  // PE seller SL zone = 2 strikes below highest PE OI
  const peSellerSL = peTrapStrike - 2 * strikeStep;

  // C) Calculate distances from spot
  const ceDistance = Math.abs(ceSellerSL - spot) / spot * 100;
  const peDistance = Math.abs(spot - peSellerSL) / spot * 100;

  // D) Seller exhaustion check — OI dropping at top strikes
  const topCEOIStrikes = optionChain
    .filter((s) => s.ce)
    .sort((a, b) => (b.ce?.oi || 0) - (a.ce?.oi || 0))
    .slice(0, 5);

  let ceExhaustion = false;
  for (const s of topCEOIStrikes) {
    if (s.ce && s.ce.oiChg < 0 && Math.abs(s.ce.oiChg) > s.ce.oi * 0.3) {
      ceExhaustion = true;
      break;
    }
  }

  const topPEOIStrikes = optionChain
    .filter((s) => s.pe)
    .sort((a, b) => (b.pe?.oi || 0) - (a.pe?.oi || 0))
    .slice(0, 5);

  let peExhaustion = false;
  for (const s of topPEOIStrikes) {
    if (s.pe && s.pe.oiChg < 0 && Math.abs(s.pe.oiChg) > s.pe.oi * 0.3) {
      peExhaustion = true;
      break;
    }
  }

  // E) Determine direction and score based on which side has more pressure
  let direction: "CALL" | "PUT" | "NEUTRAL" = "NEUTRAL";
  let score = 25;

  // CE sellers covering → price going UP → CALL
  // PE sellers covering → price going DOWN → PUT
  // Use OI magnitude as tiebreaker when distances are similar
  const cePressure = ceExhaustion ? 100 : Math.max(0, 100 - ceDistance * 30);
  const pePressure = peExhaustion ? 100 : Math.max(0, 100 - peDistance * 30);
  // Weight by actual OI size — bigger OI wall = more important
  const ceOIWeight = maxCEOI > 0 ? maxCEOI / (maxCEOI + maxPEOI) : 0.5;
  const peOIWeight = maxPEOI > 0 ? maxPEOI / (maxCEOI + maxPEOI) : 0.5;
  const ceScore = cePressure * ceOIWeight;
  const peScore = pePressure * peOIWeight;

  if (ceExhaustion && peExhaustion) {
    // Both sides exhausting — use OI weight
    score = 90;
    direction = ceOIWeight > peOIWeight ? "CALL" : "PUT";
  } else if (ceExhaustion) {
    score = 100;
    direction = "CALL";
  } else if (peExhaustion) {
    score = 100;
    direction = "PUT";
  } else if (ceScore > peScore && ceDistance < 2) {
    score = Math.round(Math.min(95, 65 + (2 - ceDistance) * 15));
    direction = "CALL";
  } else if (peScore > ceScore && peDistance < 2) {
    score = Math.round(Math.min(95, 65 + (2 - peDistance) * 15));
    direction = "PUT";
  } else if (ceDistance < 1 && peDistance < 1) {
    // Both close — use OI weight
    score = 60;
    direction = ceOIWeight > peOIWeight ? "CALL" : "PUT";
  } else {
    score = 30;
    direction = "NEUTRAL";
  }

  const nearestSL = ceDistance < peDistance ? "CE" : "PE";
  const distanceToSL = Math.min(ceDistance, peDistance);

  // Return extra data in details for recommendation engine to parse
  return {
    score,
    direction,
    details: `CE_SL:${ceSellerSL}:CE_OI:${maxCEOI}:PE_SL:${peSellerSL}:PE_OI:${maxPEOI}:NEAREST:${nearestSL}:DIST:${distanceToSL.toFixed(2)}:EXHAUST:${ceExhaustion || peExhaustion}`,
  };
}

// ─── 10. Expiry Gamma-Theta Score ────────────────────────────────
// Expiry day has 3 windows: gamma (9:30-10:30), theta (10:30-13:30), danger (14:00-15:30)
// Each window has different characteristics and scoring
export function scoreExpiryGammaTheta(
  optionChain: SDMOptionStrike[],
  spot: number,
  currentTime: Date,
  expiryDate: string,
  vix?: number
): ScoreObject {
  // A) Detect expiry day
  const today = new Date();
  const expiry = new Date(expiryDate);
  const isExpiryDay =
    today.getFullYear() === expiry.getFullYear() &&
    today.getMonth() === expiry.getMonth() &&
    today.getDate() === expiry.getDate();

  if (!isExpiryDay) {
    return {
      score: 0,
      direction: "NEUTRAL",
      details: "WINDOW:normal:GAMMA:0:THETA_RATE:0:BLAST:false:SIGNALS:{}",
    };
  }

  // B) Determine current window
  const hour = currentTime.getHours();
  const minute = currentTime.getMinutes();
  const timeInMinutes = hour * 60 + minute;

  let window: "gamma" | "theta" | "danger" | "between_windows" = "between_windows";
  if (timeInMinutes >= 570 && timeInMinutes <= 630) window = "gamma";
  else if (timeInMinutes > 630 && timeInMinutes <= 810) window = "theta";
  else if (timeInMinutes > 840 && timeInMinutes <= 930) window = "danger";

  // C) Find ATM gamma
  let atmStrike = optionChain[0]?.strike || 0;
  let minDist = Infinity;
  for (const strike of optionChain) {
    const dist = Math.abs(strike.strike - spot);
    if (dist < minDist) {
      minDist = dist;
      atmStrike = strike.strike;
    }
  }
  const atmData = optionChain.find((s) => s.strike === atmStrike);
  const gammaValue = atmData?.ce?.gamma || 0;

  // D) Theta decay rate estimate (₹/hour)
  let thetaRate = 8;
  if (window === "theta") thetaRate = 25;
  else if (window === "danger") thetaRate = 40;

  // E) Gamma blast detection (only in danger window)
  const currentVix = vix || 15;
  const gammaBlastSignals = {
    lowVix: currentVix < 15,
    flatThenBreakout: false, // Would need historical data to compute
    volumeSpike: false, // Would need volume comparison
    ivSpike: false, // Would need IV comparison
    extremePCR: false, // Will compute below
  };

  // Compute PCR for extreme check
  let totalCEOI = 0;
  let totalPEOI = 0;
  for (const strike of optionChain) {
    if (strike.ce) totalCEOI += strike.ce.oi;
    if (strike.pe) totalPEOI += strike.pe.oi;
  }
  const pcr = totalCEOI > 0 ? totalPEOI / totalCEOI : 1;
  gammaBlastSignals.extremePCR = pcr < 0.7 || pcr > 1.3;

  const gammaBlastDetected =
    window === "danger" &&
    gammaBlastSignals.lowVix &&
    gammaBlastSignals.extremePCR;

  // F) Score by window
  let score = 40;
  let direction: "CALL" | "PUT" | "NEUTRAL" = "NEUTRAL";

  if (window === "gamma") {
    score = 65;
    direction = "NEUTRAL"; // Let other scores determine
  } else if (window === "theta") {
    // Theta window: sellers favored, buyers penalized
    score = 50;
    direction = "NEUTRAL";
  } else if (window === "danger") {
    if (gammaBlastDetected) {
      score = 95;
      direction = pcr > 1.3 ? "CALL" : "PUT";
    } else {
      score = 40;
    }
  }

  return {
    score,
    direction,
    details: `WINDOW:${window}:GAMMA:${gammaValue.toFixed(4)}:THETA_RATE:${thetaRate}:BLAST:${gammaBlastDetected}:SIGNALS:${JSON.stringify(gammaBlastSignals)}`,
  };
}

// ─── Parse Helper: Seller SL Details ─────────────────────────────
export function parseSellerSLDetails(details: string) {
  const parsed: Record<string, string> = {};
  const parts = details.split(":");
  for (let i = 0; i < parts.length - 1; i += 2) {
    parsed[parts[i]] = parts[i + 1];
  }
  return {
    ceSellerSL: parseFloat(parsed.CE_SL || "0"),
    ceSellerOI: parseFloat(parsed.CE_OI || "0"),
    peSellerSL: parseFloat(parsed.PE_SL || "0"),
    peSellerOI: parseFloat(parsed.PE_OI || "0"),
    nearestSL: (parsed.NEAREST || "CE") as "CE" | "PE",
    distanceToSL: parseFloat(parsed.DIST || "0"),
    sellerExhaustion: parsed.EXHAUST === "true",
  };
}

// ─── Parse Helper: Gamma-Theta Details ───────────────────────────
export function parseGammaThetaDetails(details: string) {
  const windowMatch = details.match(/WINDOW:(\w+)/);
  const gammaMatch = details.match(/GAMMA:([\d.]+)/);
  const thetaRateMatch = details.match(/THETA_RATE:(\d+)/);
  const blastMatch = details.match(/BLAST:(true|false)/);
  const signalsMatch = details.match(/SIGNALS:({.*})/);

  return {
    window: (windowMatch?.[1] || "normal") as
      | "gamma"
      | "theta"
      | "danger"
      | "normal",
    gamma: parseFloat(gammaMatch?.[1] || "0"),
    thetaRate: parseInt(thetaRateMatch?.[1] || "8"),
    blastDetected: blastMatch?.[1] === "true",
    signals: signalsMatch?.[1] ? JSON.parse(signalsMatch[1]) : {},
  };
}

// ─── 11. Premium Fair Value Score ────────────────────────────────
// Compares market price vs theoretical Black-Scholes price
// Undervalued = good buy, Overpriced = good sell
export function scorePremiumFairValue(
  strikes: SDMOptionStrike[],
  spot: number,
  riskFreeRate: number = 0.065
): ScoreObject {
  let atmStrike = strikes[0]?.strike || 0;
  let minDist = Infinity;
  for (const s of strikes) {
    const dist = Math.abs(s.strike - spot);
    if (dist < minDist) { minDist = dist; atmStrike = s.strike; }
  }

  const atm = strikes.find(s => s.strike === atmStrike);
  if (!atm?.ce || !atm?.pe) {
    return { score: 30, direction: "NEUTRAL", details: "ATM data unavailable for fair value" };
  }

  const T = Math.max(0.001, 5 / 365); // assume 5 days to expiry if unknown
  const S = spot;
  const K = atmStrike;
  const sigma = (atm.ce.iv || 20) / 100;

  // Black-Scholes call price
  const d1 = (Math.log(S / K) + (riskFreeRate + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const N = (x: number) => 0.5 * (1 + erf(x / Math.sqrt(2)));
  const bsCall = S * N(d1) - K * Math.exp(-riskFreeRate * T) * N(d2);

  const marketPrice = atm.ce.ltp;
  const diff = marketPrice - bsCall;
  const diffPercent = bsCall > 0 ? (diff / bsCall) * 100 : 0;

  let score = 50;
  let direction: "CALL" | "PUT" | "NEUTRAL" = "NEUTRAL";
  let status: "undervalued" | "fair" | "overpriced" = "fair";
  let reason = "";

  if (diffPercent < -15) {
    score = 85;
    direction = "CALL";
    status = "undervalued";
    reason = `Market ₹${marketPrice.toFixed(0)} vs Fair ₹${bsCall.toFixed(0)} — ${Math.abs(diffPercent).toFixed(1)}% undervalued, buy opportunity`;
  } else if (diffPercent < -5) {
    score = 65;
    direction = "CALL";
    status = "undervalued";
    reason = `Market ₹${marketPrice.toFixed(0)} vs Fair ₹${bsCall.toFixed(0)} — Slightly undervalued`;
  } else if (diffPercent > 15) {
    score = 85;
    direction = "PUT";
    status = "overpriced";
    reason = `Market ₹${marketPrice.toFixed(0)} vs Fair ₹${bsCall.toFixed(0)} — ${diffPercent.toFixed(1)}% overpriced, sell opportunity`;
  } else if (diffPercent > 5) {
    score = 65;
    direction = "PUT";
    status = "overpriced";
    reason = `Market ₹${marketPrice.toFixed(0)} vs Fair ₹${bsCall.toFixed(0)} — Slightly overpriced`;
  } else {
    score = 50;
    status = "fair";
    reason = `Market ₹${marketPrice.toFixed(0)} vs Fair ₹${bsCall.toFixed(0)} — Fairly priced`;
  }

  return { score, direction, details: `FAIR_VALUE:${status}:${diffPercent.toFixed(1)}:${reason}` };
}

// Error function approximation (used by Black-Scholes)
function erf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

// ─── 12. Market Regime Detection ─────────────────────────────────
export function detectMarketRegime(
  strikes: SDMOptionStrike[],
  spot: number,
  vix: number,
  pcr: number
): ScoreObject {
  const avgIV = strikes.reduce((sum, s) => sum + (s.ce?.iv || 20), 0) / Math.max(strikes.length, 1);
  const ivRange = Math.max(...strikes.map(s => s.ce?.iv || 0)) - Math.min(...strikes.map(s => s.ce?.iv || 0));

  let regime: string;
  let score: number;
  let direction: "CALL" | "PUT" | "NEUTRAL" = "NEUTRAL";
  let details: string;

  // High IV + high PCR = High Volatility
  if (vix > 25 || avgIV > 30) {
    regime = "high_volatility";
    score = 70;
    direction = pcr > 1.1 ? "CALL" : "PUT"; // In high vol, follow PCR
    details = `REGIME:high_volatility:VIX:${vix.toFixed(1)}:AVG_IV:${avgIV.toFixed(1)}:ACTION:Sell premium or use spreads`;
  }
  // Low IV + low PCR = Low Volatility
  else if (vix < 12 || avgIV < 15) {
    regime = "low_volatility";
    score = 60;
    direction = "CALL"; // Low vol + low IV = potential breakout
    details = `REGIME:low_volatility:VIX:${vix.toFixed(1)}:AVG_IV:${avgIV.toFixed(1)}:ACTION:Buy options for breakout`;
  }
  // PCR extremes suggest breakout
  else if (pcr > 1.3 || pcr < 0.7) {
    regime = "breakout";
    score = 75;
    direction = pcr > 1.3 ? "PUT" : "CALL"; // Extreme PCR often reverses
    details = `REGIME:breakout:PCR:${pcr.toFixed(2)}:ACTION:Extreme PCR, expect reversal`;
  }
  // Moderate IV, moderate PCR = Ranging
  else if (ivRange < 5) {
    regime = "ranging";
    score = 55;
    direction = "NEUTRAL";
    details = `REGIME:ranging:IV_RANGE:${ivRange.toFixed(1)}:ACTION:Range-bound, sell options`;
  }
  // Default: Trending
  else {
    regime = "trending";
    score = 65;
    direction = pcr > 1.0 ? "CALL" : "PUT";
    details = `REGIME:trending:PCR:${pcr.toFixed(2)}:ACTION:Follow trend direction`;
  }

  return { score, direction, details };
}

// ─── 13. Live Probability Engine ─────────────────────────────────
// Simplified probability estimation using implied volatility
export function calculateLiveProbabilities(
  strikes: SDMOptionStrike[],
  spot: number,
  entryPrice: number,
  tp1: number,
  tp2: number,
  tp3: number,
  sl: number,
  direction: "CALL" | "PUT",
  daysToExpiry: number
): ScoreObject {
  const T = Math.max(0.001, daysToExpiry / 365);

  // Find ATM IV
  let atmStrike = strikes[0]?.strike || 0;
  let minDist = Infinity;
  for (const s of strikes) {
    const dist = Math.abs(s.strike - spot);
    if (dist < minDist) { minDist = dist; atmStrike = s.strike; }
  }
  const atm = strikes.find(s => s.strike === atmStrike);
  const sigma = ((atm?.ce?.iv || 20) / 100);

  // Expected move (1 standard deviation)
  const expectedMove = spot * sigma * Math.sqrt(T);

  // Probability of reaching TP/SL (simplified)
  const tp1Dist = Math.abs(tp1 - entryPrice);
  const tp2Dist = Math.abs(tp2 - entryPrice);
  const tp3Dist = Math.abs(tp3 - entryPrice);
  const slDist = Math.abs(sl - entryPrice);

  // Using normal distribution approximation
  const probTP1 = Math.min(95, Math.max(5, 50 + (expectedMove > 0 ? (tp1Dist / expectedMove) * 20 : 0)));
  const probTP2 = Math.min(90, Math.max(5, probTP1 - 15));
  const probTP3 = Math.min(85, Math.max(5, probTP2 - 15));
  const probSL = Math.min(80, Math.max(5, 50 - (expectedMove > 0 ? (slDist / expectedMove) * 20 : 0)));

  // ITM/OTM at expiry probability
  const probITM = direction === "CALL"
    ? Math.min(95, Math.max(5, 50 + ((spot - atmStrike) / expectedMove) * 30))
    : Math.min(95, Math.max(5, 50 + ((atmStrike - spot) / expectedMove) * 30));
  const probOTM = 100 - probITM;

  // Overall confidence from probability balance
  const avgProb = (probTP1 + probTP2 + probTP3) / 3;
  const score = Math.round(avgProb);

  const details = `PROBS:TP1:${probTP1.toFixed(0)}:TP2:${probTP2.toFixed(0)}:TP3:${probTP3.toFixed(0)}:SL:${probSL.toFixed(0)}:ITM:${probITM.toFixed(0)}:OTM:${probOTM.toFixed(0)}`;

  return { score, direction: "NEUTRAL", details };
}

// ─── 14. Data Health Score ───────────────────────────────────────
export function scoreDataHealth(
  strikes: SDMOptionStrike[],
  spot: number,
  lastUpdate: string,
  source: string
): ScoreObject {
  let score = 100;
  const missingFields: string[] = [];

  // Check data completeness
  if (strikes.length < 5) {
    score -= 30;
    missingFields.push("insufficient_strikes");
  }

  // Check for missing data at ATM
  let atmStrike = strikes[0]?.strike || 0;
  let minDist = Infinity;
  for (const s of strikes) {
    const dist = Math.abs(s.strike - spot);
    if (dist < minDist) { minDist = dist; atmStrike = s.strike; }
  }
  const atm = strikes.find(s => s.strike === atmStrike);

  if (!atm?.ce) { score -= 20; missingFields.push("no_ce_data"); }
  if (!atm?.pe) { score -= 20; missingFields.push("no_pe_data"); }
  if (atm?.ce?.ltp === 0) { score -= 10; missingFields.push("ce_ltp_zero"); }
  if (atm?.pe?.ltp === 0) { score -= 10; missingFields.push("pe_ltp_zero"); }
  if (atm?.ce?.oi === 0) { score -= 10; missingFields.push("ce_oi_zero"); }
  if (atm?.pe?.oi === 0) { score -= 10; missingFields.push("pe_oi_zero"); }

  // Check freshness
  const lastUpdateTime = new Date(lastUpdate).getTime();
  const now = Date.now();
  const ageMs = now - lastUpdateTime;
  const ageSec = ageMs / 1000;

  if (ageSec > 300) score -= 30; // > 5 min stale
  else if (ageSec > 60) score -= 15; // > 1 min stale
  else if (ageSec > 30) score -= 5; // > 30 sec stale

  // Check source
  if (source === "simulation") score -= 10;

  const status = score >= 80 ? "LIVE" : score >= 50 ? "STALE" : "OFFLINE";
  const latency = Math.min(500, ageSec * 100); // rough latency estimate

  return {
    score: Math.max(0, Math.min(100, score)),
    direction: "NEUTRAL",
    details: `HEALTH:${status}:${latency.toFixed(0)}ms:${source}:${missingFields.join(",") || "none"}`,
  };
}

// ─── Parse Helpers for New Scores ────────────────────────────────
export function parsePremiumFairValue(details: string) {
  const parts = details.split(":");
  return {
    status: (parts[1] || "fair") as "undervalued" | "fair" | "overpriced",
    differencePercent: parseFloat(parts[2] || "0"),
    reason: parts.slice(3).join(":") || "",
  };
}

export function parseMarketRegime(details: string) {
  const regimeMatch = details.match(/REGIME:(\w+)/);
  return {
    regime: (regimeMatch?.[1] || "trending") as any,
  };
}

export function parseLiveProbabilities(details: string) {
  const probs: Record<string, number> = {};
  const matches = details.matchAll(/(\w+):(\d+)/g);
  for (const m of matches) {
    if (m[1] !== "PROBS") probs[m[1]] = parseInt(m[2]);
  }
  return {
    tp1: probs.TP1 || 50,
    tp2: probs.TP2 || 35,
    tp3: probs.TP3 || 20,
    sl: probs.SL || 50,
    expiryITM: probs.ITM || 50,
    expiryOTM: probs.OTM || 50,
  };
}

export function parseDataHealth(details: string) {
  const parts = details.split(":");
  return {
    status: (parts[1] || "OFFLINE") as "LIVE" | "STALE" | "OFFLINE",
    latency: parseInt(parts[2] || "500"),
    source: parts[3] || "unknown",
    missingFields: parts[4]?.split(",") || [],
  };
}

// ─── Compatibility Exports (for old API route) ───────────────────
// Re-export SDMOptionStrike as OptionChainStrike for backward compatibility
export type OptionChainStrike = SDMOptionStrike;

// Types for old dashboard components
export interface StrikeOI {
  strike: number;
  callOI: number;
  callOIChange: number;
  callVolume: number;
  putOI: number;
  putOIChange: number;
  putVolume: number;
  sentiment: string;
  classification: string;
}

export interface GammaWall {
  strike: number;
  type: string;
  greeks: number;
  description?: string;
}

export interface MoneyFlow {
  direction: string;
  smartMoneyDirection: string;
  callWriting: boolean;
  putWriting: boolean;
}

export interface SDMScore {
  total: number;
  sentiment: string;
  confidence: number;
  pcr: number;
  maxPain: number;
  breakdown: Record<string, string>;
}

export interface TradeRecommendation {
  confidence: number;
  action: string;
  strike: number;
  direction: string;
  optionType?: string;
  sdmScore?: number;
  riskLevel?: string;
  oibuildup?: string;
  gammaWallSupport?: number;
  gammaWallResistance?: number;
  entryPrice?: number;
  idealBuyRange?: { low: number; high: number };
  lateEntryWarning?: boolean;
  stopLoss?: number;
  stopLossReason?: string;
  tp1Pct?: number;
  tp1?: number;
  tp2Pct?: number;
  tp2?: number;
  tp3Pct?: number;
  tp3?: number;
  trailingTarget?: boolean;
  reasons: string[];
}

// FullAnalysis type for old dashboard components
export interface FullAnalysis {
  spotPrice: number;
  expiryDate: string;
  atmStrike: number;
  pcr: number;
  maxPain: number;
  totalCallOI: number;
  totalPutOI: number;
  totalCallVolume: number;
  totalPutVolume: number;
  sentiment: string;
  recommendation: TradeRecommendation;
  sdm: SDMScore;
  spot: { spot: number; atmStrike: number; change: number; changePct: number };
  expiry: { label: string; daysToExpiry: number; date: string };
  oiAnalysis: { totalCallOI: number; totalPutOI: number; pcr: number; maxPain: number; sentiment: string };
  gammaWalls: GammaWall[];
  moneyFlow: MoneyFlow;
  greeks: any;
  strikes: StrikeOI[];
}

// runFullAnalysis: legacy analysis function used by API route
// Returns a basic analysis object; the new SDM bot does richer analysis client-side
export function runFullAnalysis(
  strikes: SDMOptionStrike[],
  spotPrice: number,
  expiryDate: string
): FullAnalysis {
  let totalCEOI = 0;
  let totalPEOI = 0;
  let totalCallVolume = 0;
  let totalPutVolume = 0;
  let maxPain = spotPrice;
  let minPain = Infinity;
  let atmStrike = spotPrice;
  let minDist = Infinity;

  for (const s of strikes) {
    if (s.ce) {
      totalCEOI += s.ce.oi;
      totalCallVolume += s.ce.volume;
    }
    if (s.pe) {
      totalPEOI += s.pe.oi;
      totalPutVolume += s.pe.volume;
    }
    const dist = Math.abs(s.strike - spotPrice);
    if (dist < minDist) {
      minDist = dist;
      atmStrike = s.strike;
    }
  }

  // Max pain calculation
  for (const test of strikes) {
    let pain = 0;
    for (const s of strikes) {
      if (s.ce) pain += Math.abs(test.strike - s.strike) * s.ce.oi;
      if (s.pe) pain += Math.abs(test.strike - s.strike) * s.pe.oi;
    }
    if (pain < minPain) {
      minPain = pain;
      maxPain = test.strike;
    }
  }

  const pcr = totalCEOI > 0 ? totalPEOI / totalCEOI : 1;
  const sentiment = pcr > 1.2 ? "bullish" : pcr < 0.8 ? "bearish" : "neutral";
  const confidence = Math.min(100, Math.max(20, pcr > 1.2 ? 50 + (pcr - 1.2) * 50 : pcr < 0.8 ? 50 + (0.8 - pcr) * 50 : 40));

  // Calculate days to expiry
  const today = new Date();
  const expiry = new Date(expiryDate);
  const daysToExpiry = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  // Determine action based on sentiment
  let action = "WAIT";
  let direction = "NEUTRAL";
  if (sentiment === "bullish") { action = "BUY CALL"; direction = "CALL"; }
  else if (sentiment === "bearish") { action = "BUY PUT"; direction = "PUT"; }

  // Find ATM data for entry/tp/sl
  const atmData = strikes.find(s => s.strike === atmStrike);
  const isCall = direction === "CALL";
  const entryPrice = isCall ? (atmData?.ce?.ltp || 0) : (atmData?.pe?.ltp || 0);
  const stopLoss = entryPrice > 0 ? Math.round(entryPrice * 0.85) : 0;
  const tp1 = entryPrice > 0 ? Math.round(entryPrice * 1.15) : 0;
  const tp2 = entryPrice > 0 ? Math.round(entryPrice * 1.5) : 0;
  const tp3 = entryPrice > 0 ? Math.round(entryPrice * 2.0) : 0;

  // Find highest CE/PE OI for gamma walls
  let maxCEOI = 0;
  let ceWallStrike = maxPain;
  let maxPEOI = 0;
  let peWallStrike = maxPain;
  for (const s of strikes) {
    if (s.ce && s.ce.oi > maxCEOI) { maxCEOI = s.ce.oi; ceWallStrike = s.strike; }
    if (s.pe && s.pe.oi > maxPEOI) { maxPEOI = s.pe.oi; peWallStrike = s.strike; }
  }

  // Build strike list for old dashboard
  const strikeList: StrikeOI[] = strikes.map(s => {
    const ceOI = s.ce?.oi || 0;
    const peOI = s.pe?.oi || 0;
    const totalStrikeOI = ceOI + peOI;
    let classif = "neutral";
    if (s.ce && s.ce.oiChg > 0 && s.pe && s.pe.oiChg < 0) classif = "long-buildup";
    else if (s.ce && s.ce.oiChg > 0 && s.pe && s.pe.oiChg > 0) classif = "short-buildup";
    else if (s.ce && s.ce.oiChg < 0 && s.pe && s.pe.oiChg > 0) classif = "long-unwinding";
    else if (s.ce && s.ce.oiChg < 0 && s.pe && s.pe.oiChg < 0) classif = "short-covering";
    let sent = "neutral";
    if (ceOI > peOI * 1.2) sent = "bearish";
    else if (peOI > ceOI * 1.2) sent = "bullish";
    return {
      strike: s.strike,
      callOI: ceOI,
      callOIChange: s.ce?.oiChg || 0,
      callVolume: s.ce?.volume || 0,
      putOI: peOI,
      putOIChange: s.pe?.oiChg || 0,
      putVolume: s.pe?.volume || 0,
      sentiment: sent,
      classification: classif,
    };
  });

  // Determine risk level
  const riskLevel = confidence >= 70 ? "LOW" : confidence >= 50 ? "MEDIUM" : confidence >= 30 ? "HIGH" : "EXTREME";

  // OI buildup
  let oibuildup = "neutral";
  if (sentiment === "bullish" && pcr > 1.1) oibuildup = "long-buildup";
  else if (sentiment === "bearish" && pcr < 0.9) oibuildup = "short-buildup";

  return {
    spotPrice,
    expiryDate,
    atmStrike,
    pcr,
    maxPain,
    totalCallOI: totalCEOI,
    totalPutOI: totalPEOI,
    totalCallVolume,
    totalPutVolume,
    sentiment,
    recommendation: {
      confidence,
      action,
      strike: atmStrike,
      direction,
      optionType: isCall ? "CE" : "PE",
      sdmScore: Math.round(confidence),
      riskLevel,
      oibuildup,
      gammaWallSupport: peWallStrike,
      gammaWallResistance: ceWallStrike,
      entryPrice,
      idealBuyRange: {
        low: entryPrice > 0 ? Math.round(entryPrice * 0.95) : 0,
        high: entryPrice > 0 ? Math.round(entryPrice * 1.05) : 0,
      },
      lateEntryWarning: daysToExpiry <= 1,
      stopLoss,
      stopLossReason: `15% below entry — invalidate if spot crosses ${maxPain}`,
      tp1Pct: 15,
      tp1,
      tp2Pct: 50,
      tp2,
      tp3Pct: 100,
      tp3,
      trailingTarget: confidence >= 65,
      reasons: [
        sentiment === "bullish" ? `Bullish PCR at ${pcr.toFixed(2)}` : "",
        sentiment === "bearish" ? `Bearish PCR at ${pcr.toFixed(2)}` : "",
        `Max Pain at ${maxPain}`,
        `ATM Strike: ${atmStrike}`,
        confidence >= 65 ? `High confidence (${confidence.toFixed(0)}%)` : "",
      ].filter(Boolean),
    },
    sdm: {
      total: Math.round(confidence),
      sentiment,
      confidence,
      pcr,
      maxPain,
      breakdown: {
        "PCR": pcr.toFixed(2),
        "Max Pain": maxPain.toString(),
        "CE OI": `${(totalCEOI / 100000).toFixed(1)}L`,
        "PE OI": `${(totalPEOI / 100000).toFixed(1)}L`,
        "Call Vol": `${(totalCallVolume / 1000).toFixed(0)}K`,
        "Put Vol": `${(totalPutVolume / 1000).toFixed(0)}K`,
        "Sentiment": sentiment,
      },
    },
    spot: { spot: spotPrice, atmStrike, change: 0, changePct: 0 },
    expiry: {
      label: new Date(expiryDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
      daysToExpiry,
      date: expiryDate,
    },
    oiAnalysis: { totalCallOI: totalCEOI, totalPutOI: totalPEOI, pcr, maxPain, sentiment },
    gammaWalls: [
      { strike: peWallStrike, type: "support", greeks: 0, description: `Strongest PE support @ ${peWallStrike} — ${(maxPEOI / 100000).toFixed(1)}L OI` },
      { strike: atmStrike, type: "neutral", greeks: 0, description: `ATM strike` },
      { strike: ceWallStrike, type: "resistance", greeks: 0, description: `Strongest CE resistance @ ${ceWallStrike} — ${(maxCEOI / 100000).toFixed(1)}L OI` },
    ],
    moneyFlow: {
      direction: sentiment === "bullish" ? "bullish" : sentiment === "bearish" ? "bearish" : "neutral",
      smartMoneyDirection: sentiment === "bullish" ? "Accumulating puts (hedging)" : sentiment === "bearish" ? "Accumulating calls (hedging)" : "No clear flow",
      callWriting: totalCEOI > totalPEOI,
      putWriting: totalPEOI > totalCEOI,
    },
    greeks: {
      ivRank: 50,
      ivPercentile: 50,
      overallGreeksScore: Math.round(confidence),
      ivScore: Math.round(confidence * 0.8),
      gamma: 0,
      theta: 0,
      vega: 0,
      delta: 0,
    },
    strikes: strikeList,
  };
}
