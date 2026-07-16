// Unit tests for Module 3 — Premium Projection Engine
// Run: bun run src/lib/institutional-tpsl/__tests__/premium.test.ts

import { projectPremium, premiumCapFactor } from '../premium-projection';
import { IVRegime } from '../volatility-engine';

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}

console.log('\n=== Module 3: Premium Projection Engine ===');

// ── Test A: delta-only, within cap ──
{
  const r = projectPremium({ ltp: 100, type: 'CE', delta: 0.5, iv: 15, dte: 1, expectedIndexMove: 200, ivRegime: 'NORMAL' });
  assert(Math.abs(r.projectedPremiumMove - 100) < 1e-9, 'A: 0.5δ·200 = 100');
  assert(Math.abs(r.premiumTarget - 200) < 1e-9, 'A: target = ltp + move = 200');
  assert(r.realistic === true, 'A: realistic (within 3x cap)');
  assert(Math.abs(r.gammaAdjustment) < 1e-9, 'A: no gamma term');
}

// ── Test B: unrealistically large move → capped, flagged ──
{
  const r = projectPremium({ ltp: 100, type: 'CE', delta: 0.6, iv: 15, dte: 1, expectedIndexMove: 1000, ivRegime: 'NORMAL' });
  assert(r.projectedPremiumMove <= 300 + 1e-9, 'B: capped at 3x ltp = 300');
  assert(r.realistic === false, 'B: flagged unrealistic (raw 600 > cap)');
  assert(Math.abs(r.rawProjected - 600) < 1e-9, 'B: raw projected = 600');
}

// ── Test C: gamma convexity adds ──
{
  const r = projectPremium({ ltp: 100, type: 'CE', delta: 0.5, gamma: 0.01, iv: 15, dte: 1, expectedIndexMove: 200, ivRegime: 'HIGH' });
  // linear 100 + 0.5*0.01*40000 = 100 + 200 = 300
  assert(Math.abs(r.rawProjected - 300) < 1e-9, 'C: raw = linear + gammaTerm (300)');
  assert(Math.abs(r.gammaAdjustment - 200) < 1e-9, 'C: gamma adjustment = 200');
  assert(r.projectedPremiumMove <= 300 + 1e-9, 'C: within cap');
}

// ── Test D: cap factor by horizon ──
{
  assert(premiumCapFactor(1) === 3.0, 'D: dte<=1 → 3.0x');
  assert(premiumCapFactor(3) === 2.0, 'D: dte<=3 → 2.0x');
  assert(premiumCapFactor(7) === 1.5, 'D: dte<=7 → 1.5x');
  assert(premiumCapFactor(20) === 1.25, 'D: dte>7 → 1.25x');
}

// ── Test E: sign-agnostic magnitude for PE ──
{
  const r = projectPremium({ ltp: 50, type: 'PE', delta: 0.5, iv: 15, dte: 2, expectedIndexMove: 100, ivRegime: 'NORMAL' });
  // magnitude: 0.5*100=50, cap 2x*50=100 → 50
  assert(Math.abs(r.projectedPremiumMove - 50) < 1e-9, 'E: PE magnitude = 50');
  assert(Math.abs(r.premiumTarget - 100) < 1e-9, 'E: favorable target = 100 (orchestrator applies direction)');
}

console.log(`\nModule 3 result: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
