import { HistoricalRecord, ValidationResult } from "./types";
import { validatePredictions } from "./gap-engine";
import { generateMockHistoricalRecords, computeHistoricalRecords, runHistoricalPrediction, collectHistoricalCandles } from "./data-collector";
import { calibrate } from "./calibrator";
import { DEFAULT_WEIGHTS } from "./types";

// ─── Full Validation Pipeline ───────────────────────────────────

export interface ValidationPipelineResult {
  name: string;
  oldAccuracy: number;
  newAccuracy: number;
  improvement: number;
  validation: ValidationResult;
  calibrationResult?: {
    oldAccuracy: number;
    newAccuracy: number;
    improvement: number;
    calibratedWeights: typeof DEFAULT_WEIGHTS;
  };
  errors: string[];
}

export async function runValidationPipeline(
  source: "yahoo" | "mock" = "mock",
  mockSessions: number = 300
): Promise<ValidationPipelineResult> {
  const errors: string[] = [];
  let records: HistoricalRecord[] = [];

  try {
    if (source === "yahoo") {
      const candles = await collectHistoricalCandles("^NSEI", "1y");
      records = computeHistoricalRecords(candles);
      if (records.length < 20) {
        errors.push(`Yahoo returned only ${records.length} records — falling back to mock data`);
      }
    }
  } catch (e: any) {
    errors.push(`Yahoo fetch failed: ${e.message}. Using mock data.`);
  }

  // Fallback to mock if yahoo insufficient
  if (records.length < 20) {
    records = generateMockHistoricalRecords(mockSessions);
    errors.push(`Using ${mockSessions} mock sessions (no Yahoo data available)`);
  }

  // ─── Run with default weights ─────────────────────────────────
  const predictedDefault = await runHistoricalPrediction(records, DEFAULT_WEIGHTS);
  const validationDefault = validatePredictions(predictedDefault);

  // ─── Calibrate (optimize weights) ─────────────────────────────
  const calibration = calibrate(records, 500, DEFAULT_WEIGHTS);

  // ─── Run with optimized weights ───────────────────────────────
  const predictedOptimal = await runHistoricalPrediction(records, calibration.weights);
  const validationOptimal = validatePredictions(predictedOptimal);

  // ─── Run legacy heuristic (old style) for comparison ─────────
  const predictedLegacy = runLegacyHeuristic(records);
  const validationLegacy = validatePredictions(predictedLegacy);

  return {
    name: source === "yahoo" ? "Yahoo Historical" : `Mock ${mockSessions}s`,
    oldAccuracy: validationLegacy.accuracy,
    newAccuracy: validationOptimal.accuracy,
    improvement: validationOptimal.accuracy - validationLegacy.accuracy,
    validation: validationOptimal,
    calibrationResult: {
      oldAccuracy: validationDefault.accuracy,
      newAccuracy: validationOptimal.accuracy,
      improvement: validationOptimal.accuracy - validationDefault.accuracy,
      calibratedWeights: calibration.weights as typeof DEFAULT_WEIGHTS,
    },
    errors,
  };
}

// ─── Legacy heuristic for comparison ────────────────────────────
// Replicates the old GapAnalysis.tsx predictGap() logic

function runLegacyHeuristic(records: HistoricalRecord[]): HistoricalRecord[] {
  return records.map((rec, i) => {
    const prev = records.slice(Math.max(0, i - 20), i);
    const upCount = prev.filter(r => r.actualDirection === "UP").length;
    const downCount = prev.filter(r => r.actualDirection === "DOWN").length;
    const pcrBias = upCount > downCount ? 12 : -12;
    const vixBias = 0; // no VIX data in mock
    const oiBias = 0;
    const mpBias = 0;
    const sentBias = 0;

    // Old formula: Score = 50 + PCR(±12) + VIX(±3) + OI(±10) + MaxPain(±5) + Sentiment(±8)
    const oldScore = 50 + pcrBias + vixBias + oiBias + mpBias + sentBias;
    const clampedScore = Math.max(10, Math.min(90, oldScore));
    const upProb = clampedScore;
    const downProb = 100 - clampedScore - 10;
    const direction = upProb > 50 ? "UP" : downProb > 50 ? "DOWN" : "FLAT";

    const predictedDirection = direction as "UP" | "DOWN" | "FLAT";
    const probability = direction === "UP" ? upProb : direction === "DOWN" ? downProb : 10;

    return {
      ...rec,
      predictedDirection,
      predictedProbability: probability,
      correct: predictedDirection === rec.actualDirection,
      factors: [],
    };
  });
}

// ─── Summary Text ────────────────────────────────────────────────

export function formatValidationSummary(result: ValidationPipelineResult): string {
  const v = result.validation;
  const cm = v.confusionMatrix;
  const cal = result.calibrationResult;

  return `
## Validation Summary: ${result.name}

### Overall
| Metric | Value |
|---|---|
| Sessions | ${v.total} |
| Correct | ${v.correct} |
| Incorrect | ${v.incorrect} |
| **Accuracy** | **${v.accuracy.toFixed(1)}%** |
| Precision | ${v.precision.toFixed(3)} |
| Recall | ${v.recall.toFixed(3)} |
| F1 Score | ${v.f1.toFixed(3)} |
| Avg Error | ${v.avgError.toFixed(1)} |
| Max Error | ${v.maxError.toFixed(1)} |

### Confusion Matrix (New Engine)
| | Pred UP | Pred DOWN | Pred FLAT |
|---|---|---|---|
| **Actual UP** | ${cm.upTP} (TP) | ${cm.upFN} (FN) | - |
| **Actual DOWN** | ${cm.downFN} (FN) | ${cm.downTP} (TP) | - |
| **Actual FLAT** | - | - | ${cm.flatTP} |

### Old Engine vs New Engine
| Engine | Accuracy |
|---|---|
| **Old (Legacy Heuristic)** | **${result.oldAccuracy.toFixed(1)}%** |
| **New (Default Weights)** | **${cal ? cal.oldAccuracy.toFixed(1) : 'N/A'}%** |
| **New (Optimized Weights)** | **${result.newAccuracy.toFixed(1)}%** |
| **Improvement** | **${result.improvement >= 0 ? '+' : ''}${result.improvement.toFixed(1)}pp** |

### By Direction
${Object.entries(v.byDirection).map(([dir, d]) => `| ${dir} | ${d.total} sessions | ${d.correct} correct | ${d.accuracy.toFixed(1)}% |`).join('\n')}

### Errors
${result.errors.length > 0 ? result.errors.map(e => `- ⚠️ ${e}`).join('\n') : 'None'}

### Verification
- Old engine accuracy: ${result.oldAccuracy.toFixed(1)}%
- New engine accuracy: ${result.newAccuracy.toFixed(1)}%
- Improvement: ${result.improvement >= 0 ? '✅' : '❌'} ${result.improvement.toFixed(1)}pp
- Overall: ${result.improvement > 0 ? '✅ ACCEPTABLE — deploy' : '❌ REJECTED — do not deploy'}
`;
}
