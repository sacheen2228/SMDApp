// ═══════════════════════════════════════════════════════════════════════════
// P0/P1 Regression Tests — Trade Validator, Active Lock, Max Pain, PCR, etc.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  validateCandidateTrade,
  isTradeSafe,
  isDataStale,
  safePCR,
  computeMaxPainCorrect,
  type TradeCandidate,
} from '@/lib/trade-validator-gate';
import {
  acquireTradeLock,
  isTradeActive,
  releaseTradeLock,
  updateTradeStatus,
  getActiveLocks,
  forceRelease,
  type ActiveTradeLock,
} from '@/lib/active-trade-lock';

// ─── Test Fixtures ───────────────────────────────────────────────

function makeCandidate(overrides: Partial<TradeCandidate> = {}): TradeCandidate {
  return {
    symbol: 'NIFTY',
    exchange: 'NFO',
    instrument: 'CALL',
    optionType: 'CE',
    strike: 23000,
    expiry: '18-09-2026',
    entry: 150,
    stopLoss: 130,
    target1: 180,
    direction: 'BUY_CE',
    strategy: 'TEST',
    score: 75,
    premium: 150,
    spot: 23000,
    volume: 50000,
    oi: 200000,
    bid: 148,
    ask: 152,
    dataTimestamp: new Date().toISOString(),
    dataSource: 'MOAPI',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. TRADE VALIDATOR — Option Safety
// ═══════════════════════════════════════════════════════════════════

describe('Trade Validator — Option Safety', () => {
  it('LTP ₹0.05 + volume 0 → BLOCKED', () => {
    const c = makeCandidate({ premium: 0.05, entry: 0.05, volume: 0, oi: 0 });
    const r = validateCandidateTrade(c);
    expect(r.valid).toBe(false);
    expect(r.reasons.some(x => x.includes('PREMIUM'))).toBe(true);
  });

  it('LTP ₹0.05 + OI 0 → BLOCKED', () => {
    const c = makeCandidate({ premium: 0.05, entry: 0.05, oi: 0 });
    const r = validateCandidateTrade(c);
    expect(r.valid).toBe(false);
    expect(r.reasons.some(x => x.includes('PREMIUM'))).toBe(true);
  });

  it('premium ₹0 → BLOCKED', () => {
    const c = makeCandidate({ premium: 0, entry: 0 });
    const r = validateCandidateTrade(c);
    expect(r.valid).toBe(false);
    expect(r.reasons.some(x => x.includes('PREMIUM'))).toBe(true);
  });

  it('premium ₹4.99 → BLOCKED', () => {
    const c = makeCandidate({ premium: 4.99, entry: 4.99 });
    const r = validateCandidateTrade(c);
    expect(r.valid).toBe(false);
    expect(r.reasons.some(x => x.includes('PREMIUM'))).toBe(true);
  });

  it('premium ₹5 → VALID', () => {
    const c = makeCandidate({ premium: 5, entry: 5, stopLoss: 3, target1: 8 });
    const r = validateCandidateTrade(c);
    expect(r.valid).toBe(true);
  });

  it('stale closing LTP → BLOCKED', () => {
    const c = makeCandidate({
      premium: 100,
      entry: 100,
      dataTimestamp: new Date(Date.now() - 10000).toISOString(),
    });
    const r = validateCandidateTrade(c);
    expect(r.valid).toBe(false);
    expect(r.reasons.some(x => x.includes('FRESHNESS'))).toBe(true);
  });

  it('missing bid/ask → no fabricated values', () => {
    const c = makeCandidate({ bid: null, ask: null });
    const r = validateCandidateTrade(c);
    expect(r.valid).toBe(true);
  });

  it('bid/ask spread too wide → BLOCKED', () => {
    const c = makeCandidate({ bid: 100, ask: 120 }); // 17% spread
    const r = validateCandidateTrade(c);
    expect(r.valid).toBe(false);
    expect(r.reasons.some(x => x.includes('SPREAD'))).toBe(true);
  });

  it('ask < bid → BLOCKED', () => {
    const c = makeCandidate({ bid: 150, ask: 140 });
    const r = validateCandidateTrade(c);
    expect(r.valid).toBe(false);
    expect(r.reasons.some(x => x.includes('SPREAD'))).toBe(true);
  });

  it('OI and volume both zero → BLOCKED', () => {
    const c = makeCandidate({ volume: 0, oi: 0 });
    const r = validateCandidateTrade(c);
    expect(r.valid).toBe(false);
    expect(r.reasons.some(x => x.includes('VOLUME') || x.includes('OI'))).toBe(true);
  });

  it('invalid SL (SL >= entry for BUY) → BLOCKED', () => {
    const c = makeCandidate({ stopLoss: 150, entry: 150 });
    const r = validateCandidateTrade(c);
    expect(r.valid).toBe(false);
    expect(r.reasons.some(x => x.includes('SL'))).toBe(true);
  });

  it('TP <= entry for BUY → BLOCKED', () => {
    const c = makeCandidate({ target1: 140 });
    const r = validateCandidateTrade(c);
    expect(r.valid).toBe(false);
    expect(r.reasons.some(x => x.includes('TARGET'))).toBe(true);
  });

  it('valid trade → PASSED', () => {
    const c = makeCandidate();
    const r = validateCandidateTrade(c);
    expect(r.valid).toBe(true);
    expect(r.action).toBe('BUY_CE');
  });

  it('BUY_PE direction → action is BUY_PE', () => {
    const c = makeCandidate({
      instrument: 'PUT',
      direction: 'BUY_PE',
    });
    const r = validateCandidateTrade(c);
    expect(r.valid).toBe(true);
    expect(r.action).toBe('BUY_PE');
  });

  it('isTradeSafe returns boolean', () => {
    expect(isTradeSafe(makeCandidate())).toBe(true);
    expect(isTradeSafe(makeCandidate({ premium: 0 }))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. MAX PAIN — Correct Formula
// ═══════════════════════════════════════════════════════════════════

describe('Max Pain — Correct Formula', () => {
  it('known dataset → correct Max Pain', () => {
    // Classic example: Max Pain at 100
    const strikes = [
      { strike: 90, ceOI: 0, peOI: 50000 },
      { strike: 95, ceOI: 0, peOI: 30000 },
      { strike: 100, ceOI: 40000, peOI: 40000 },
      { strike: 105, ceOI: 30000, peOI: 0 },
      { strike: 110, ceOI: 50000, peOI: 0 },
    ];
    const mp = computeMaxPainCorrect(strikes);
    expect(mp).toBe(100);
  });

  it('missing OI → null', () => {
    const strikes = [
      { strike: 100, ceOI: 0, peOI: 0 },
      { strike: 105, ceOI: 0, peOI: 0 },
    ];
    const mp = computeMaxPainCorrect(strikes);
    expect(mp).toBeNull();
  });

  it('empty strikes → null', () => {
    expect(computeMaxPainCorrect([])).toBeNull();
  });

  it('only calls → still computes', () => {
    const strikes = [
      { strike: 100, ceOI: 10000, peOI: 0 },
      { strike: 105, ceOI: 20000, peOI: 0 },
      { strike: 110, ceOI: 30000, peOI: 0 },
    ];
    const mp = computeMaxPainCorrect(strikes);
    expect(mp).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. PCR — Null Safety
// ═══════════════════════════════════════════════════════════════════

describe('PCR — Null Safety', () => {
  it('valid OI → correct PCR', () => {
    expect(safePCR(100000, 150000)).toBe(1.5);
  });

  it('call OI = 0 → null', () => {
    expect(safePCR(0, 100000)).toBeNull();
  });

  it('put OI = 0 → null', () => {
    expect(safePCR(100000, 0)).toBeNull();
  });

  it('both zero → null', () => {
    expect(safePCR(0, 0)).toBeNull();
  });

  it('negative OI → null', () => {
    expect(safePCR(-100, 100)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. FRESHNESS
// ═══════════════════════════════════════════════════════════════════

describe('Freshness Gate', () => {
  it('fresh data → not stale', () => {
    expect(isDataStale(new Date().toISOString(), 5000)).toBe(false);
  });

  it('old data → stale', () => {
    expect(isDataStale(new Date(Date.now() - 10000).toISOString(), 5000)).toBe(true);
  });

  it('no timestamp → not stale (unknown)', () => {
    expect(isDataStale(undefined)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. ACTIVE TRADE LOCK
// ═══════════════════════════════════════════════════════════════════

describe('Active Trade Lock', () => {
  beforeEach(() => {
    // Clean up all locks
    forceRelease('NIFTY', 'NFO');
    forceRelease('BANKNIFTY', 'NFO');
    forceRelease('SENSEX', 'BSE');
  });

  it('no active trade → signal allowed', async () => {
    const result = await acquireTradeLock({
      tradeId: 'T1', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23000, expiry: '18-09-2026', entry: 150,
      stopLoss: 130, target1: 180,
    });
    expect('tradeId' in result).toBe(true);
    expect((result as any).tradeId).toBe('T1');
  });

  it('active NIFTY trade → new NIFTY signal blocked', async () => {
    await acquireTradeLock({
      tradeId: 'T1', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23000, expiry: '18-09-2026', entry: 150,
      stopLoss: 130, target1: 180,
    });
    const result = await acquireTradeLock({
      tradeId: 'T2', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23100, expiry: '18-09-2026', entry: 160,
      stopLoss: 140, target1: 190,
    });
    expect('blocked' in result).toBe(true);
    expect((result as any).blocked).toBe(true);
  });

  it('active NIFTY CE → NIFTY PE blocked', async () => {
    await acquireTradeLock({
      tradeId: 'T1', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23000, expiry: '18-09-2026', entry: 150,
      stopLoss: 130, target1: 180,
    });
    const result = await acquireTradeLock({
      tradeId: 'T2', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'PE', strike: 23000, expiry: '18-09-2026', entry: 100,
      stopLoss: 80, target1: 130,
    });
    expect('blocked' in result).toBe(true);
  });

  it('active NIFTY → another NIFTY strike blocked', async () => {
    await acquireTradeLock({
      tradeId: 'T1', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23000, expiry: '18-09-2026', entry: 150,
      stopLoss: 130, target1: 180,
    });
    const result = await acquireTradeLock({
      tradeId: 'T3', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23500, expiry: '18-09-2026', entry: 80,
      stopLoss: 60, target1: 110,
    });
    expect('blocked' in result).toBe(true);
  });

  it('active NIFTY → BANKNIFTY allowed', async () => {
    await acquireTradeLock({
      tradeId: 'T1', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23000, expiry: '18-09-2026', entry: 150,
      stopLoss: 130, target1: 180,
    });
    const result = await acquireTradeLock({
      tradeId: 'T4', strategy: 'TEST', underlying: 'BANKNIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 51000, expiry: '18-09-2026', entry: 200,
      stopLoss: 170, target1: 250,
    });
    expect('tradeId' in result).toBe(true);
  });

  it('TP1 event with position still active → lock remains', async () => {
    await acquireTradeLock({
      tradeId: 'T1', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23000, expiry: '18-09-2026', entry: 150,
      stopLoss: 130, target1: 180,
    });
    updateTradeStatus('T1', 'NIFTY', 'NFO', 'TP1_HIT');
    const lock = isTradeActive('NIFTY', 'NFO');
    expect(lock).not.toBeNull();
    expect(lock!.status).toBe('TP1_HIT');
  });

  it('TP2 final exit → lock released', async () => {
    await acquireTradeLock({
      tradeId: 'T1', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23000, expiry: '18-09-2026', entry: 150,
      stopLoss: 130, target1: 180,
    });
    updateTradeStatus('T1', 'NIFTY', 'NFO', 'TP2_HIT');
    const lock = isTradeActive('NIFTY', 'NFO');
    expect(lock).toBeNull();
  });

  it('SL hit → lock released', async () => {
    await acquireTradeLock({
      tradeId: 'T1', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23000, expiry: '18-09-2026', entry: 150,
      stopLoss: 130, target1: 180,
    });
    updateTradeStatus('T1', 'NIFTY', 'NFO', 'SL_HIT');
    const lock = isTradeActive('NIFTY', 'NFO');
    expect(lock).toBeNull();
  });

  it('EXIT → lock released', async () => {
    await acquireTradeLock({
      tradeId: 'T1', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23000, expiry: '18-09-2026', entry: 150,
      stopLoss: 130, target1: 180,
    });
    updateTradeStatus('T1', 'NIFTY', 'NFO', 'EXIT');
    const lock = isTradeActive('NIFTY', 'NFO');
    expect(lock).toBeNull();
  });

  it('CANCELLED → lock released', async () => {
    await acquireTradeLock({
      tradeId: 'T1', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23000, expiry: '18-09-2026', entry: 150,
      stopLoss: 130, target1: 180,
    });
    updateTradeStatus('T1', 'NIFTY', 'NFO', 'CANCELLED');
    const lock = isTradeActive('NIFTY', 'NFO');
    expect(lock).toBeNull();
  });

  it('EXPIRED → lock released', async () => {
    await acquireTradeLock({
      tradeId: 'T1', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23000, expiry: '18-09-2026', entry: 150,
      stopLoss: 130, target1: 180,
    });
    updateTradeStatus('T1', 'NIFTY', 'NFO', 'EXPIRED');
    const lock = isTradeActive('NIFTY', 'NFO');
    expect(lock).toBeNull();
  });

  it('closed trade → fresh signal evaluation', async () => {
    await acquireTradeLock({
      tradeId: 'T1', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23000, expiry: '18-09-2026', entry: 150,
      stopLoss: 130, target1: 180,
    });
    updateTradeStatus('T1', 'NIFTY', 'NFO', 'SL_HIT');
    const result = await acquireTradeLock({
      tradeId: 'T2', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23100, expiry: '18-09-2026', entry: 160,
      stopLoss: 140, target1: 190,
    });
    expect('tradeId' in result).toBe(true);
  });

  it('force release works', async () => {
    await acquireTradeLock({
      tradeId: 'T1', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23000, expiry: '18-09-2026', entry: 150,
      stopLoss: 130, target1: 180,
    });
    expect(isTradeActive('NIFTY', 'NFO')).not.toBeNull();
    forceRelease('NIFTY', 'NFO');
    expect(isTradeActive('NIFTY', 'NFO')).toBeNull();
  });

  it('getActiveLocks returns status', async () => {
    await acquireTradeLock({
      tradeId: 'T1', strategy: 'TEST', underlying: 'NIFTY', exchange: 'NFO',
      optionType: 'CE', strike: 23000, expiry: '18-09-2026', entry: 150,
      stopLoss: 130, target1: 180,
    });
    const locks = getActiveLocks();
    const nifty = locks.find(l => l.underlying === 'NIFTY');
    expect(nifty).toBeDefined();
    expect(nifty!.status).toBe('ACTIVE');
    expect(nifty!.tradeId).toBe('T1');
    const bank = locks.find(l => l.underlying === 'BANKNIFTY');
    expect(bank).toBeDefined();
    expect(bank!.status).toBe('FREE');
  });
});
