import type { TradeValidation } from './types';
import type { RegimeResult, OpenInterestData, AiFinalScore } from '@/types/engine';

export function validateTrade(
  aiScore: AiFinalScore,
  riskReward: number | null,
  side: 'long' | 'short' | 'wait',
  regime: RegimeResult,
  smDirection: 'bullish' | 'bearish' | null,
  oiData: OpenInterestData | null,
  requiresDerivatives: boolean = false,
): TradeValidation {
  const warnings: string[] = [];
  let score = aiScore.overallScore;
  let confidence = 0;
  let dataQuality = 100;

  for (const e of Object.values(aiScore.engines)) {
    confidence += e.confidence;
    if (e.confidence === 0) dataQuality -= 5;
  }
  confidence = confidence / (Object.keys(aiScore.engines).length || 1);
  dataQuality = Math.max(0, dataQuality);

  // 1. RR >= 1.5
  if (riskReward === null || riskReward < 1.5) {
    warnings.push(`RR ${riskReward?.toFixed(2) || 'N/A'}:1 < 1.5 — trade rejected`);
  } else {
    warnings.push(`RR ${riskReward.toFixed(2)}:1 ✓`);
  }

  // 2. AI Score >= 70
  if (score < 70) {
    warnings.push(`AI Score ${score}/100 < 70 — insufficient conviction`);
  } else {
    warnings.push(`AI Score ${score}/100 ✓`);
  }

  // 3. Confidence >= 70%
  const confPct = Math.round(confidence * 100);
  if (confPct < 70) {
    warnings.push(`Confidence ${confPct}% < 70% — engines diverging`);
  } else {
    warnings.push(`Confidence ${confPct}% ✓`);
  }

  // 4. Trend conflicts with Smart Money
  if (smDirection && side !== 'wait') {
    const trendUp = aiScore.engines.trend?.bullishProb > aiScore.engines.trend?.bearishProb;
    const trendDown = aiScore.engines.trend?.bearishProb > aiScore.engines.trend?.bullishProb;
    if ((side === 'long' && trendDown && smDirection === 'bearish') ||
        (side === 'short' && trendUp && smDirection === 'bullish')) {
      warnings.push('Trend conflicts with Smart Money structure — conflicting signals');
    }
  }

  // 5. Data Quality < 75%
  if (dataQuality < 75) {
    warnings.push(`Data quality ${dataQuality}% < 75% — unreliable inputs`);
  }

  // 6. OI unavailable AND strategy requires derivatives
  if (requiresDerivatives && (!oiData || !oiData.currentOi)) {
    warnings.push('OI unavailable — cannot confirm derivatives conviction');
  }

  // 7. Regime awareness
  if (regime.regime === 'compression') {
    warnings.push('Market in compression — low volatility, wide stops advised');
  }
  if (regime.regime === 'fake_breakout') {
    warnings.push('Fake breakout detected — high reversal risk');
  }

  const criticalFailures = warnings.filter(w =>
    w.includes('< 1.5') ||
    w.includes('< 70') ||
    w.includes('< 75%') ||
    w.includes('conflicts') ||
    w.includes('unavailable'),
  );

  const passed = criticalFailures.length === 0 && side !== 'wait';

  return { passed, score, confidence: confPct, dataQuality, warnings };
}
