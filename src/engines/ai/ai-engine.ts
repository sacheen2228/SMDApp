import type { Candle, EngineScore, AiFinalScore, Recommendation, Trade, OpenInterestData } from '@/types/engine';
import type { OrderBookLevel } from '@/types/engine';
import type { MarketPlaybook } from '@/engines/imie/types';
import { evaluateTrend } from '@/engines/trend/trend-engine';
import { computeOrderFlow } from '@/engines/orderflow/orderflow-engine';
import { evaluateLiquidity } from '@/engines/liquidity/liquidity-engine';
import { evaluateSmartMoney } from '@/engines/smartmoney/smartmoney-engine';
import { evaluateOpenInterest } from '@/engines/openinterest/open-interest-engine';
import { evaluateFunding } from '@/engines/funding/funding-engine';
import { evaluateVolatility } from '@/engines/volatility/volatility-engine';
import { evaluateCorrelation } from '@/engines/correlation/correlation-engine';
import { evaluateMomentum } from '@/engines/momentum/momentum-engine';
import { evaluateVolume } from '@/engines/volume/volume-engine';
import { evaluateMarketRegime } from '@/engines/marketregime/marketregime-engine';
import { evaluateRisk } from '@/engines/risk/risk-engine';
import { computeProbabilities } from '@/engines/probability/probability-engine';
import { imie } from '@/engines/imie/orchestrator';
// @deprecated — target engine logic consolidated into IMIE
import { generateTargets } from '@/engines/target/target-engine';
import { generateStopLoss } from '@/engines/target/stop-loss-engine';
import { validateTrade } from '@/engines/target/trade-filter';

export interface EngineWeights {
  trend: number;
  orderFlow: number;
  openInterest: number;
  liquidity: number;
  funding: number;
  momentum: number;
  smartMoney: number;
  volume: number;
  correlation: number;
  volatility: number;
  risk: number;
}

const DEFAULT_WEIGHTS: EngineWeights = {
  trend: 0.15,
  orderFlow: 0.15,
  openInterest: 0.15,
  liquidity: 0.10,
  funding: 0.10,
  momentum: 0.10,
  smartMoney: 0.10,
  volume: 0.05,
  correlation: 0.05,
  volatility: 0.05,
  risk: 0.10,
};

export function computeGrade(score: number): { grade: string; quality: string; risk: 'low' | 'medium' | 'high' } {
  if (score >= 90) return { grade: 'A+', quality: 'Excellent', risk: 'low' };
  if (score >= 80) return { grade: 'A', quality: 'Very Good', risk: 'low' };
  if (score >= 70) return { grade: 'B+', quality: 'Good', risk: 'medium' };
  if (score >= 60) return { grade: 'B', quality: 'Above Average', risk: 'medium' };
  if (score >= 50) return { grade: 'C+', quality: 'Average', risk: 'medium' };
  if (score >= 40) return { grade: 'C', quality: 'Below Average', risk: 'high' };
  if (score >= 30) return { grade: 'D', quality: 'Poor', risk: 'high' };
  return { grade: 'F', quality: 'Very Poor', risk: 'high' };
}

export function analyzeMarket(
  candles: Candle[],
  trades: Trade[],
  prevTrades: Trade[],
  orderBookLevels: OrderBookLevel[],
  bidVol: number,
  askVol: number,
  prevBidVol: number,
  prevAskVol: number,
  prevPrice: number,
  price: number,
  returns: number[],
  btcReturns: number[],
  oiData: OpenInterestData | null = null,
  fundingRaw: {
    currentRate: number | null;
    predictedRate: number | null;
    lastPrice: number | null;
    markPrice: number | null;
    volume: number | null;
    high24h: number | null;
    low24h: number | null;
    priceChange: number | null;
  } | null = null,
  weights: EngineWeights = DEFAULT_WEIGHTS,
): { aiScore: AiFinalScore; recommendation: Recommendation; probabilities: ReturnType<typeof computeProbabilities>; regime: ReturnType<typeof evaluateMarketRegime>; playbook: MarketPlaybook } {
  const engines: Record<string, EngineScore> = {};
  const results: Record<string, any> = {};

  const trendResult = evaluateTrend(candles, price);
  engines.trend = trendResult;
  results.trend = trendResult;

  const ofResult = computeOrderFlow(trades, prevTrades, bidVol, askVol);
  engines.orderFlow = ofResult.score;
  results.orderFlow = ofResult.data;

  const oiResult = oiData
    ? { data: oiData, score: { score: oiData.currentOi ? 60 + (oiData.oiChange5m || 0) * 10 : 50, confidence: oiData.currentOi ? 0.7 : 0, bullishProb: oiData.oiTrend === 'rising' ? 60 : 33, bearishProb: oiData.oiTrend === 'falling' ? 60 : 33, neutralProb: oiData.oiTrend === 'neutral' ? 60 : 34, reasons: oiData.currentOi ? [`OI: ${oiData.currentOi.toFixed(1)}`, `Change: ${oiData.oiChange5m?.toFixed(2)}%`] : ['OI unavailable'] } }
    : evaluateOpenInterest(null, price, prevPrice);
  engines.openInterest = oiResult.score;
  results.openInterest = oiResult.data;

  const liqResult = evaluateLiquidity(orderBookLevels, trades, price);
  engines.liquidity = liqResult.score;
  results.liquidity = liqResult.data;

  const fundResult = evaluateFunding(fundingRaw);
  engines.funding = fundResult.score;
  results.funding = fundResult.data;

  const momResult = evaluateMomentum(candles);
  engines.momentum = momResult;
  results.momentum = momResult;

  const smResult = evaluateSmartMoney(candles, price);
  engines.smartMoney = smResult.score;
  results.smartMoney = smResult.data;

  const volResult = evaluateVolume(candles);
  engines.volume = volResult;
  results.volume = volResult;

  const corrResult = evaluateCorrelation(returns, btcReturns);
  engines.correlation = corrResult.score;
  results.correlation = corrResult.data;

  const voltyResult = evaluateVolatility(candles, price);
  engines.volatility = voltyResult.score;
  results.volatility = voltyResult.data;

  const regimeResult = evaluateMarketRegime(candles, price);
  results.regime = regimeResult;

  const bullScore = (
    engines.trend.score * weights.trend +
    engines.orderFlow.score * weights.orderFlow +
    engines.openInterest.score * weights.openInterest +
    engines.liquidity.score * weights.liquidity +
    engines.funding.score * weights.funding +
    engines.momentum.score * weights.momentum +
    engines.smartMoney.score * weights.smartMoney +
    engines.volume.score * weights.volume +
    engines.correlation.score * weights.correlation +
    engines.volatility.score * weights.volatility
  );
  const totalW = Object.values(weights).reduce((s, w) => s + w, 0);
  const rawScore = totalW > 0 ? bullScore / totalW : 50;

  const avgBullProb = Object.values(engines).reduce((s, e) => s + e.bullishProb * e.confidence, 0);
  const avgBearProb = Object.values(engines).reduce((s, e) => s + e.bearishProb * e.confidence, 0);
  const totalConf = Object.values(engines).reduce((s, e) => s + e.confidence, 0);

  const side = avgBullProb > avgBearProb && totalConf > 0 ? 'long'
    : avgBearProb > avgBullProb && totalConf > 0 ? 'short'
    : 'wait';

  const riskResult = evaluateRisk(
    results.volatility?.atr || 0,
    results.volatility?.atrPercent || 0,
    price,
    Math.max(avgBullProb, avgBearProb) / 100,
    side,
  );
  engines.risk = riskResult.score;
  results.risk = riskResult.result;

  let finalScore = 0;
  let weightSum = 0;
  const weightMap: Record<string, number> = weights as any;
  for (const [key, e] of Object.entries(engines)) {
    const w = weightMap[key] || 0;
    finalScore += e.score * w;
    weightSum += w;
  }
  finalScore = weightSum > 0 ? finalScore / weightSum : 50;
  const finalConf = totalConf / (Object.keys(engines).length || 1);

  const probabilities = computeProbabilities(
    engines,
    results.volatility?.atrPercent || 0,
    price,
  );

  // ===== INSTITUTIONAL MARKET INTELLIGENCE ENGINE =====
  const smData = results.smartMoney;

  const playbook: MarketPlaybook = imie.analyze({
    candles,
    levels: orderBookLevels.map(l => ({ price: l.price, size: l.size, isBid: l.isBid })),
    price,
    sm: smData,
    of: results.orderFlow || null,
    vol: results.volatility || null,
    regime: regimeResult,
    oi: oiData,
    pair: '',
  }, { mode: 'full' });

  const plan = playbook.plan;
  const validation = playbook.validation;

  // Fallback: use IMIE plan if valid, else old target engine
  const atr = results.volatility?.atr || price * 0.01;
  const atrPercent = results.volatility?.atrPercent || 1;
  const expectedMove = probabilities.expectedMove || atr;
  const smDirection = smData?.bos || smData?.choch || null;

  const fallbackTargets = !plan || !validation.approved ? generateTargets(
    candles, orderBookLevels, price, side, smData, oiData, atr, expectedMove, regimeResult,
  ) : null;
  const fallbackSL = !plan || !validation.approved ? generateStopLoss(candles, orderBookLevels, price, side, smData, atr) : null;

  const { grade, quality, risk } = computeGrade(finalScore);
  const tempScoreForValidation: AiFinalScore = { overallScore: Math.round(finalScore), grade, quality, expectedWinRate: 0, risk, engines };
  const fallbackValidation = !plan || !validation.approved ? validateTrade(tempScoreForValidation, fallbackTargets?.riskReward || 0, side, regimeResult, smDirection, oiData, false) : null;

  // ===== RECOMMENDATION =====
  const allReasons: string[] = [];
  for (const e of Object.values(engines)) {
    allReasons.push(...e.reasons);
  }

  if (plan) {
    allReasons.push(plan.explanation);
    allReasons.push(...validation.rejectReasons);
  } else {
    allReasons.push(fallbackSL?.explanation || '');
    allReasons.push(fallbackTargets?.explanation || '');
    allReasons.push(...(fallbackValidation?.warnings || []).slice(0, 3));
  }

  const targetWinRate = plan ? plan.confidence * 100 : (fallbackTargets?.expectedWinRate || 50);
  const winRate = Math.max(probabilities.confidence * finalConf * 100, targetWinRate);

  const recommendation: Recommendation = {
    direction: plan?.direction || side,
    entry: plan?.entry.price || price,
    stop: plan?.stop.price || fallbackSL?.price || null,
    tp1: plan?.tp[0]?.price || fallbackTargets?.tp1?.price || null,
    tp2: plan?.tp[1]?.price || fallbackTargets?.tp2?.price || null,
    tp3: plan?.tp[2]?.price || fallbackTargets?.tp3?.price || null,
    riskReward: plan?.riskReward || fallbackTargets?.riskReward || null,
    expectedWinRate: Math.round(winRate),
    confidence: Math.round(plan ? plan.confidence * 100 : finalConf * 100),
    positionSize: plan ? plan.positionSize : (results.risk?.positionSize || null),
    leverage: results.risk?.leverage || null,
    liquidationPrice: results.risk?.liquidationPrice || null,
    fundingImpact: fundingRaw?.currentRate ?? null,
    reasons: allReasons.filter(r => r).slice(0, 10),
    warnings: validation.rejectReasons.length > 0 ? validation.rejectReasons : (fallbackValidation?.warnings || []).filter(w => w.includes('<') || w.includes('conflict') || w.includes('unavailable') || w.includes('low volatility') || w.includes('reversal')),
    marketStructureExplanation: playbook.summary.playbook.join(' | '),
    expectedMoveExplanation: playbook.intent.primaryDuration,
    riskExplanation: plan?.stop.source || fallbackSL?.explanation || '',
  };

  return {
    aiScore: {
      overallScore: Math.round(finalScore),
      grade,
      tradeQuality: quality,
      expectedWinRate: Math.round(winRate),
      risk,
      engines,
    },
    recommendation,
    probabilities,
    regime: regimeResult,
    playbook,
  };
}
