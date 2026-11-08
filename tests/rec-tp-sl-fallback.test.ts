// rec-tp-sl-fallback.test.ts — Futures recommendation TP/SL fixes
//
// Bug 1 (ai-engine): the recommendation read `plan?.tp[i]` but IMIE's
//   TargetPlan carries `targets` — valid plans either crashed with a TypeError
//   or never displayed their real TPs.
// Bug 2 (ai-engine): when the plan is null and the structural fallback
//   (generateTargets) finds no target that passes score≥70 / R:R≥1.5, TP1-3
//   and R:R rendered as '—' even though a stop existed. Fix: derive an
//   R-multiple ladder (2R/3R/4R) from the stop — same 1:2/1:3/1:4 geometry
//   the repo's option-plan rule uses.
// Bug 3 (imie/validation): the orchestrator passes confidence on a PERCENT
//   scale (Math.round(confidence*100) → 54) but the reject message multiplied
//   by 100 again → "Confidence 5400% below minimum 70%".
import { describe, test, expect } from 'bun:test';
import { deriveRMultipleTargets } from '@/engines/ai/ai-engine';
import { validateTrade as validateImieTrade } from '@/engines/imie/validation';

describe('deriveRMultipleTargets — last-resort TP ladder from the stop', () => {
  test('long: TP1/2/3 at 2R/3R/4R above entry, R:R = 2.0', () => {
    const entry = 75916.08;
    const stop = 75652.24; // below entry (long stop)
    const r = deriveRMultipleTargets(entry, stop, 'long');
    expect(r).not.toBeNull();
    const risk = entry - stop; // 263.84
    expect(r!.tp1).toBeCloseTo(entry + 2 * risk, 1);
    expect(r!.tp2).toBeCloseTo(entry + 3 * risk, 1);
    expect(r!.tp3).toBeCloseTo(entry + 4 * risk, 1);
    expect(r!.riskReward).toBe(2);
    // geometry: entry < tp1 < tp2 < tp3 for a long
    expect(r!.tp1).toBeGreaterThan(entry);
    expect(r!.tp2).toBeGreaterThan(r!.tp1);
    expect(r!.tp3).toBeGreaterThan(r!.tp2);
  });

  test('short: ladder mirrored below entry', () => {
    const entry = 75916.08;
    const stop = 76180.0; // above entry (short stop)
    const r = deriveRMultipleTargets(entry, stop, 'short');
    expect(r).not.toBeNull();
    const risk = stop - entry;
    expect(r!.tp1).toBeCloseTo(entry - 2 * risk, 1);
    expect(r!.tp2).toBeCloseTo(entry - 3 * risk, 1);
    expect(r!.tp3).toBeCloseTo(entry - 4 * risk, 1);
    expect(r!.riskReward).toBe(2);
    expect(r!.tp1).toBeLessThan(entry);
    expect(r!.tp2).toBeLessThan(r!.tp1);
    expect(r!.tp3).toBeLessThan(r!.tp2);
  });

  test('wait direction returns null (no invented targets)', () => {
    expect(deriveRMultipleTargets(100, 99, 'wait')).toBeNull();
  });

  test('zero / invalid risk returns null (no division-by-zero ladder)', () => {
    expect(deriveRMultipleTargets(100, 100, 'long')).toBeNull();
    expect(deriveRMultipleTargets(NaN, 99, 'long')).toBeNull();
    expect(deriveRMultipleTargets(100, Infinity, 'short')).toBeNull();
  });
});

describe('imie validateTrade — confidence message on percent scale', () => {
  test('renders 54% (not 5400%) when confidence=54', () => {
    const res = validateImieTrade({
      aiScore: 80,
      confidence: 54, // orchestrator passes Math.round(conf*100) — PERCENT
      rr: 2,
      destinationProbability: 80,
      dataQuality: 90,
      direction: 'long',
      regime: null,
      smDirection: null,
      oiData: null,
    });
    expect(res.approved).toBe(false);
    const msg = res.rejectReasons.find(r => r.includes('Confidence'));
    expect(msg).toBe('Confidence 54% below minimum 70%');
    expect(msg).not.toContain('5400');
  });

  test('high confidence (≥70) produces no confidence rejection', () => {
    const res = validateImieTrade({
      aiScore: 80,
      confidence: 85,
      rr: 2,
      destinationProbability: 80,
      dataQuality: 90,
      direction: 'long',
      regime: null,
      smDirection: null,
      oiData: null,
    });
    expect(res.rejectReasons.find(r => r.includes('Confidence'))).toBeUndefined();
    expect(res.approved).toBe(true);
  });
});
