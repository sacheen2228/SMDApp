// Unit tests for Module 4 — Expiry Model
// Run: bun run src/lib/institutional-tpsl/__tests__/expiry.test.ts

import { analyzeExpiry } from '../expiry-model';

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}

console.log('\n=== Module 4: Expiry Model ===');

// ── Test A: weekly Monday = carry, tp>1 ──
{
  const r = analyzeExpiry({ kind: 'WEEKLY', dayOfWeek: 1, dte: 4 });
  assert(r.profile === 'WEEKLY_MONDAY', 'A: profile WEEKLY_MONDAY');
  assert(r.projectionStyle === 'CARRY', 'A: carry style');
  assert(r.tpFactor > 1, 'A: tpFactor > 1');
  assert(r.thetaDecay < 0.3, 'A: low theta early week');
}

// ── Test B: weekly Thursday = expiry, tightest ──
{
  const r = analyzeExpiry({ kind: 'WEEKLY', dayOfWeek: 4, dte: 1 });
  assert(r.profile === 'WEEKLY_THURSDAY', 'B: profile WEEKLY_THURSDAY');
  assert(r.projectionStyle === 'SCALP', 'B: scalp style');
  assert(r.slFactor < 0.8, 'B: tightest stop (slFactor < 0.8)');
  assert(r.thetaDecay > 0.8, 'B: extreme theta on expiry');
}

// ── Test C: monthly far (>10d) = carry ──
{
  const r = analyzeExpiry({ kind: 'MONTHLY', dayOfWeek: 3, dte: 18 });
  assert(r.profile === 'MONTHLY_FAR', 'C: profile MONTHLY_FAR');
  assert(r.projectionStyle === 'CARRY', 'C: carry');
  assert(r.slFactor > 1, 'C: widest stop far out');
  assert(r.tpFactor > 1.2, 'C: highest tpFactor');
}

// ── Test D: monthly mid (5-10d) ──
{
  const r = analyzeExpiry({ kind: 'MONTHLY', dayOfWeek: 2, dte: 8 });
  assert(r.profile === 'MONTHLY_MID', 'D: profile MONTHLY_MID');
}

// ── Test E: monthly last week (2-4d) ──
{
  const r = analyzeExpiry({ kind: 'MONTHLY', dayOfWeek: 2, dte: 3 });
  assert(r.profile === 'MONTHLY_LASTWEEK', 'E: profile MONTHLY_LASTWEEK');
  assert(r.thetaDecay > 0.5, 'E: elevated theta last week');
}

// ── Test F: monthly expiry day ──
{
  const r = analyzeExpiry({ kind: 'MONTHLY', dayOfWeek: 4, dte: 1, isExpiryDay: true });
  assert(r.profile === 'MONTHLY_EXPIRY', 'F: profile MONTHLY_EXPIRY');
  assert(r.slFactor <= 0.7, 'F: tightest monthly stop (<=0.7)');
  assert(r.projectionStyle === 'SCALP', 'F: scalp');
}

// ── Test G: theta monotonic — nearer expiry → higher theta (weekly) ──
{
  const mon = analyzeExpiry({ kind: 'WEEKLY', dayOfWeek: 1, dte: 4 }).thetaDecay;
  const tue = analyzeExpiry({ kind: 'WEEKLY', dayOfWeek: 2, dte: 3 }).thetaDecay;
  const wed = analyzeExpiry({ kind: 'WEEKLY', dayOfWeek: 3, dte: 2 }).thetaDecay;
  const thu = analyzeExpiry({ kind: 'WEEKLY', dayOfWeek: 4, dte: 1 }).thetaDecay;
  assert(mon < tue && tue < wed && wed < thu, `G: theta increases into expiry (${mon},${tue},${wed},${thu})`);
}

console.log(`\nModule 4 result: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
