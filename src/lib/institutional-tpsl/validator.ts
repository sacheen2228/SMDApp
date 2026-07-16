// ═══════════════════════════════════════════════════════════════════
// MODULE 15 — TRADE VALIDATOR
// Hard gates. A trade is only valid if ALL mandatory checks pass.
// Each check is independently reported so the UI can explain rejections.
// ═══════════════════════════════════════════════════════════════════

import { StructureReport } from './structure-analyzer';
import { LiquidityReport } from './liquidity';
import { RiskReport } from './risk';
import { DynamicTPReport } from './tp-engine';
import { OrderFlowReport } from './order-flow';
import { PriceActionReport } from './price-action';

export interface ValidationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ValidationResult {
  passed: boolean;
  failures: string[];
  checks: ValidationCheck[];
}

export interface ValidationInput {
  structure: StructureReport;
  liquidity: LiquidityReport;
  risk: RiskReport;
  tp: DynamicTPReport;
  orderFlow: OrderFlowReport;
  priceAction: PriceActionReport;
  premiumRealistic: boolean;
  entry: number;
  slIndex: number;
}

// Strategy-configurable gate enforcement. Each flag controls whether a hard
// gate is enforced (true) or downgraded to informational (false). This lets a
// near-ATM premium-buying strategy (ZERO_HERO) opt out of strict
// structure-alignment / tight-spread / premium-realism gates that are designed
// for high-confluence SMC setups, while SMC keeps everything enforced.
export interface ValidationOptions {
  requireStructureAlignment?: boolean; // default true
  maxSpreadPct?: number;               // default 0.15
  maxSLPct?: number;                   // default 0.04
  requirePremiumRealistic?: boolean;   // default true
  requireNoFailedBreakout?: boolean;   // default true
  requireNotExhausted?: boolean;       // default true
}

export function validateTrade(input: ValidationInput, opts: ValidationOptions = {}): ValidationResult {
  const { structure, liquidity, risk, tp, orderFlow, priceAction, premiumRealistic, entry, slIndex } = input;
  const requireStructure = opts.requireStructureAlignment ?? true;
  const maxSpread = opts.maxSpreadPct ?? 0.15;
  const maxSL = opts.maxSLPct ?? 0.04;
  const requirePremium = opts.requirePremiumRealistic ?? true;
  const requireBreakout = opts.requireNoFailedBreakout ?? true;
  const requireExhaust = opts.requireNotExhausted ?? true;
  const checks: ValidationCheck[] = [];

  // Structure alignment: full OB/FVG + BOS confluence (clarity=CLEAR) is NOT
  // required to pass — it raises the confidence grade instead. A trade with
  // contrary structure is rejected UNLESS the strategy opts out (e.g. ZERO_HERO
  // near-ATM premium buying, which is direction-agnostic at entry).
  const structureOk = requireStructure ? structure.alignedWithTrade : true;
  checks.push({
    name: 'Structure Alignment',
    ok: structureOk,
    detail: `enforced=${requireStructure}, aligned=${structure.alignedWithTrade}, clarity=${structure.clarity}`,
  });

  const liquidityOk = liquidity.liquidityScore >= 30 && liquidity.spreadPct < Math.max(0.2, maxSpread);
  checks.push({
    name: 'Liquidity Sufficient',
    ok: liquidityOk,
    detail: `liqScore=${liquidity.liquidityScore.toFixed(0)}, spread=${(liquidity.spreadPct * 100).toFixed(1)}%`,
  });

  const dirSign = risk.direction === 'BULLISH' ? 1 : -1;
  const reward = (tp.tp1 - entry) * dirSign;
  const loss = (entry - slIndex) * dirSign;
  const rr = loss > 0 ? reward / loss : 0;
  const rrOk = rr >= 1.5;
  checks.push({
    name: 'Reward:Risk ≥ 1.5',
    ok: rrOk,
    detail: `RR=${rr.toFixed(2)} (tp1 reward ${reward.toFixed(1)}, risk ${loss.toFixed(1)})`,
  });

  const slOk = Math.abs(entry - slIndex) > 0 && Math.abs(entry - slIndex) / entry < maxSL;
  checks.push({
    name: 'Stop Plausible',
    ok: slOk,
    detail: `SL distance ${((Math.abs(entry - slIndex) / entry) * 100).toFixed(2)}% of spot (max ${maxSL * 100}%)`,
  });

  const spreadOk = liquidity.spreadPct < maxSpread;
  checks.push({ name: 'Tight Spread', ok: spreadOk, detail: `spread=${(liquidity.spreadPct * 100).toFixed(1)}% (max ${(maxSpread * 100).toFixed(0)}%)` });

  const premiumOk = requirePremium ? premiumRealistic : true;
  checks.push({ name: 'Premium Realistic', ok: premiumOk, detail: `enforced=${requirePremium}, realistic=${premiumRealistic}` });

  const flowOk = requireBreakout ? !orderFlow.failedBreakout : true;
  checks.push({ name: 'No Failed Breakout', ok: flowOk, detail: `enforced=${requireBreakout}, failedBreakout=${orderFlow.failedBreakout}` });

  const exhaustOk = requireExhaust ? !priceAction.exhaustion : true;
  checks.push({ name: 'Not Exhausted', ok: exhaustOk, detail: `enforced=${requireExhaust}, exhaustion=${priceAction.exhaustion}` });

  const failures = checks.filter((c) => !c.ok).map((c) => c.name);
  return { passed: failures.length === 0, failures, checks };
}
