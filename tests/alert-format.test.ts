// ═══════════════════════════════════════════════════════════════════════════
// ALERT FORMAT + SCANNER NULL-SAFETY TESTS
//
// Regression coverage for 29-Sep-2026 bugs:
//   1. Queue-format TP/SL alerts printed "SL: ₹-", "Exit: ₹-" because the
//      audit emit omitted sl/tp/exit → formatter must render real values
//      (SL, exit, TP1/TP2/TP3) + hit timestamp.
//   2. intraday-scanner.analyzeMarketDirection crashed on null PCR/VIX
//      ("Cannot read properties of null (reading 'toFixed')") → 32 × 500 on
//      /api/scanner and every 15-min intraday-scan cron run.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'bun:test';
import { formatEventForTelegram } from '../src/lib/hermes/telegram-queue';
import { analyzeMarketDirection } from '../src/lib/intraday-scanner';
import type { HermesEvent } from '../src/lib/hermes/event-bus';

// Hit time: 29-Sep-2026 11:08 IST
const HIT_TS = '2026-09-29T05:38:00.000Z';

function ev(eventType: string, payload: Record<string, any>): HermesEvent {
  return {
    eventId: 'test-evt-1',
    eventType: eventType as HermesEvent['eventType'],
    symbol: 'TCS',
    tradeId: 'api-test-1',
    payload,
    timestamp: HIT_TS,
    delivered: false,
    retryCount: 0,
  };
}

describe('queue alert format — SL/TP values + hit timestamp', () => {
  it('SL_HIT shows SL, exit, TP1/TP2 and the hit timestamp', () => {
    const text = formatEventForTelegram(ev('SL_HIT', {
      direction: 'BUY PUT',
      entry: 23.35,
      sl: 20,
      exit: 18.7,
      tp1: 27,
      tp2: 35,
      pnl: -3.35,
      exitReason: 'INITIAL_SL',
    }));
    expect(text).toContain('Entry: ₹23.35 → SL: ₹20');
    expect(text).toContain('Exit: ₹18.7');
    expect(text).toContain('TP1: ₹27');
    expect(text).toContain('TP2: ₹35');
    // hit timestamp (event time rendered in IST)
    expect(text).toMatch(/29\/9\/2026/);
    expect(text).not.toContain('SL: ₹-');
    expect(text).not.toContain('Exit: ₹-');
  });

  it('SL_HIT without tp values still renders cleanly (no blank TP line)', () => {
    const text = formatEventForTelegram(ev('SL_HIT', {
      direction: 'BUY CALL',
      entry: 100,
      sl: 90,
      exit: 88,
      pnl: -12,
      exitReason: 'INITIAL_SL',
    }));
    expect(text).toContain('SL: ₹90');
    expect(text).toContain('Exit: ₹88');
    expect(text).not.toContain('TP1:');
    expect(text).not.toContain('₹-');
  });

  it('TP1_HIT shows SL value + hit timestamp', () => {
    const text = formatEventForTelegram(ev('TP1_HIT', {
      direction: 'BUY PUT',
      entry: 9.1,
      sl: 10,
      tp1: 10,
      current: 27,
      pnl: 0.9,
    }));
    expect(text).toContain('TP1: ₹10');
    expect(text).toContain('SL: ₹10');
    expect(text).toContain('Current: ₹27');
    expect(text).toMatch(/29\/9\/2026/);
    expect(text).not.toContain('SL: ₹-');
  });

  it('TP2_HIT shows SL + TP1 values', () => {
    const text = formatEventForTelegram(ev('TP2_HIT', {
      direction: 'BUY PUT',
      entry: 9.1,
      sl: 10,
      tp1: 10,
      tp2: 14,
      current: 27,
      pnl: 4.9,
    }));
    expect(text).toContain('TP2: ₹14');
    expect(text).toContain('SL: ₹10');
    expect(text).toContain('TP1: ₹10');
    expect(text).toMatch(/29\/9\/2026/);
  });

  it('TP3_HIT renders a structured alert (not the JSON default fallback)', () => {
    const text = formatEventForTelegram(ev('TP3_HIT', {
      direction: 'BUY CALL',
      entry: 50,
      sl: 45,
      tp1: 55,
      tp2: 65,
      tp3: 80,
      current: 81,
      pnl: 31,
    }));
    expect(text).toContain('TP3 HIT');
    expect(text).toContain('TP3: ₹80');
    expect(text).toContain('SL: ₹45');
    expect(text).not.toContain('{'); // no JSON dump
  });
});

describe('scanner null-safety — analyzeMarketDirection (PCR crash fix)', () => {
  const base = {
    spotPrice: 22600,
    maxPain: 22650,
    totalCallOI: 1000,
    totalPutOI: 1200,
  };

  it('does not throw when pcr and vix are null', () => {
    const d = analyzeMarketDirection({
      ...base,
      pcr: null as any,
      vix: null as any,
    } as any);
    expect(d.details).toContain('PCR unavailable');
    expect(Number.isFinite(d.score)).toBe(true);
    expect(d.vixLevel).toBe('Unknown');
    expect(d.breadth).toContain('no PCR data');
    expect(d.globalCues).toContain('unavailable');
  });

  it('does not throw when only pcr is null', () => {
    const d = analyzeMarketDirection({
      ...base,
      pcr: null as any,
      vix: 10, // < 12 → "Low VIX" detail appended
    } as any);
    expect(d.details).toContain('PCR unavailable');
    // VIX still analysed even without PCR
    expect(d.details).toContain('VIX');
    expect(d.vixLevel).toBe('Low');
  });

  it('still analyses normally with real values', () => {
    const d = analyzeMarketDirection({
      ...base,
      pcr: 1.4,
      vix: 14,
    } as any);
    expect(d.details).toContain('Strong put writing');
    expect(d.trend).toBe('BULLISH');
    expect(d.breadth).toBe('Advancing (60%+ stocks up)');
  });

  it('bearish PCR path works (pcr < 0.7 with valid number)', () => {
    const d = analyzeMarketDirection({
      ...base,
      pcr: 0.5,
      vix: 20,
    } as any);
    expect(d.details).toContain('Strong call writing');
    expect(d.trend).toBe('BEARISH');
  });
});
