// Smart Exit Engine
// Continuous exit evaluation for open positions based on live GEX regime, market structure, and premium targets

import type {
  GEXResult,
  MarketStructure,
  ExpiryWindow,
  SmartExitResult,
  SmartExitAction,
} from '@/types/sdm';

// ─── Helper: check if GEX regime flip is adverse to position ───────
function isGEXFlipAdverse(
  gexResult: GEXResult,
  tradeDirection: 'CALL' | 'PUT'
): boolean {
  const regime = gexResult.dealerRegime;

  // CALL long: dealers flipping to SHORT_GAMMA means dealers are now
  // actively hedging against the move (adverse). LONG_GAMMA is favorable.
  // If regime flips to SHORT_GAMMA, dealers resist the move.
  if (tradeDirection === 'CALL') {
    return regime === 'SHORT_GAMMA';
  }

  // PUT long: dealers flipping to LONG_GAMMA means dealers are hedging
  // against downside (adverse). SHORT_GAMMA is favorable for puts.
  // If regime flips to LONG_GAMMA, dealers resist the move.
  if (tradeDirection === 'PUT') {
    return regime === 'LONG_GAMMA';
  }

  return false;
}

// ─── Helper: check if CHoCH is against trade direction ─────────────
function isStructureReversal(
  marketStructure: MarketStructure,
  tradeDirection: 'CALL' | 'PUT'
): boolean {
  const evt = marketStructure.structureEvent;
  if (!evt || evt.type !== 'CHoCH') return false;

  // Bearish CHoCH against CALL long
  if (tradeDirection === 'CALL' && evt.direction === 'BEARISH') return true;
  // Bullish CHoCH against PUT long
  if (tradeDirection === 'PUT' && evt.direction === 'BULLISH') return true;

  return false;
}

// ─── Helper: determine which target level was hit ──────────────────
function detectTargetHit(
  currentPremium: number,
  target1: number,
  target2: number,
  target3: number
): number {
  if (currentPremium >= target3) return 3;
  if (currentPremium >= target2) return 2;
  if (currentPremium >= target1) return 1;
  return 0;
}

// ─── Main: evaluate exit conditions ────────────────────────────────
export function evaluateExit(
  entryPrice: number,
  currentPremium: number,
  stopLoss: number,
  target1: number,
  target2: number,
  target3: number,
  tradeDirection: 'CALL' | 'PUT',
  unrealizedPnLPercent: number,
  gexResult: GEXResult,
  marketStructure: MarketStructure,
  currentWindow: ExpiryWindow
): SmartExitResult {
  const status = gexResult.status === 'OK' && marketStructure.status === 'OK'
    ? 'OK'
    : 'DEGRADED';

  const targetHit = detectTargetHit(currentPremium, target1, target2, target3);
  const gexRegimeFlipped = isGEXFlipAdverse(gexResult, tradeDirection);
  const structureReversal = isStructureReversal(marketStructure, tradeDirection);

  // ── Priority 1: GEX regime flip against position → EXIT ──────────
  if (gexRegimeFlipped) {
    return {
      action: 'EXIT',
      reason: `GEX regime flipped to ${gexResult.dealerRegime} — dealers now hedging against ${tradeDirection} position. Total GEX: ${gexResult.totalGEX.toFixed(0)}.`,
      unrealizedPnLPercent,
      targetHit,
      gexRegimeFlipped: true,
      structureReversal,
      status,
    };
  }

  // ── Priority 2: Structure reversal (CHoCH against position) ──────
  if (structureReversal) {
    const evt = marketStructure.structureEvent!;
    return {
      action: 'EXIT',
      reason: `CHoCH detected ${evt.direction} at ${evt.price.toFixed(1)} — structure reversed against ${tradeDirection} position. Previous trend: ${marketStructure.trend}.`,
      unrealizedPnLPercent,
      targetHit,
      gexRegimeFlipped,
      structureReversal: true,
      status,
    };
  }

  // ── Priority 3: Expiry danger window — take profits if profitable ─
  if (currentWindow === 'danger' && unrealizedPnLPercent > 0) {
    return {
      action: 'BOOK_FULL',
      reason: `Expiry "danger" window active with ${unrealizedPnLPercent.toFixed(1)}% unrealized profit. Theta decay accelerating — booking full position to lock in gains.`,
      unrealizedPnLPercent,
      targetHit,
      gexRegimeFlipped,
      structureReversal,
      status,
    };
  }

  // ── Priority 4: Target 3 hit or reversal structure → BOOK_FULL ───
  if (targetHit >= 3) {
    return {
      action: 'BOOK_FULL',
      reason: `Premium ${currentPremium.toFixed(1)} hit Target 3 (${target3.toFixed(1)}). Booking full position.`,
      unrealizedPnLPercent,
      targetHit: 3,
      gexRegimeFlipped,
      structureReversal,
      status,
    };
  }

  // ── Priority 5: Target 2 hit → BOOK_50 ──────────────────────────
  if (targetHit === 2) {
    return {
      action: 'BOOK_50',
      reason: `Premium ${currentPremium.toFixed(1)} hit Target 2 (${target2.toFixed(1)}). Booking 50% of position.`,
      unrealizedPnLPercent,
      targetHit: 2,
      gexRegimeFlipped,
      structureReversal,
      status,
    };
  }

  // ── Priority 6: Target 1 hit, structure still favorable → BOOK_25 + move stop ──
  if (targetHit === 1 && !structureReversal && !gexRegimeFlipped) {
    return {
      action: 'BOOK_25',
      newStopLoss: entryPrice,
      reason: `Premium ${currentPremium.toFixed(1)} hit Target 1 (${target1.toFixed(1)}) with ${unrealizedPnLPercent.toFixed(1)}% P&L. Booking 25% and moving stop to cost (${entryPrice.toFixed(1)}). Structure: ${marketStructure.trend}, GEX: ${gexResult.dealerRegime}.`,
      unrealizedPnLPercent,
      targetHit: 1,
      gexRegimeFlipped,
      structureReversal,
      status,
    };
  }

  // ── Priority 7: Strong trend in favor, no reversal → TRAIL_STOP ──
  if (unrealizedPnLPercent > 15 && !structureReversal && !gexRegimeFlipped) {
    // Trail stop to lock in 60% of unrealized gain
    const lockedGain = entryPrice + (currentPremium - entryPrice) * 0.6;
    return {
      action: 'TRAIL_STOP',
      newStopLoss: lockedGain,
      reason: `Strong ${tradeDirection} position with ${unrealizedPnLPercent.toFixed(1)}% unrealized gain. Trailing stop to ${lockedGain.toFixed(1)} to lock in 60% of gain (${(unrealizedPnLPercent * 0.6).toFixed(1)}%). Structure: ${marketStructure.trend}, GEX: ${gexResult.dealerRegime}.`,
      unrealizedPnLPercent,
      targetHit,
      gexRegimeFlipped,
      structureReversal,
      status,
    };
  }

  // ── Default: HOLD — no adverse signals, thesis intact ────────────
  return {
    action: 'HOLD',
    reason: `No exit signal. Premium ${currentPremium.toFixed(1)} (P&L: ${unrealizedPnLPercent.toFixed(1)}%). Structure: ${marketStructure.trend}, GEX: ${gexResult.dealerRegime}. Thesis intact — holding position.`,
    unrealizedPnLPercent,
    targetHit,
    gexRegimeFlipped,
    structureReversal,
    status,
  };
}
