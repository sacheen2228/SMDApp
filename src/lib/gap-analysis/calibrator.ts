import { GapWeights, HistoricalRecord, ValidationResult } from "./types";
import { predictGap, validatePredictions } from "./gap-engine";
import { DEFAULT_WEIGHTS } from "./types";

// ─── Auto-Calibrator ────────────────────────────────────────────
// Uses grid search + iterative refinement to find optimal weights
// that maximize historical ACCURACY (not confidence).

interface CalibrationResult {
  weights: GapWeights;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  iterationsTried: number;
  improvements: Array<{ accuracy: number; weights: GapWeights }>;
}

function cloneWeights(w: GapWeights): GapWeights {
  return { ...w };
}

function applyPerturbation(weights: GapWeights, strength: number, rng: () => number): GapWeights {
  const w = cloneWeights(weights);
  const keys = Object.keys(w) as (keyof GapWeights)[];
  // Perturb a random subset
  for (const key of keys) {
    if (rng() > 0.4) continue; // only change 60% of weights
    const delta = (rng() - 0.5) * 2 * strength;
    w[key] = Math.max(0.01, Math.min(0.50, w[key] + delta));
  }
  // Renormalize to sum ~1.0
  const total = Object.values(w).reduce((s, v) => s + v, 0);
  for (const key of keys) {
    w[key] = w[key] / total;
  }
  return w;
}

function predictAll(records: HistoricalRecord[], weights: GapWeights): HistoricalRecord[] {
  return records.map((rec, i) => {
    const prev = records.slice(0, i);
    const histStats = computeSimpleStats(prev);

    const input = {
      prevClose: rec.prevClose,
      currentSpot: rec.openPrice,
      currentFutures: null,
      giftNiftyPrice: rec.openPrice,
      giftNiftyPrevClose: rec.prevClose,
      indiaVIX: null,
      pcrOI: null,
      pcrVolume: null,
      maxPain: null,
      ceOIChange: null,
      peOIChange: null,
      optionIV: null,
      futuresPremium: null,
      breadth: null,
      atr: null,
      vwapDistance: null,
      fiiNet: null,
      diiNet: null,
      usMarketChange: null,
      asianMarketChange: null,
      usdinr: null,
      crudeChange: null,
      newsRiskScore: null,
      economicCalendarRisk: null,
      historicalGapUpPct: histStats?.gapUpProb ?? null,
      historicalGapDownPct: histStats?.gapDownProb ?? null,
      historicalGapStats: histStats,
      timestamp: `2026-${i}T00:00:00Z`,
      symbol: "NIFTY",
    };

    const prediction = predictGap(input, weights);
    return {
      ...rec,
      predictedDirection: prediction.insufficientData ? null : prediction.prediction,
      predictedProbability: prediction.insufficientData ? null : prediction.probability,
      correct: prediction.insufficientData ? null : prediction.prediction === rec.actualDirection,
      factors: prediction.factors,
    };
  });
}

function computeSimpleStats(records: HistoricalRecord[]) {
  if (records.length < 5) return null;
  const gaps = records.map(r => r.actualGapPct).filter(g => isFinite(g));
  if (gaps.length < 5) return null;
  const gapUps = gaps.filter(g => g > 0.15);
  const gapDowns = gaps.filter(g => g < -0.15);
  const last20 = records.slice(-20).filter(r => r.correct !== null);
  return {
    meanGap: gaps.reduce((s, g) => s + g, 0) / gaps.length,
    stdGap: Math.sqrt(gaps.reduce((s, g) => s + (g - gaps.reduce((a, b) => a + b, 0) / gaps.length) ** 2, 0) / gaps.length),
    gapUpProb: gapUps.length / gaps.length,
    gapDownProb: gapDowns.length / gaps.length,
    medianGapUp: gapUps.sort((a, b) => a - b)[Math.floor(gapUps.length / 2)] || 0,
    medianGapDown: gapDowns.sort((a, b) => a - b)[Math.floor(gapDowns.length / 2)] || 0,
    last20Accuracy: last20.length > 0 ? last20.filter(r => r.correct).length / last20.length * 100 : 0,
    totalSamples: gaps.length,
  };
}

export function calibrate(
  records: HistoricalRecord[],
  iterations: number = 500,
  seedWeights: GapWeights = DEFAULT_WEIGHTS
): CalibrationResult {
  const improvements: CalibrationResult["improvements"] = [];
  let bestWeights = cloneWeights(seedWeights);
  let [bestAcc, bestPrec, bestRec, bestF1] = [0, 0, 0, 0];

  let rngCounter = 0;
  const seededRng = () => {
    rngCounter++;
    // Simple deterministic RNG for reproducibility
    const x = Math.sin(rngCounter * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };

  // Phase 1: Coarse grid search across weight magnitudes
  const baseValues = [0.02, 0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.22, 0.28, 0.35];
  const keys = Object.keys(seedWeights) as (keyof GapWeights)[];
  const numKeys = keys.length;

  let coarseTried = 0;
  for (let g = 0; g < 200; g++) {
    const w = cloneWeights(bestWeights);
    // Assign random base values to each key
    for (const key of keys) {
      w[key] = baseValues[Math.floor(seededRng() * baseValues.length)];
    }
    // Normalize
    const total = Object.values(w).reduce((s, v) => s + v, 0);
    for (const key of keys) w[key] = w[key] / total;

    const predicted = predictAll(records, w);
    const validation = validatePredictions(predicted);
    coarseTried++;

    if (validation.accuracy > bestAcc || (validation.accuracy === bestAcc && validation.f1 > bestF1)) {
      bestAcc = validation.accuracy;
      bestPrec = validation.precision;
      bestRec = validation.recall;
      bestF1 = validation.f1;
      bestWeights = cloneWeights(w);
      improvements.push({ accuracy: bestAcc, weights: cloneWeights(bestWeights) });
    }
  }

  // Phase 2: Iterative refinement around best weights
  let strength = 0.08;
  rngCounter = 0;

  for (let i = 0; i < iterations; i++) {
    const w = applyPerturbation(bestWeights, strength, seededRng);
    const predicted = predictAll(records, w);
    const validation = validatePredictions(predicted);

    if (validation.accuracy > bestAcc || (validation.accuracy === bestAcc && validation.f1 > bestF1 + 0.02)) {
      bestAcc = validation.accuracy;
      bestPrec = validation.precision;
      bestRec = validation.recall;
      bestF1 = validation.f1;
      bestWeights = cloneWeights(w);
      improvements.push({ accuracy: bestAcc, weights: cloneWeights(bestWeights) });
      strength *= 0.99; // shrink as we converge
    } else {
      strength *= 1.002; // expand search if plateau
    }
    strength = Math.max(0.01, Math.min(0.25, strength));
  }

  return {
    weights: bestWeights,
    accuracy: bestAcc,
    precision: bestPrec,
    recall: bestRec,
    f1: bestF1,
    iterationsTried: coarseTried + iterations,
    improvements: improvements.slice(-50),
  };
}
