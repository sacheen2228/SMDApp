// ═══════════════════════════════════════════════════════════════════════════
// OPTION SYMBOL GUARD TESTS
//
// Regression: e2e tests used to fire real NSE/Breeze requests — every
// addTrade() collected a training market snapshot with the trade's symbol,
// and the option-chain route walked ALL Breeze expiries for synthetic IDs
// (TP1E17906240439251 etc), hammering providers 60+ times per test run.
//
// Layer 1: isPlausibleOptionSymbol — route rejects synthetic symbols fast
//          (400, no provider contact).
// Layer 2: addTrade skips the training snapshot for test/synthetic trades.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, afterAll } from 'bun:test';
import { isPlausibleOptionSymbol } from '../src/lib/stockUniverse';

// Test rows must not pollute the production trade journal (fire-and-forget
// createTrade may land after tests end — settle first, then sweep twice)
afterAll(async () => {
  try {
    const { db } = await import('../src/lib/db');
    await new Promise(r => setTimeout(r, 600));
    await db.trade.deleteMany({ where: { tradeId: { startsWith: 'e2e-' } } });
    await db.trade.deleteMany({ where: { tradeId: { startsWith: 'guard-' } } });
    await new Promise(r => setTimeout(r, 400));
    await db.trade.deleteMany({ where: { tradeId: { startsWith: 'e2e-' } } });
    await db.trade.deleteMany({ where: { tradeId: { startsWith: 'guard-' } } });
  } catch { /* db unavailable in some runs */ }
});

describe('isPlausibleOptionSymbol', () => {
  it('accepts real indices', () => {
    expect(isPlausibleOptionSymbol('NIFTY')).toBe(true);
    expect(isPlausibleOptionSymbol('BANKNIFTY')).toBe(true);
    expect(isPlausibleOptionSymbol('FINNIFTY')).toBe(true);
    expect(isPlausibleOptionSymbol('MIDCPNIFTY')).toBe(true);
    expect(isPlausibleOptionSymbol('SENSEX')).toBe(true);
  });

  it('accepts real NSE F&O stock symbols (incl. & and - and leading digit)', () => {
    expect(isPlausibleOptionSymbol('RELIANCE')).toBe(true);
    expect(isPlausibleOptionSymbol('M&M')).toBe(true);
    expect(isPlausibleOptionSymbol('BAJAJ-AUTO')).toBe(true);
    expect(isPlausibleOptionSymbol('3MINDIA')).toBe(true);
    expect(isPlausibleOptionSymbol('L&TFH')).toBe(true);
  });

  it('rejects synthetic trade IDs with epoch-digit runs', () => {
    expect(isPlausibleOptionSymbol('TP1E17906240439251')).toBe(false);
    expect(isPlausibleOptionSymbol('SLE17906240441623')).toBe(false);
    expect(isPlausibleOptionSymbol('DUPE17906240444465')).toBe(false);
    expect(isPlausibleOptionSymbol('TRAIL17906240447068')).toBe(false);
    expect(isPlausibleOptionSymbol('LOCK179062404525911')).toBe(false);
    expect(isPlausibleOptionSymbol('SELLT179062404575713')).toBe(false);
    expect(isPlausibleOptionSymbol('RST179062404644518')).toBe(false);
  });

  it('rejects empty / oversized / malformed symbols', () => {
    expect(isPlausibleOptionSymbol('')).toBe(false);
    expect(isPlausibleOptionSymbol('   ')).toBe(false);
    expect(isPlausibleOptionSymbol('A'.repeat(40))).toBe(false);
    expect(isPlausibleOptionSymbol('NIFTY DROP TABLE')).toBe(false);
  });
});

describe('addTrade training-snapshot guard', () => {
  // Spy on fetch: count option-chain requests issued by addTrade
  function withFetchSpy() {
    const chainUrls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = ((...args: any[]) => {
      try {
        const url = String(args[0]);
        if (url.includes('/api/option-chain')) chainUrls.push(url);
      } catch {}
      return (orig as any)(...args);
    }) as any;
    return { chainUrls, restore: () => { globalThis.fetch = orig; } };
  }

  it('does NOT fetch option-chain for e2e-test source trades', async () => {
    const { addTrade } = await import('../src/lib/activeTradeTracker');
    const spy = withFetchSpy();
    try {
      await addTrade({
        id: `guard-test-${Date.now()}-a`,
        symbol: 'TP1E1790000000001',
        side: 'BUY',
        instrument: 'FAKE',
        strike: 23400,
        optionType: 'CE',
        entry: 100, sl: 90, tp1: 110, tp2: 120, tp3: 130,
        status: 'ACTIVE',
        sentAt: new Date().toISOString(),
        source: 'e2e-test',
        exchange: 'NFO',
      } as any, true);
      // allow fire-and-forget snapshot to (not) run
      await new Promise(r => setTimeout(r, 300));
      expect(spy.chainUrls.length).toBe(0);
    } finally {
      spy.restore();
    }
  });

  it('does NOT fetch option-chain for synthetic trade IDs', async () => {
    const { addTrade } = await import('../src/lib/activeTradeTracker');
    const spy = withFetchSpy();
    try {
      await addTrade({
        id: `e2e-${Date.now()}-b`,
        symbol: 'RELIANCE',
        side: 'BUY',
        instrument: 'RELIANCE EQ',
        strike: 0,
        optionType: '',
        entry: 100, sl: 90, tp1: 110, tp2: 120, tp3: 130,
        status: 'ACTIVE',
        sentAt: new Date().toISOString(),
        source: 'some-real-source',
        exchange: 'NSE',
      } as any, true);
      await new Promise(r => setTimeout(r, 300));
      expect(spy.chainUrls.length).toBe(0);
    } finally {
      spy.restore();
    }
  });

  it('STILL fetches option-chain for real trades (training stays useful)', async () => {
    const { addTrade } = await import('../src/lib/activeTradeTracker');
    const { forceRelease } = await import('../src/lib/active-trade-lock');
    // Full-suite runs may leave an ACTIVE NIFTY lock from other files —
    // addTrade returns early on lock, before the snapshot.
    forceRelease('NIFTY', 'NFO');
    const spy = withFetchSpy();
    try {
      await addTrade({
        id: `guard-real-${Date.now()}`,
        symbol: 'NIFTY',
        side: 'BUY',
        instrument: 'NIFTY 25000 CE',
        strike: 25000,
        optionType: 'CE',
        entry: 100, sl: 90, tp1: 110, tp2: 120, tp3: 130,
        status: 'ACTIVE',
        sentAt: new Date().toISOString(),
        source: 'sdm',
        exchange: 'NFO',
      } as any, true);
      await new Promise(r => setTimeout(r, 300));
      expect(spy.chainUrls.length).toBeGreaterThan(0);
      expect(spy.chainUrls[0]).toContain('symbol=NIFTY');
    } finally {
      spy.restore();
    }
  });
});
