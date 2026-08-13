import type { Candle, SmartMoneyData, OrderFlowData, VolatilityData, RegimeResult } from '@/types/engine';
import type { AuctionResult, IntentResult, MarketIntent } from './types';

export function determineIntent(
  auction: AuctionResult,
  candles: Candle[],
  price: number,
  sm: SmartMoneyData,
  of: OrderFlowData | null,
  vol: VolatilityData | null,
  regime: RegimeResult | null,
): IntentResult {
  const candidates: { intent: MarketIntent; score: number; reason: string }[] = [];
  const atr = vol?.atr || price * 0.01;

  // ================================================================
  // Liquidity & structure checks
  // ================================================================
  const hasBullishBOS = sm.bos === 'bullish';
  const hasBearishBOS = sm.bos === 'bearish';
  const nearSwingHigh = sm.swingHigh.length > 0 && Math.abs(price - sm.swingHigh[sm.swingHigh.length - 1]) / price < 0.005;
  const nearSwingLow = sm.swingLow.length > 0 && Math.abs(price - sm.swingLow[sm.swingLow.length - 1]) / price < 0.005;
  const hasFVG = sm.fvg !== null;
  const hasOB = sm.orderBlock !== null;
  const inDiscount = sm.discountZone && price <= sm.discountZone.upper;
  const inPremium = sm.premiumZone && price >= sm.premiumZone.lower;
  const aboveValue = price > auction.vah;
  const belowValue = price < auction.val;
  const insideValue = price >= auction.val && price <= auction.vah;

  // ================================================================
  // 1. SEEK BUY SIDE LIQUIDITY
  // ================================================================
  if (hasBullishBOS || sm.equalHigh || nearSwingHigh || aboveValue) {
    let score = 0;
    const reasons: string[] = [];
    if (hasBullishBOS) { score += 35; reasons.push('Bullish BOS'); }
    if (sm.equalHigh) { score += 25; reasons.push('Equal highs above'); }
    if (nearSwingHigh) { score += 20; reasons.push('Approaching swing high'); }
    if (aboveValue && auction.excess) { score += 15; reasons.push('Above value with excess — targeting buy stops'); }
    if (score > 20) {
      candidates.push({ intent: 'SEEK_BUY_SIDE_LIQUIDITY', score: Math.min(90, score + 15), reason: reasons.join(', ') });
    }
  }

  // ================================================================
  // 2. SEEK SELL SIDE LIQUIDITY
  // ================================================================
  if (hasBearishBOS || sm.equalLow || nearSwingLow || belowValue) {
    let score = 0;
    const reasons: string[] = [];
    if (hasBearishBOS) { score += 35; reasons.push('Bearish BOS'); }
    if (sm.equalLow) { score += 25; reasons.push('Equal lows below'); }
    if (nearSwingLow) { score += 20; reasons.push('Approaching swing low'); }
    if (belowValue && auction.excess) { score += 15; reasons.push('Below value with excess — targeting sell stops'); }
    if (score > 20) {
      candidates.push({ intent: 'SEEK_SELL_SIDE_LIQUIDITY', score: Math.min(90, score + 15), reason: reasons.join(', ') });
    }
  }

  // ================================================================
  // 3. RETURN TO VALUE
  // ================================================================
  if (aboveValue && !auction.excess) {
    candidates.push({ intent: 'RETURN_TO_VALUE', score: 75, reason: `Price above VAH (${auction.vah.toFixed(2)}) — gravitating to value` });
  } else if (belowValue && !auction.excess) {
    candidates.push({ intent: 'RETURN_TO_VALUE', score: 75, reason: `Price below VAL (${auction.val.toFixed(2)}) — gravitating to value` });
  } else if (insideValue && !auction.acceptance) {
    candidates.push({ intent: 'RETURN_TO_VALUE', score: 55, reason: 'Inside value but not accepted — seeking equilibrium' });
  }

  // ================================================================
  // 4. CONTINUE TREND
  // ================================================================
  if (regime && (regime.regime === 'trending' || regime.regime === 'strong_trend')) {
    const score = (hasFVG || hasOB) ? 85 : 70;
    candidates.push({
      intent: 'CONTINUE_TREND',
      score,
      reason: `${regime.regime} detected${hasFVG ? ' with FVG confirmation' : hasOB ? ' with OB confirmation' : ''}`,
    });
  }

  // ================================================================
  // 5. INVENTORY REBALANCING
  // ================================================================
  if (auction.excess) {
    const side = aboveValue ? 'long' : 'short';
    candidates.push({
      intent: 'INVENTORY_REBALANCING',
      score: 70,
      reason: `${side === 'long' ? 'Long' : 'Short'} excess detected — inventory correction likely`,
    });
  } else if (auction.poorHigh || auction.poorLow) {
    candidates.push({
      intent: 'INVENTORY_REBALANCING',
      score: 65,
      reason: auction.poorHigh ? 'Poor high — weak bulls, potential inventory rebalance' : 'Poor low — weak bears, potential inventory rebalance',
    });
  }

  // ================================================================
  // 6. SHORT SQUEEZE
  // ================================================================
  if (hasBullishBOS && belowValue && of?.deltaPercent && of.deltaPercent > 15) {
    candidates.push({ intent: 'SHORT_SQUEEZE', score: 80, reason: 'Bullish BOS below value + aggressive buying — shorts trapped' });
  } else if (hasBullishBOS && inDiscount && of?.absorption) {
    candidates.push({ intent: 'SHORT_SQUEEZE', score: 70, reason: 'Discount zone + absorption + bullish BOS' });
  }

  // ================================================================
  // 7. LONG SQUEEZE
  // ================================================================
  if (hasBearishBOS && aboveValue && of?.deltaPercent && of.deltaPercent < -15) {
    candidates.push({ intent: 'LONG_SQUEEZE', score: 80, reason: 'Bearish BOS above value + aggressive selling — longs trapped' });
  } else if (hasBearishBOS && inPremium && of?.absorption) {
    candidates.push({ intent: 'LONG_SQUEEZE', score: 70, reason: 'Premium zone + absorption + bearish BOS' });
  }

  // ================================================================
  // 8. DISTRIBUTION
  // ================================================================
  if (inPremium && of?.deltaPercent && of.deltaPercent < -10) {
    candidates.push({ intent: 'DISTRIBUTION', score: 75, reason: 'Premium zone with selling pressure' });
  } else if (inPremium && hasBearishBOS) {
    candidates.push({ intent: 'DISTRIBUTION', score: 65, reason: 'Bearish structure in premium' });
  }

  // ================================================================
  // 9. ACCUMULATION
  // ================================================================
  if (inDiscount && of?.deltaPercent && of.deltaPercent > 10) {
    candidates.push({ intent: 'ACCUMULATION', score: 75, reason: 'Discount zone with buying pressure' });
  } else if (inDiscount && hasBullishBOS) {
    candidates.push({ intent: 'ACCUMULATION', score: 65, reason: 'Bullish structure in discount' });
  }

  // ================================================================
  // 10. PRICE DISCOVERY
  // ================================================================
  const hasRangeExpansion = regime?.regime === 'expansion' || regime?.regime === 'breakout';
  if (hasRangeExpansion && (aboveValue || belowValue) && auction.singlePrints.length > 2) {
    candidates.push({ intent: 'PRICE_DISCOVERY', score: 78, reason: 'Range expansion with single prints — seeking new value' });
  } else if (hasRangeExpansion) {
    candidates.push({ intent: 'PRICE_DISCOVERY', score: 65, reason: 'Range expansion active' });
  }

  // ================================================================
  // SELECT PRIMARY & SECONDARY
  // ================================================================
  if (candidates.length === 0) {
    return {
      primary: 'RETURN_TO_VALUE',
      primaryProbability: 50,
      primaryConfidence: 0.4,
      primaryDuration: '30–60m',
      secondary: null,
      secondaryProbability: 0,
      failureCondition: 'Price remains inside value with no directional catalyst',
      reasons: ['No clear intent detected — defaulting to return to value'],
    };
  }

  candidates.sort((a, b) => b.score - a.score);

  const primary = candidates[0];
  const secondary = candidates.length > 1 ? candidates[1] : null;
  const primaryConf = Math.min(0.9, primary.score / 100);

  // Filter out low-scoring secondaries
  const secondaryIntent = secondary && secondary.score >= 50 ? secondary.intent : null;
  const secondaryProb = secondary && secondary.score >= 50 ? secondary.score : 0;

  // Failure condition
  let failureCondition = 'Price acceptance at current level invalidates intent';
  switch (primary.intent) {
    case 'SEEK_BUY_SIDE_LIQUIDITY':
      failureCondition = 'Rejection from swing high / lower high formation — failed liquidity grab';
      break;
    case 'SEEK_SELL_SIDE_LIQUIDITY':
      failureCondition = 'Rejection from swing low / higher low formation — failed liquidity grab';
      break;
    case 'RETURN_TO_VALUE':
      failureCondition = 'Price continues away from value with expanding range';
      break;
    case 'CONTINUE_TREND':
      failureCondition = 'BOS fails / range expands opposite to trend';
      break;
    case 'SHORT_SQUEEZE':
      failureCondition = 'Price fails to sustain above swing high / bears regain control';
      break;
    case 'LONG_SQUEEZE':
      failureCondition = 'Price fails to sustain below swing low / bulls regain control';
      break;
    default:
      failureCondition = `Price rejects ${primary.intent.toLowerCase().replace(/_/g, ' ')} structure`;
  }

  // Duration estimate
  const estMinutes = estimateMinutes(auction, vol, sm);
  const duration = `${estMinutes}–${estMinutes + 30}m`;

  return {
    primary: primary.intent,
    primaryProbability: primary.score,
    primaryConfidence: parseFloat(primaryConf.toFixed(2)),
    primaryDuration: duration,
    secondary: secondaryIntent,
    secondaryProbability: secondaryProb,
    failureCondition,
    reasons: candidates.slice(0, 3).map(c => `${c.intent.replace(/_/g, ' ')} (${c.score}%): ${c.reason}`),
  };
}

function estimateMinutes(auction: AuctionResult, vol: VolatilityData | null, sm: SmartMoneyData): number {
  const base = 30;
  const atrPct = vol?.atrPercent || 0.01;
  const volAdj = Math.max(15, Math.min(90, base * (1 + (atrPct - 0.5) * 10)));
  if (auction.acceptance) return Math.round(volAdj * 1.2);
  if (auction.excess) return Math.round(volAdj * 0.7);
  return Math.round(volAdj);
}
