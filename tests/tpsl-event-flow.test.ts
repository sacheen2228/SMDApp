// ═══════════════════════════════════════════════════════════════════════════
// TP/SL EVENT FLOW E2E TESTS
//
// Simulates the full chain:
//   Live LTP → Trade Monitor (tiger-monitor.pollTradesOnce)
//   → activeTradeTracker.updateTradeStatus
//   → active-trade-lock update/release
//   → telegram-alerts (delivery flags + retry)
//   → Telegram sender (injected mock)
//
// Covers: TP1, SL, duplicate prevention, Telegram retry, lock release,
// End-of-Day report sections, restart flag persistence.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import {
  addTrade, getTrade, getMonitoredTrades, getActiveTrades,
  updateTradeStatus, markTradeAlertSent, getTradeAlertFlag,
  isTerminalTradeStatus, applyAlertFlags, type ActiveTrade,
} from '../src/lib/activeTradeTracker';
import { isTradeActive, acquireTradeLock, releaseTradeLock, forceRelease } from '../src/lib/active-trade-lock';
import { pollTradesOnce } from '../src/lib/tiger-monitor';
import {
  sendTPSLAlert, retryFailedAlerts, getDeliveryStatus,
  getGlobalDeliveryStats, __setAlertSenderForTests,
} from '../src/lib/agents/telegram-alerts';
import {
  registerTradeForMonitoring, updateAndDetect, getMonitoredTrade,
  isAlertAlreadySent, markAlertSent, getAlertHistory,
} from '../src/lib/agents/trade-monitor';
import {
  categorizeTrades, formatDigestMessage, type DigestTrade,
} from '../src/lib/dailyDigest';
import type { TPSLAlert } from '../src/lib/agents/agent-contract';

// ─── Test helpers ─────────────────────────────────────────────────

let sentMessages: string[] = [];
let senderShouldFail = false;

function installMockSender() {
  sentMessages = [];
  senderShouldFail = false;
  __setAlertSenderForTests(async (text: string) => {
    if (senderShouldFail) return false;
    sentMessages.push(text);
    return true;
  });
}

function restoreSender() {
  __setAlertSenderForTests(null);
}

let seq = 0;
function makeTrade(overrides?: Partial<ActiveTrade>): ActiveTrade {
  seq++;
  const trade: ActiveTrade = {
    id: `e2e-${Date.now()}-${seq}`,
    symbol: 'NIFTY',
    side: 'BUY',
    instrument: 'NIFTY 23400 CE',
    strike: 23400,
    optionType: 'CE',
    entry: 100,
    sl: 90,
    tp1: 110,
    tp2: 120,
    tp3: 130,
    status: 'ACTIVE',
    sentAt: new Date().toISOString(),
    source: 'e2e-test',
    exchange: 'NFO',
    ...overrides,
  };
  return trade;
}

// Unique underlying per test so locks don't collide (DB + flags persist across runs)
function uniqueSymbol(prefix: string): string {
  seq++;
  return `${prefix}${Date.now()}${seq}`;
}

function uniqueId(prefix: string): string {
  seq++;
  return `${prefix}-${Date.now()}-${seq}`;
}

// e2e rows are test fixtures — remove them so the production journal
// (Trade tab stats) stays clean after every test run. createTrade is
// fire-and-forget, so wait for in-flight POSTs to land before deleting.
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

// ─── 1. BUY trade reaches TP1 ─────────────────────────────────────

describe('E2E: BUY trade reaches TP1', () => {
  it('monitor → tracker → Telegram → exactly one alert → status update', async () => {
    installMockSender();
    const symbol = uniqueSymbol('TP1E');
    const trade = makeTrade({ symbol, entry: 100, sl: 90, tp1: 110, tp2: 120, tp3: 130 });
    await addTrade(trade, true);

    expect(getTrade(trade.id)?.status).toBe('ACTIVE');
    expect(isTradeActive(symbol, 'NFO')).not.toBeNull();

    // LTP crosses TP1 (only this trade — others get 0 = skip)
    const result = await pollTradesOnce(async (t) => (t.id === trade.id ? 115 : 0));

    expect(result.detected).toBeGreaterThanOrEqual(1);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain('TARGET 1 HIT');
    expect(sentMessages[0]).toContain(symbol);
    expect(sentMessages[0]).toContain('Trade ID');
    expect(sentMessages[0]).toContain('Entry: ₹100.00');
    expect(sentMessages[0]).toContain('Current LTP: ₹115.00');
    expect(sentMessages[0]).toContain('SL: ₹'); // trailed SL shown
    expect(sentMessages[0]).toContain('TP Level: ₹110.00');
    expect(sentMessages[0]).toContain('Hit time:');
    expect(sentMessages[0]).toContain('P&L:');
    expect(sentMessages[0]).toContain('Final status: TP1_HIT');

    // Status updated, still monitored (TP2/TP3 pending), lock still held
    const after = getTrade(trade.id);
    expect(after?.status).toBe('TP1_HIT');
    expect(after?.tp1HitAt).toBeTruthy();
    expect(after?.sl).toBe(100); // trailed to breakeven
    expect(getMonitoredTrades().some(t => t.id === trade.id)).toBe(true);
    expect(isTradeActive(symbol, 'NFO')).not.toBeNull(); // lock held

    // Delivery flag persisted
    expect(getTradeAlertFlag(trade.id, 'TP1_HIT')).toBe(true);

    restoreSender();
  });
});

// ─── 2. BUY trade reaches SL ──────────────────────────────────────

describe('E2E: BUY trade reaches SL', () => {
  it('monitor → tracker → Telegram → exactly one alert → lock released', async () => {
    installMockSender();
    const symbol = uniqueSymbol('SLE');
    const trade = makeTrade({ symbol, entry: 100, sl: 90, tp1: 110, tp2: 120, tp3: 130 });
    await addTrade(trade, true);

    expect(isTradeActive(symbol, 'NFO')).not.toBeNull();

    // LTP drops through SL
    const result = await pollTradesOnce(async (t) => (t.id === trade.id ? 85 : 0));

    expect(result.detected).toBeGreaterThanOrEqual(1);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain('SL HIT');
    expect(sentMessages[0]).toContain(symbol);
    expect(sentMessages[0]).toContain('Trade ID');
    expect(sentMessages[0]).toContain('Entry: ₹100.00');
    expect(sentMessages[0]).toContain('SL: ₹90.00');
    expect(sentMessages[0]).toContain('Hit time:');
    expect(sentMessages[0]).toContain('P&L:');
    expect(sentMessages[0]).toContain('Final status: SL_HIT');

    // Terminal: removed from memory, lock released, monitoring stopped
    expect(getTrade(trade.id)).toBeUndefined();
    expect(getMonitoredTrades().some(t => t.id === trade.id)).toBe(false);
    expect(isTradeActive(symbol, 'NFO')).toBeNull();
    expect(getTradeAlertFlag(trade.id, 'SL_HIT')).toBe(true);

    restoreSender();
  });
});

// ─── 3. Repeated LTP polling — no duplicate alerts ────────────────

describe('E2E: Repeated polling never duplicates TP/SL alerts', () => {
  it('same TP1 alert sent exactly once across many polls', async () => {
    installMockSender();
    const symbol = uniqueSymbol('DUPE');
    const trade = makeTrade({ symbol, entry: 100, sl: 90, tp1: 110, tp2: 120, tp3: 130 });
    await addTrade(trade, true);

    // 5 consecutive polls all above TP1
    for (let i = 0; i < 5; i++) {
      await pollTradesOnce(async (t) => (t.id === trade.id ? 115 : 0));
    }

    const tp1Sends = sentMessages.filter(m => m.includes('TARGET 1 HIT') && m.includes(symbol));
    expect(tp1Sends.length).toBe(1);

    // Also: agents-monitor path — repeated updateAndDetect
    const monId = uniqueId("dup-mon");
    registerTradeForMonitoring({
      tradeId: monId, symbol: 'NIFTY', exchange: 'NFO',
      instrument: 'CALL', side: 'BUY', strike: 23400,
      entry: 150, stopLoss: 130, tp1: 170, tp2: 190,
    });
    const r1 = updateAndDetect(monId, 175);
    expect(r1.alerts.length).toBe(1);
    const r2 = updateAndDetect(monId, 176);
    const r3 = updateAndDetect(monId, 180);
    expect(r2.alerts.length).toBe(0);
    expect(r3.alerts.length).toBe(0);

    restoreSender();
  });

  it('SL after TP1 (trailed) fires once and stops monitoring', async () => {
    installMockSender();
    const symbol = uniqueSymbol('TRAIL');
    const trade = makeTrade({ symbol, entry: 100, sl: 90, tp1: 110, tp2: 120, tp3: 130 });
    await addTrade(trade, true);

    // Hit TP1
    await pollTradesOnce(async (t) => (t.id === trade.id ? 115 : 0));
    expect(sentMessages.filter(m => m.includes('TARGET 1 HIT')).length).toBe(1);

    // Price falls back to breakeven SL (trailed to entry=100)
    await pollTradesOnce(async (t) => (t.id === trade.id ? 99 : 0));
    await pollTradesOnce(async (t) => (t.id === trade.id ? 98 : 0));
    await pollTradesOnce(async (t) => (t.id === trade.id ? 97 : 0));

    const slSends = sentMessages.filter(m => m.includes('SL HIT') && m.includes(symbol));
    expect(slSends.length).toBe(1);
    // Monitoring stopped
    expect(getTrade(trade.id)).toBeUndefined();
    expect(isTradeActive(symbol, 'NFO')).toBeNull();

    restoreSender();
  });
});

// ─── 4. Telegram failure → retry without duplicate ────────────────

describe('E2E: Telegram failure and retry', () => {
  it('failed send is retryable; success then dedup prevents second delivery', async () => {
    installMockSender();
    const monitorId = uniqueId("retry-mon");
    registerTradeForMonitoring({
      tradeId: monitorId, symbol: 'NIFTY', exchange: 'NFO',
      instrument: 'CALL', side: 'BUY', strike: 23400,
      entry: 150, stopLoss: 130, tp1: 170, tp2: 190,
    });

    const { alerts } = updateAndDetect(monitorId, 175);
    expect(alerts.length).toBe(1);
    const alert = alerts[0];

    // First send FAILS
    senderShouldFail = true;
    const fail = await sendTPSLAlert(alert);
    expect(fail).toBe(false);
    expect(sentMessages.length).toBe(0);

    // Flag must NOT be set after failure
    expect(isAlertAlreadySent(monitorId, 'TP1_HIT')).toBe(false);
    expect(getTradeAlertFlag(monitorId, 'TP1_HIT')).toBe(false);

    // Retry with sender recovered
    senderShouldFail = false;
    const retried = await retryFailedAlerts();
    expect(retried.sent).toBeGreaterThanOrEqual(1);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain('TP HIT');

    // Flag now set
    expect(isAlertAlreadySent(monitorId, 'TP1_HIT')).toBe(true);

    // Further retry / re-send → dedup, no second delivery
    const again = await sendTPSLAlert(alert);
    expect(again).toBe(true); // treated as already delivered
    const retried2 = await retryFailedAlerts();
    expect(retried2.sent).toBe(0);
    expect(sentMessages.length).toBe(1); // still exactly one

    restoreSender();
  });
});

// ─── 5. Active lock release ───────────────────────────────────────

describe('E2E: Active lock lifecycle', () => {
  it('lock held while open/TP1, released on terminal SL', async () => {
    installMockSender();
    const symbol = uniqueSymbol('LOCK');
    const trade = makeTrade({ symbol, tp3: 130 });
    await addTrade(trade, true);

    expect(isTradeActive(symbol, 'NFO')).not.toBeNull();

    // TP1 — lock must remain (trade still riding)
    await pollTradesOnce(async (t) => (t.id === trade.id ? 115 : 0));
    expect(isTradeActive(symbol, 'NFO')).not.toBeNull();

    // SL after trail — lock released
    await pollTradesOnce(async (t) => (t.id === trade.id ? 95 : 0));
    expect(isTradeActive(symbol, 'NFO')).toBeNull();

    restoreSender();
  });

  it('SELL equity TP1 is terminal — lock released immediately', async () => {
    installMockSender();
    const symbol = uniqueSymbol('SELLT');
    // SELL: SL above entry, TP below; no tp3 → TP1 terminal
    const trade = makeTrade({
      symbol, side: 'SELL', optionType: 'EQ', instrument: symbol,
      strike: 0, entry: 2500, sl: 2575, tp1: 2425, tp2: 2425, tp3: undefined,
      exchange: 'NSE',
    });
    await addTrade(trade, true);
    expect(isTradeActive(symbol, 'NSE')).not.toBeNull();

    await pollTradesOnce(async (t) => (t.id === trade.id ? 2400 : 0));

    expect(sentMessages.some(m => m.includes('TARGET 1 HIT') && m.includes(symbol))).toBe(true);
    expect(getTrade(trade.id)).toBeUndefined();
    expect(isTradeActive(symbol, 'NSE')).toBeNull();

    restoreSender();
  });

  it('isTerminalTradeStatus classifies correctly', () => {
    const buy = makeTrade({ tp3: 130, tp2: 120 });
    expect(isTerminalTradeStatus(buy, 'SL_HIT')).toBe(true);
    expect(isTerminalTradeStatus(buy, 'TP3_HIT')).toBe(true);
    expect(isTerminalTradeStatus(buy, 'TP1_HIT')).toBe(false); // TP2/TP3 pending
    expect(isTerminalTradeStatus(buy, 'TP2_HIT')).toBe(false); // TP3 pending

    const buyNoTp3 = makeTrade({ tp3: undefined, tp2: 120 });
    expect(isTerminalTradeStatus(buyNoTp3, 'TP2_HIT')).toBe(true); // final TP

    const sell = makeTrade({ side: 'SELL', tp3: undefined, tp2: 2425 });
    expect(isTerminalTradeStatus(sell, 'TP1_HIT')).toBe(true); // single target
  });
});

// ─── 6. End-of-Day report sections ────────────────────────────────

describe('E2E: End-of-Day report', () => {
  const trades: DigestTrade[] = [
    { tradeId: 't1', symbol: 'NIFTY', strike: 23400, type: 'CE', side: 'BUY', status: 'ACTIVE', entryPrice: 90 },
    { tradeId: 't2', symbol: 'BANKNIFTY', strike: 56500, type: 'PE', side: 'BUY', status: 'TP1_HIT', entryPrice: 150, tpHitLevel: 'TP1', pnl: 20 },
    { tradeId: 't3', symbol: 'RELIANCE', side: 'SELL', status: 'TP2_HIT', entryPrice: 2500, tpHitLevel: 'TP2', pnl: 40 },
    { tradeId: 't4', symbol: 'SENSEX', strike: 80000, type: 'CE', side: 'BUY', status: 'TP3_HIT', entryPrice: 100, tpHitLevel: 'TP3', pnl: 60 },
    { tradeId: 't5', symbol: 'HDFCBANK', strike: 1700, type: 'CE', side: 'BUY', status: 'SL_HIT', entryPrice: 50, pnl: -10 },
    { tradeId: 't6', symbol: 'TCS', side: 'BUY', status: 'CLOSED', entryPrice: 4000 },
    { tradeId: 't7', symbol: 'INFY', side: 'BUY', status: 'CANCELLED', entryPrice: 1800 },
  ];

  const signals = new Map([
    ['NIFTY|23400|CE|BUY', { sentAt: new Date().toISOString(), confidence: 75, source: 'sdm' }],
    ['SENSEX|80000|CE|BUY', { sentAt: new Date().toISOString(), confidence: 80, source: 'sdm' }],
  ]);

  it('puts trades in the correct sections — TP/SL never counted Active', () => {
    const sections = categorizeTrades(trades, signals, ['  e2e-x TP1_HIT — send failed (retry 1/3)']);

    // Active OPEN only
    expect(sections.activeOpen.length).toBe(1);
    expect(sections.activeOpen[0]).toContain('NIFTY');
    expect(sections.activeOpen[0]).not.toContain('TP1_HIT');

    // TP hits: TP1 + TP2 + TP3
    expect(sections.tpHits.length).toBe(3);
    expect(sections.tpHits.join('\n')).toContain('BANKNIFTY');
    expect(sections.tpHits.join('\n')).toContain('RELIANCE');
    expect(sections.tpHits.join('\n')).toContain('SENSEX');

    // SL hits
    expect(sections.slHits.length).toBe(1);
    expect(sections.slHits[0]).toContain('HDFCBANK');

    // Closed/cancelled
    expect(sections.closed.length).toBe(2);
    expect(sections.closed.join('\n')).toContain('TCS');
    expect(sections.closed.join('\n')).toContain('INFY');

    // Signals
    expect(sections.newSignals.length).toBe(2);

    // Delivery failures
    expect(sections.deliveryFailures.length).toBe(1);
    expect(sections.deliveryFailures[0]).toContain('send failed');
  });

  it('formats message with all 6 sections and correct counts', () => {
    const sections = categorizeTrades(trades, signals, []);
    const msg = formatDigestMessage(
      sections,
      {
        vix: { value: '11.26', source: 'nse-api', freshness: 'LIVE' },
        fii: { fii: '-576.2 Cr', dii: '+2797.3 Cr', date: '2026-09-19', source: 'NSE' },
      },
      '22/9/2026, 3:25:00 pm'
    );

    expect(msg).toContain('1. New Signals Today: 2');
    expect(msg).toContain('2. Active OPEN Trades: 1');
    expect(msg).toContain('NIFTY 23400CE BUY'); // the one open trade
    expect(msg).toContain('3. TP1/TP2/TP3 Hit Today: 3');
    expect(msg).toContain('4. SL Hit Today: 1');
    expect(msg).toContain('5. Closed/Cancelled/Error: 2');
    expect(msg).toContain('6. Telegram Delivery Failures: 0');
    // VIX with source + freshness — never bare N/A
    expect(msg).toContain('VIX: 11.26 (nse-api, LIVE)');
    expect(msg).toContain('FII: -576.2 Cr');
  });

  it('shows Active Trades: 0 when none open, DATA_UNAVAILABLE for missing VIX', () => {
    const sections = categorizeTrades(
      [
        { tradeId: 'x1', symbol: 'A', status: 'SL_HIT', entryPrice: 10 },
        { tradeId: 'x2', symbol: 'B', status: 'TP1_HIT', entryPrice: 10 },
      ],
      new Map(),
      []
    );
    expect(sections.activeOpen.length).toBe(0);

    const msg = formatDigestMessage(
      sections,
      {
        vix: { value: 'DATA_UNAVAILABLE', source: 'none', freshness: 'UNAVAILABLE' },
        fii: { fii: 'DATA_UNAVAILABLE', dii: 'DATA_UNAVAILABLE' },
      },
      'now'
    );
    expect(msg).toContain('Active OPEN Trades: 0');
    expect(msg).toContain('Active Trades: 0');
    expect(msg).toContain('VIX: DATA_UNAVAILABLE');
    expect(msg).not.toContain('VIX: N/A');
    // TP/SL trades must NOT appear in Active section
    const activeSection = msg.split('2. Active OPEN Trades')[1]?.split('3. TP1')[0] || '';
    expect(activeSection).not.toContain('[SL_HIT]');
    expect(activeSection).not.toContain('[TP1_HIT]');
  });
});

// ─── 7. Restart persistence ───────────────────────────────────────

describe('E2E: Restart persistence of event flags', () => {
  it('alert flags survive an in-memory reset via applyAlertFlags', async () => {
    installMockSender();
    const symbol = uniqueSymbol('RST');
    const trade = makeTrade({ symbol, tp3: 130 });
    await addTrade(trade, true);

    // Hit TP1 → flag persisted to disk
    await pollTradesOnce(async (t) => (t.id === trade.id ? 115 : 0));
    expect(getTradeAlertFlag(trade.id, 'TP1_HIT')).toBe(true);

    // Simulate restart: wipe in-memory trade, re-add fresh (as reload would)
    const savedId = trade.id;
    const fresh = makeTrade({ ...trade, status: 'TP1_HIT', sl: 100 });
    // applyAlertFlags is called inside addTrade
    forceRelease(symbol, 'NFO');
    await addTrade(fresh, true);

    // Flags restored onto the "reloaded" trade
    expect(getTrade(savedId)?.tp1AlertSent ?? fresh.tp1AlertSent).toBe(true);
    expect(getTradeAlertFlag(savedId, 'TP1_HIT')).toBe(true);

    // Direct applyAlertFlags on a bare object (reload path)
    const bare = makeTrade({ id: savedId, symbol: 'OTHER' });
    expect(bare.tp1AlertSent).toBeFalsy();
    applyAlertFlags(bare);
    expect(bare.tp1AlertSent).toBe(true);

    // Re-sending after "restart" is deduped
    sentMessages = [];
    const state = getMonitoredTrade(savedId);
    // build a manual alert and try to send
    const hist = getAlertHistory(savedId);
    if (hist.length > 0) {
      const ok = await sendTPSLAlert(hist[0]);
      expect(ok).toBe(true); // already delivered
      expect(sentMessages.length).toBe(0);
    }

    restoreSender();
  });

  it('markTradeAlertSent persists flag for terminal trades too', () => {
    const id = uniqueId("persist");
    markTradeAlertSent(id, 'SL_HIT');
    expect(getTradeAlertFlag(id, 'SL_HIT')).toBe(true);
    markTradeAlertSent(id, 'TP2_HIT');
    expect(getTradeAlertFlag(id, 'TP2_HIT')).toBe(true);
    expect(getTradeAlertFlag(id, 'TP1_HIT')).toBe(false);
  });
});

// ─── 8. Full chain: agents monitor + telegram-alerts integration ──

describe('E2E: agents monitor → sendTPSLAlert full chain', () => {
  it('TP1 detection creates alert, send delivers once with all fields', async () => {
    installMockSender();
    const monId = uniqueId("chain");
    registerTradeForMonitoring({
      tradeId: monId, symbol: 'NIFTY', exchange: 'NFO',
      instrument: 'CALL', side: 'BUY', strike: 23400,
      entry: 150, stopLoss: 130, tp1: 170, tp2: 190,
    });

    const { alerts } = updateAndDetect(monId, 175);
    expect(alerts.length).toBe(1);
    expect(alerts[0].alertType).toBe('TP1_HIT');
    expect(alerts[0].message).toContain('Trade ID');
    expect(alerts[0].message).toContain('NIFTY');
    expect(alerts[0].message).toContain('23400');
    expect(alerts[0].message).toContain('BUY');
    expect(alerts[0].message).toContain('Entry: ₹150');
    expect(alerts[0].message).toContain('Current: ₹175');
    expect(alerts[0].message).toContain('Hit time');

    const ok = await sendTPSLAlert(alerts[0]);
    expect(ok).toBe(true);
    expect(sentMessages.length).toBe(1);

    const delivery = getDeliveryStatus(monId);
    expect(delivery.totalSent).toBe(1);
    expect(delivery.totalFailed).toBe(0);

    restoreSender();
  });

  it('SELL equity SL detection and delivery', async () => {
    installMockSender();
    const monId = uniqueId("sell");
    registerTradeForMonitoring({
      tradeId: monId, symbol: 'RELIANCE', exchange: 'NSE',
      instrument: 'EQUITY', side: 'SELL',
      entry: 2500, stopLoss: 2575, tp1: 2425, tp2: 2350,
    });

    const { alerts } = updateAndDetect(monId, 2600);
    expect(alerts.length).toBe(1);
    expect(alerts[0].alertType).toBe('SL_HIT');

    const ok = await sendTPSLAlert(alerts[0]);
    expect(ok).toBe(true);
    expect(sentMessages[0]).toContain('SL HIT');
    expect(sentMessages[0]).toContain('SELL');
    expect(sentMessages[0]).toContain('RELIANCE');

    restoreSender();
  });

  it('getGlobalDeliveryStats reports pending failures for EOD', async () => {
    installMockSender();
    const monId = uniqueId("stats");
    registerTradeForMonitoring({
      tradeId: monId, symbol: 'NIFTY', exchange: 'NFO',
      instrument: 'CALL', side: 'BUY', strike: 23400,
      entry: 150, stopLoss: 130, tp1: 170, tp2: 190,
    });
    const { alerts } = updateAndDetect(monId, 175);

    senderShouldFail = true;
    await sendTPSLAlert(alerts[0]);

    const stats = getGlobalDeliveryStats();
    expect(stats.totalPending + stats.totalFailed).toBeGreaterThanOrEqual(1);
    expect(stats.failures.some(f => f.tradeId === monId)).toBe(true);

    restoreSender();
  });
});
