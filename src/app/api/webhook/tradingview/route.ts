// ═══════════════════════════════════════════════════════════════════════════
// POST /api/webhook/tradingview — TradingView alert webhook
// ═══════════════════════════════════════════════════════════════════════════
//
// TradingView sends JSON alerts via webhook. This endpoint:
// 1. Validates the webhook secret
// 2. Normalizes the signal to SMDApp format
// 3. Validates through canonical pipeline (SELL blocked, confidence check)
// 4. Creates signal in agent registry
// 5. Transitions through lifecycle
// 6. Optionally sends Telegram alert
//
// Expected TradingView webhook payload:
// {
//   "secret": "your-webhook-secret",
//   "action": "BUY_CE" | "BUY_PE",
//   "symbol": "NIFTY",
//   "strike": 25000,
//   "expiry": "18-09-2026",
//   "entry_price": 150,
//   "stop_loss": 120,
//   "target1": 200,
//   "target2": 250,
//   "confidence": 80,
//   "thesis": "Bullish momentum breakout",
//   "timeframe": "5m",
//   " indicators": { "rsi": 65, "macd": "bullish" }
// }
// ═══════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { registerAgent, getAgentByName, createSignal, emitEvent, isFeatureEnabled } from '@/lib/agents/registry';
import { transitionSignal } from '@/lib/agents/signal-lifecycle';

// Webhook secret — in production, set this in .env
const WEBHOOK_SECRET = process.env.TRADINGVIEW_WEBHOOK_SECRET || 'smdapp-tv-webhook-2026';

export async function POST(req: NextRequest) {
  try {
    if (!isFeatureEnabled('EXTERNAL_AGENT_ENABLED')) {
      return NextResponse.json({ error: 'External agents disabled' }, { status: 503 });
    }

    // Parse body
    const body = await req.json();

    // Validate webhook secret
    if (body.secret !== WEBHOOK_SECRET) {
      console.warn('[TradingView Webhook] Invalid secret attempt');
      return NextResponse.json({ error: 'Invalid secret' }, { status: 401 });
    }

    // Extract fields
    const {
      action, symbol, strike, expiry, entry_price, stop_loss,
      target1, target2, confidence, thesis, timeframe, indicators,
    } = body;

    // Validate required fields
    if (!action || !symbol) {
      return NextResponse.json({
        error: 'Missing required fields: action, symbol',
      }, { status: 400 });
    }

    // Block SELL signals
    if (action === 'SELL_CE' || action === 'SELL_PE' || action === 'SELL') {
      console.log(`[TradingView Webhook] SELL signal blocked: ${action} ${symbol}`);
      return NextResponse.json({
        ok: false,
        blocked: true,
        reason: 'SELL signals are strictly forbidden in SMDApp',
      }, { status: 422 });
    }

    // Validate action
    if (!['BUY_CE', 'BUY_PE', 'WAIT', 'EXIT'].includes(action)) {
      return NextResponse.json({
        error: `Invalid action: ${action}. Must be BUY_CE, BUY_PE, WAIT, or EXIT`,
      }, { status: 400 });
    }

    // Validate confidence
    const conf = confidence || 70;
    if (conf < 50) {
      return NextResponse.json({
        ok: false,
        rejected: true,
        reason: `Confidence ${conf} below minimum threshold 50`,
      }, { status: 422 });
    }

    // Get or register TradingView agent
    let tvAgent = getAgentByName('TRADINGVIEW');
    if (!tvAgent) {
      tvAgent = registerAgent({
        name: 'TRADINGVIEW',
        type: 'EXTERNAL_AGENT',
        version: '1.0',
        description: 'TradingView webhook alerts',
        metadata: { source: 'TRADINGVIEW_WEBHOOK' },
      });
    }

    // Determine option type
    let optionType: 'CE' | 'PE' | null = null;
    if (action === 'BUY_CE') optionType = 'CE';
    else if (action === 'BUY_PE') optionType = 'PE';

    // Build thesis with indicator context
    let fullThesis = thesis || `TradingView alert: ${action} ${symbol}`;
    if (indicators) {
      const indicatorStr = Object.entries(indicators)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      fullThesis += ` [Indicators: ${indicatorStr}]`;
    }
    if (timeframe) {
      fullThesis += ` [TF: ${timeframe}]`;
    }

    // Create signal
    const signal = createSignal({
      agentId: tvAgent.id,
      market: 'INDIA',
      exchange: 'NSE',
      underlying: symbol,
      signalType: 'EXTERNAL',
      direction: action,
      optionType,
      strike: strike || null,
      expiry: expiry || null,
      entryPrice: entry_price || null,
      stopLoss: stop_loss || null,
      target1: target1 || null,
      target2: target2 || null,
      confidence: conf / 100,
      thesis: fullThesis,
      evidence: {
        priceStructure: indicators?.price_structure || null,
        volume: indicators?.volume || null,
        vix: indicators?.vix || null,
      },
      dataSource: 'TRADINGVIEW',
      dataFreshness: 'SNAPSHOT',
    });

    // Transition through lifecycle
    transitionSignal(signal.id, 'CANDIDATE');
    transitionSignal(signal.id, 'VALIDATING');
    transitionSignal(signal.id, 'VALIDATED');
    transitionSignal(signal.id, 'FINAL');

    emitEvent('EXTERNAL_SIGNAL_RECEIVED', tvAgent.id, {
      signalId: signal.id,
      direction: action,
      symbol,
      strike,
      confidence: conf,
    });

    console.log(`[TradingView Webhook] Signal ingested: ${action} ${symbol} @ ${strike} (confidence: ${conf}%)`);

    return NextResponse.json({
      ok: true,
      signalId: signal.id,
      lifecycle: signal.lifecycle,
      direction: action,
      underlying: symbol,
      strike,
      confidence: conf,
    });
  } catch (error: any) {
    console.error('[TradingView Webhook] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// GET — health check
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    endpoint: 'TradingView Webhook',
    usage: 'POST with JSON body containing secret, action, symbol, etc.',
    features: {
      sellBlocking: true,
      confidenceThreshold: 50,
      lifecycleTracking: true,
      telegramAlerts: false, // TODO: wire up
    },
  });
}
