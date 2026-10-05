// ═══════════════════════════════════════════════════════════════════════════
// Underlying Levels — derive spot entry/SL/TP from the shared snapshot's
// market structure (supports/resistances/swings/pdh-pdl).
// Pure function of AgentContext: no network, no invented levels — when the
// structure cannot express a valid stop/target pair it fails with an honest
// reason and the caller turns that into NO_TRADE (§3: never fabricate).
// Used by both engines (option engine then re-prices to premium space via
// greeks.spotToPremiumLevels — the established production conversion).
// ═══════════════════════════════════════════════════════════════════════════

import type { AgentContext } from './agent-contract';

export type UnderlyingLevels =
  | { ok: true; entry: number; stopLoss: number; target1: number; target2: number }
  | { ok: false; reason: string };

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

/**
 * Long (BUY / CE): stop = nearest level below spot, targets = resistances above.
 * Short (SELL / PE): stop = nearest level above spot, targets = supports below.
 * Level pools: explicit support/resistance arrays first, then swing high/low,
 * then previous day high/low. All levels must sit on the correct side of spot.
 */
export function deriveUnderlyingLevels(ctx: AgentContext, long: boolean): UnderlyingLevels {
  const spot = num(ctx.spot);
  if (!(spot > 0)) {
    return { ok: false, reason: 'Spot unavailable — no underlying entry' };
  }

  const below = (ctx.supportLevels || [])
    .map(num)
    .filter(x => x > 0 && x < spot)
    .sort((a, b) => b - a); // nearest below first
  const above = (ctx.resistanceLevels || [])
    .map(num)
    .filter(x => x > 0 && x > spot)
    .sort((a, b) => a - b); // nearest above first

  if (long) {
    const swingStop = num(ctx.swingLow) > 0 && num(ctx.swingLow) < spot ? num(ctx.swingLow) : 0;
    const pdlStop = num(ctx.pdl) > 0 && num(ctx.pdl) < spot ? num(ctx.pdl) : 0;
    const finalStop = below[0] || swingStop || pdlStop;
    const target1 = above[0] ?? 0;
    if (!(finalStop > 0)) {
      return { ok: false, reason: 'No underlying stop level below spot (support/swing/pdl missing)' };
    }
    if (!(target1 > spot)) {
      return { ok: false, reason: 'No resistance level above spot for target' };
    }
    const target2 = above[1] ?? target1;
    return { ok: true, entry: spot, stopLoss: finalStop, target1, target2 };
  }

  const swingStop = num(ctx.swingHigh) > 0 && num(ctx.swingHigh) > spot ? num(ctx.swingHigh) : 0;
  const pdhStop = num(ctx.pdh) > 0 && num(ctx.pdh) > spot ? num(ctx.pdh) : 0;
  const finalStop = above[0] || swingStop || pdhStop;
  const target1 = below[0] ?? 0;
  if (!(finalStop > 0)) {
    return { ok: false, reason: 'No underlying stop level above spot (resistance/swing/pdh missing)' };
  }
  if (!(target1 > 0 && target1 < spot)) {
    return { ok: false, reason: 'No support level below spot for target' };
  }
  const target2 = below[1] ?? target1;
  return { ok: true, entry: spot, stopLoss: finalStop, target1, target2 };
}
