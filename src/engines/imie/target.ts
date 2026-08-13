import type { VolatilityData, SmartMoneyData, OrderFlowData, OpenInterestData } from '@/types/engine';
import type { 
  TargetPlan, EntryPoint, StopLoss, Target, TargetScore, TradeManagement,
  DestinationResult, PathResult, AuctionResult, MarketIntent, LiquidityNodeType 
} from './types';

const SOURCE_MAP: Record<LiquidityNodeType, TargetSource> = {
  'EQH': 'LIQUIDITY', 'EQL': 'LIQUIDITY',
  'SWING_HIGH': 'LIQUIDITY', 'SWING_LOW': 'LIQUIDITY',
  'ASIA_HIGH': 'SESSION_HIGH', 'ASIA_LOW': 'SESSION_LOW',
  'LONDON_HIGH': 'SESSION_HIGH', 'LONDON_LOW': 'SESSION_LOW',
  'NEW_YORK_HIGH': 'SESSION_HIGH', 'NEW_YORK_LOW': 'SESSION_LOW',
  'WEEKLY_HIGH': 'WEEKLY_HIGH', 'WEEKLY_LOW': 'WEEKLY_LOW',
  'MONTHLY_HIGH': 'MONTHLY_HIGH', 'MONTHLY_LOW': 'MONTHLY_LOW',
  'ORDER_BLOCK': 'ORDER_BLOCK',
  'BREAKER_BLOCK': 'BREAKER_BLOCK',
  'MITIGATION_BLOCK': 'MITIGATION_BLOCK',
  'FAIR_VALUE_GAP': 'FVG',
  'LIQUIDITY_VOID': 'LVN',
  'POC': 'POC',
  'HVN': 'HVN',
  'LVN': 'LVN',
  'DEVELOPING_POC': 'DEVELOPING_POC',
  'VWAP': 'VWAP',
  'ROUND_NUMBER': 'ROUND_NUMBER',
  'OI_CLUSTER': 'OI_CLUSTER',
  'LIQUIDATION_CLUSTER': 'LIQUIDATION_CLUSTER',
  'DOM_WALL': 'DOM_WALL',
  'WHALE_ORDER': 'LIQUIDITY',
};

export function generateTargetPlan(
  destinations: DestinationResult,
  path: PathResult,
  auction: AuctionResult,
  price: number,
  vol: VolatilityData | null,
  sm: SmartMoneyData,
  intent: MarketIntent,
  of: OrderFlowData | null,
  oi: OpenInterestData | null,
  regime: RegimeResult | null,
): TargetPlan | null {
  const topDest = destinations.topDestination;
  if (!topDest) return null;
  if (topDest.probability < 70) return null;
  if (topDest.distance < price * 0.001) return null;

  const atr = vol?.atr || price * 0.01;
  const isLong = topDest.price > price;
  const dests = destinations.destinations;

  // ================================================================
  // ENTRY ENGINE — Calculate entry using all factors
  // ================================================================
  const entry = calculateEntry(isLong, price, atr, dests, path, auction, sm, of, oi);

  // ================================================================
  // STOP LOSS ENGINE — Generate stops from market structure
  // ================================================================
  const stop = calculateStopLoss(isLong, price, entry.price, atr, dests, path, auction, sm, vol);

  // ================================================================
  // TARGET ENGINE — Generate TP1-TP5 from destination nodes
  // ================================================================
  const targets = calculateTargets(isLong, entry.price, dests, path, auction, stop, vol, sm, of, oi);

  if (targets.length === 0) return null;

  // ================================================================
  // RISK:REWARD & TRADE MANAGEMENT
  // ================================================================
  const risk = Math.abs(entry.price - stop.invalidationPrice);
  const maxTarget = targets[targets.length - 1];
  const overallRR = risk > 0 ? Math.abs(maxTarget.price - entry.price) / risk : 0;

  if (risk < price * 0.0005 || overallRR < 1.5) return null;

  // Position sizing
  const confidence = Math.min(0.95, topDest.probability / 100 * (targets[0].probability / 100));
  const maxRiskAmt = price * 0.02;
  const positionSize = maxRiskAmt / risk;

  // Trade management
  const management = calculateTradeManagement(isLong, entry.price, stop.invalidationPrice, targets, atr);

  // Build reasons & warnings
  const reasons = buildReasons(isLong, entry, stop, targets, auction, intent);
  const warnings = buildWarnings(isLong, targets, auction, sm, of, oi, intent);

  return {
    direction: isLong ? 'long' : 'short',
    entry,
    stop,
    targets,
    management,
    riskReward: parseFloat(overallRR.toFixed(2)),
    maxRisk: parseFloat(maxRiskAmt.toFixed(2)),
    positionSize: parseFloat(positionSize.toFixed(4)),
    confidence: parseFloat(confidence.toFixed(2)),
    explanation: `${isLong ? 'LONG' : 'SHORT'} ${intent.replace(/_/g, ' ')} — ${targets.length} targets, RR ${overallRR.toFixed(2)}`,
    marketObjective: intent,
    expectedAuctionPath: path.primary.map(s => `${s.label}: ${s.price.toFixed(2)}`),
    reasons,
    warnings,
  };
}

// ================================================================
// ENTRY ENGINE
// ================================================================
function calculateEntry(
  isLong: boolean,
  price: number,
  atr: number,
  dests: Destination[],
  path: PathResult,
  auction: AuctionResult,
  sm: SmartMoneyData,
  of: OrderFlowData | null,
  oi: OpenInterestData | null,
): EntryPoint {
  // Find nearest opposite-side liquidity for sweep entry
  const oppositeLiq = isLong 
    ? dests.filter(d => d.price < price).sort((a, b) => b.price - a.price)
    : dests.filter(d => d.price > price).sort((a, b) => a.price - b.price);

  // Check for liquidity sweep opportunity
  if (oppositeLiq.length > 0 && Math.abs(oppositeLiq[0].price - price) / price < 0.008) {
    return {
      type: 'CONFIRMATION',
      price: parseFloat(oppositeLiq[0].price.toFixed(2)),
      confidence: 0.85,
      source: `Sweep ${oppositeLiq[0].node.type} at ${oppositeLiq[0].node.source}`,
      liquidityNode: oppositeLiq[0].node.id,
    };
  }

  // Check VWAP / Developing POC for limit entry
  const vwapNode = dests.find(d => d.node.type === 'VWAP');
  const devPocNode = dests.find(d => d.node.type === 'DEVELOPING_POC');
  const pocNode = dests.find(d => d.node.type === 'POC');

  if (isLong && vwapNode && vwapNode.price < price && price - vwapNode.price < atr) {
    return {
      type: 'LIMIT',
      price: parseFloat(vwapNode.price.toFixed(2)),
      confidence: 0.75,
      source: `Limit at VWAP ${vwapNode.node.source}`,
      liquidityNode: vwapNode.node.id,
    };
  }

  if (!isLong && vwapNode && vwapNode.price > price && vwapNode.price - price < atr) {
    return {
      type: 'LIMIT',
      price: parseFloat(vwapNode.price.toFixed(2)),
      confidence: 0.75,
      source: `Limit at VWAP ${vwapNode.node.source}`,
      liquidityNode: vwapNode.node.id,
    };
  }

  if (devPocNode && Math.abs(devPocNode.price - price) / price < 0.005) {
    return {
      type: 'LIMIT',
      price: parseFloat(devPocNode.price.toFixed(2)),
      confidence: 0.7,
      source: `Limit at Developing POC ${devPocNode.node.source}`,
      liquidityNode: devPocNode.node.id,
    };
  }

  // Check order flow for aggressive entry
  if (of && of.absorption) {
    return {
      type: 'MARKET',
      price: price,
      confidence: 0.8,
      source: 'Market — order flow absorption detected',
    };
  }

  // Default market entry with small offset
  return {
    type: 'MARKET',
    price: parseFloat((isLong ? price * 1.0002 : price * 0.9998).toFixed(2)),
    confidence: 0.6,
    source: 'Market entry near current price',
  };
}

// ================================================================
// STOP LOSS ENGINE
// ================================================================
function calculateStopLoss(
  isLong: boolean,
  price: number,
  entryPrice: number,
  atr: number,
  dests: Destination[],
  path: PathResult,
  auction: AuctionResult,
  sm: SmartMoneyData,
  vol: VolatilityData | null,
): StopLoss {
  const sources: string[] = [];
  let technicalStop = 0;
  let aggressiveStop = 0;
  let conservativeStop = 0;

  if (isLong) {
    // Technical: below nearest swing low / order block / breaker
    const belowNodes = dests.filter(d => d.price < entryPrice).sort((a, b) => b.price - a.price);
    
    const swingLow = belowNodes.find(d => d.node.type === 'SWING_LOW');
    const orderBlock = belowNodes.find(d => d.node.type === 'ORDER_BLOCK');
    const breakerBlock = belowNodes.find(d => d.node.type === 'BREAKER_BLOCK');
    const mitigationBlock = belowNodes.find(d => d.node.type === 'MITIGATION_BLOCK');
    const val = belowNodes.find(d => d.node.type === 'VAL');
    const lvn = belowNodes.find(d => d.node.type === 'LVN');

    // Technical stop = max of structural levels (below entry)
    const structuralLevels = [swingLow, orderBlock, breakerBlock, mitigationBlock, val, lvn]
      .filter(Boolean).map(d => d!.price);
    
    if (structuralLevels.length > 0) {
      technicalStop = Math.max(...structuralLevels);
      sources.push(`Technical: ${swingLow?.node.type || ''} ${orderBlock?.node.type || ''} ${breakerBlock?.node.type || ''}`);
    } else {
      technicalStop = entryPrice - atr * 1.5;
      sources.push('Technical: ATR fallback');
    }

    // Aggressive: just below technical
    aggressiveStop = technicalStop - atr * 0.25;
    sources.push('Aggressive: -0.25 ATR from technical');

    // Conservative: include volatility buffer
    const volBuffer = vol?.atrPercent ? vol.atrPercent * price * 0.5 : atr * 0.5;
    conservativeStop = technicalStop - volBuffer;
    sources.push(`Conservative: -${(volBuffer/price*100).toFixed(2)}% vol buffer`);

  } else {
    // SHORT — above swing high / order block / breaker
    const aboveNodes = dests.filter(d => d.price > entryPrice).sort((a, b) => a.price - b.price);
    
    const swingHigh = aboveNodes.find(d => d.node.type === 'SWING_HIGH');
    const orderBlock = aboveNodes.find(d => d.node.type === 'ORDER_BLOCK');
    const breakerBlock = aboveNodes.find(d => d.node.type === 'BREAKER_BLOCK');
    const mitigationBlock = aboveNodes.find(d => d.node.type === 'MITIGATION_BLOCK');
    const vah = aboveNodes.find(d => d.node.type === 'VAH');
    const lvn = aboveNodes.find(d => d.node.type === 'LVN');

    const structuralLevels = [swingHigh, orderBlock, breakerBlock, mitigationBlock, vah, lvn]
      .filter(Boolean).map(d => d!.price);
    
    if (structuralLevels.length > 0) {
      technicalStop = Math.min(...structuralLevels);
      sources.push(`Technical: ${swingHigh?.node.type || ''} ${orderBlock?.node.type || ''} ${breakerBlock?.node.type || ''}`);
    } else {
      technicalStop = entryPrice + atr * 1.5;
      sources.push('Technical: ATR fallback');
    }

    aggressiveStop = technicalStop + atr * 0.25;
    sources.push('Aggressive: +0.25 ATR from technical');

    const volBuffer = vol?.atrPercent ? vol.atrPercent * price * 0.5 : atr * 0.5;
    conservativeStop = technicalStop + volBuffer;
    sources.push(`Conservative: +${(volBuffer/price*100).toFixed(2)}% vol buffer`);
  }

  // Invalidation = failure path price
  let invalidationPrice = isLong ? conservativeStop : conservativeStop;
  const failureSteps = path.failure;
  if (failureSteps.length > 1) {
    const failPrice = failureSteps[1].price;
    if (isLong && failPrice < conservativeStop) invalidationPrice = failPrice;
    if (!isLong && failPrice > conservativeStop) invalidationPrice = failPrice;
    sources.push(`Invalidation: ${failureSteps[1].label}`);
  }

  // Liquidation distance
  const liquidationDistance = Math.abs(entryPrice - invalidationPrice) / entryPrice;

  return {
    technical: parseFloat(technicalStop.toFixed(2)),
    aggressive: parseFloat(aggressiveStop.toFixed(2)),
    conservative: parseFloat(conservativeStop.toFixed(2)),
    invalidationPrice: parseFloat(invalidationPrice.toFixed(2)),
    liquidationDistance: parseFloat(liquidationDistance.toFixed(4)),
    reason: `Stop derived from ${sources.slice(0, 2).join(', ')}`,
    sources,
  };
}

// ================================================================
// TARGET ENGINE — TP1 through TP5
// ================================================================
function calculateTargets(
  isLong: boolean,
  entryPrice: number,
  dests: Destination[],
  path: PathResult,
  auction: AuctionResult,
  stop: StopLoss,
  vol: VolatilityData | null,
  sm: SmartMoneyData,
  of: OrderFlowData | null,
  oi: OpenInterestData | null,
): Target[] {
  const risk = Math.abs(entryPrice - stop.invalidationPrice);
  const atr = vol?.atr || entryPrice * 0.01;
  const targets: Target[] = [];

  // Collect all candidate destinations in trade direction
  const directionNodes = isLong
    ? dests.filter(d => d.price > entryPrice).sort((a, b) => a.price - b.price)
    : dests.filter(d => d.price < entryPrice).sort((a, b) => b.price - a.price);

  // Add path steps as intermediate targets
  const pathSteps = path.primary.filter(s => 
    isLong ? s.price > entryPrice : s.price < entryPrice
  ).sort((a, b) => isLong ? a.price - b.price : b.price - a.price);

  for (const step of pathSteps) {
    if (!directionNodes.some(d => Math.abs(d.price - step.price) < entryPrice * 0.001)) {
      directionNodes.unshift({
        node: { id: `path_${step.label}`, type: step.label as any, source: step.description } as any,
        price: step.price,
        probability: 75,
        expectedMinutes: 15,
        distance: Math.abs(step.price - entryPrice),
        expectedReaction: 'continuation',
        risk: 30,
        pathScore: 70,
        expectedMove: atr * 1.5,
      });
    }
  }

  // Score and rank each candidate
  for (const node of directionNodes.slice(0, 10)) {
    const dist = Math.abs(node.price - entryPrice);
    const rr = risk > 0 ? dist / risk : 0;
    if (rr < 1.5) continue;

    const score = calculateTargetScore(node, entryPrice, dist, rr, auction, sm, of, oi, vol, isLong);
    const source = SOURCE_MAP[node.node.type] || 'LIQUIDITY';

    targets.push({
      price: parseFloat(node.price.toFixed(2)),
      probability: node.probability,
      rr: parseFloat(rr.toFixed(2)),
      score,
      source,
      destinationNodeId: node.node.id,
      expectedMinutes: node.expectedMinutes,
      distance: parseFloat(dist.toFixed(2)),
      expectedReaction: node.expectedReaction,
    });
  }

  // Sort by score and take top 5
  targets.sort((a, b) => b.score.total - a.score.total);
  return targets.slice(0, 5);
}

// ================================================================
// TARGET SCORING — 8 factors
// ================================================================
function calculateTargetScore(
  node: Destination,
  entryPrice: number,
  dist: number,
  rr: number,
  auction: AuctionResult,
  sm: SmartMoneyData,
  of: OrderFlowData | null,
  oi: OpenInterestData | null,
  vol: VolatilityData | null,
  isLong: boolean,
): TargetScore {
  // 1. Liquidity Score (node strength & probability)
  const liquidity = node.node.strength * 0.6 + node.probability * 0.4;

  // 2. Auction Score (acceptance/rejection alignment)
  let auctionScore = 50;
  if (auction.acceptance) auctionScore = 80;
  else if (auction.rejection) {
    auctionScore = isLong && node.price < auction.vah ? 60 : 
                   !isLong && node.price > auction.val ? 60 : 30;
  }

  // 3. Volume Profile Score (HVN/LVN/POC proximity)
  let vpScore = 50;
  if (node.node.type === 'HVN' || node.node.type === 'POC') vpScore = 85;
  else if (node.node.type === 'LVN' || node.node.type === 'LIQUIDITY_VOID') vpScore = 70;
  else if (node.node.type === 'DEVELOPING_POC') vpScore = 75;

  // 4. Order Flow Score (absorption, delta)
  let ofScore = 50;
  if (of) {
    if (isLong && of.deltaPercent && of.deltaPercent > 10) ofScore = 80;
    else if (!isLong && of.deltaPercent && of.deltaPercent < -10) ofScore = 80;
    if (of.absorption) ofScore += 10;
  }

  // 5. Open Interest Score (OI clusters, build-up)
  let oiScore = 50;
  if (oi && oi.currentOi) {
    if (isLong && (oi.longBuildUp || (oi.oiChange5m || 0) > 3)) oiScore = 80;
    else if (!isLong && (oi.shortBuildUp || (oi.oiChange5m || 0) < -3)) oiScore = 80;
  }

  // 6. Smart Money Score (BOS, CHoCH, FVG, OB alignment)
  let smScore = 50;
  if (sm.bos === (isLong ? 'bullish' : 'bearish')) smScore += 20;
  if (sm.choch === (isLong ? 'bullish' : 'bearish')) smScore += 15;
  if (sm.fvg && ((isLong && sm.fvg.type === 'bullish') || (!isLong && sm.fvg.type === 'bearish'))) smScore += 15;
  if (sm.orderBlock && ((isLong && sm.orderBlock.type === 'bullish') || (!isLong && sm.orderBlock.type === 'bearish'))) smScore += 10;
  smScore = Math.min(95, smScore);

  // 7. Expected Move Score (distance vs expected move)
  const emScore = Math.max(0, 100 - (dist / node.expectedMove) * 100);

  // 8. Risk Reward Score
  const rrScore = Math.min(100, rr * 25);

  // Weighted total
  const total = (
    liquidity * 0.20 +
    auctionScore * 0.15 +
    vpScore * 0.15 +
    ofScore * 0.10 +
    oiScore * 0.10 +
    smScore * 0.15 +
    emScore * 0.10 +
    rrScore * 0.05
  );

  return {
    liquidity: parseFloat(liquidity.toFixed(1)),
    auction: parseFloat(auctionScore.toFixed(1)),
    volumeProfile: parseFloat(vpScore.toFixed(1)),
    orderFlow: parseFloat(ofScore.toFixed(1)),
    openInterest: parseFloat(oiScore.toFixed(1)),
    smartMoney: parseFloat(smScore.toFixed(1)),
    expectedMove: parseFloat(emScore.toFixed(1)),
    riskReward: parseFloat(rrScore.toFixed(1)),
    total: parseFloat(total.toFixed(1)),
  };
}

// ================================================================
// TRADE MANAGEMENT
// ================================================================
function calculateTradeManagement(
  isLong: boolean,
  entryPrice: number,
  invalidationPrice: number,
  targets: Target[],
  atr: number,
): TradeManagement {
  const risk = Math.abs(entryPrice - invalidationPrice);
  const trailingStop = isLong 
    ? parseFloat((targets[0].price - risk * 0.5).toFixed(2))
    : parseFloat((targets[0].price + risk * 0.5).toFixed(2));

  const breakEven = isLong
    ? parseFloat((entryPrice + risk * 0.1).toFixed(2))
    : parseFloat((entryPrice - risk * 0.1).toFixed(2));

  const partialExits = targets.slice(0, 3).map((t, i) => ({
    price: t.price,
    size: 1 / (targets.length + 1) * (i + 1),
  }));

  const positionReduction = [
    { price: targets[0].price, reduction: 0.33 },
    { price: targets[1]?.price || targets[0].price, reduction: 0.33 },
  ];

  const timeStopMinutes = 120;
  const timeStop = isLong
    ? parseFloat((entryPrice - atr * 0.5).toFixed(2))
    : parseFloat((entryPrice + atr * 0.5).toFixed(2));

  return {
    trailingStop,
    breakEven,
    partialExits,
    positionReduction,
    timeStop,
    timeStopMinutes,
  };
}

// ================================================================
// REASONS & WARNINGS
// ================================================================
function buildReasons(
  isLong: boolean,
  entry: EntryPoint,
  stop: StopLoss,
  targets: Target[],
  auction: AuctionResult,
  intent: MarketIntent,
): string[] {
  return [
    `Direction: ${isLong ? 'LONG' : 'SHORT'} | Objective: ${intent.replace(/_/g, ' ')}`,
    `Entry: ${entry.type} at ${entry.price} (${entry.source})`,
    `Invalidation: ${stop.invalidationPrice} (${stop.reason})`,
    `Targets: ${targets.map(t => `${t.price} (${t.source}, ${t.probability}%)`).join(' → ')}`,
    `Auction: ${auction.acceptance ? 'Acceptance' : auction.rejection ? 'Rejection' : 'Testing'} @ POC ${auction.poc.toFixed(2)}`,
    `RR: ${targets.map(t => t.rr.toFixed(2)).join(' / ')}`,
  ];
}

function buildWarnings(
  isLong: boolean,
  targets: Target[],
  auction: AuctionResult,
  sm: SmartMoneyData,
  of: OrderFlowData | null,
  oi: OpenInterestData | null,
  intent: MarketIntent,
): string[] {
  const warnings: string[] = [];

  if (targets[0].rr < 2.0) warnings.push('RR < 2.0 on first target');
  if (targets[0].probability < 75) warnings.push('Primary target probability < 75%');
  if (auction.excess) warnings.push('Auction excess detected — potential reversal');
  if (auction.poorHigh && isLong) warnings.push('Poor high — weak upside structure');
  if (auction.poorLow && !isLong) warnings.push('Poor low — weak downside structure');
  if (sm.bos && sm.bos !== (isLong ? 'bullish' : 'bearish')) warnings.push('BOS conflicts with trade direction');
  if (of && of.deltaPercent) {
    if (isLong && of.deltaPercent < -5) warnings.push('Negative delta during long setup');
    if (!isLong && of.deltaPercent > 5) warnings.push('Positive delta during short setup');
  }
  if (oi && oi.currentOi) {
    if (isLong && oi.shortBuildUp) warnings.push('Short OI build-up conflicts with long');
    if (!isLong && oi.longBuildUp) warnings.push('Long OI build-up conflicts with short');
  }

  return warnings;
}