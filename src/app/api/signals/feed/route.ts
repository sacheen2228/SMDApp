// ═══════════════════════════════════════════════════════════════════════════
// GET /api/signals/feed — Real-time signal feed from all agents
// ═══════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { getSignalFeed, isFeatureEnabled } from '@/lib/agents/registry';

export async function GET(req: NextRequest) {
  try {
    if (!isFeatureEnabled('AGENT_SIGNAL_FEED_ENABLED')) {
      return NextResponse.json({ error: 'Signal feed disabled', enabled: false }, { status: 503 });
    }

    const { searchParams } = new URL(req.url);
    const underlying = searchParams.get('underlying') || undefined;
    const exchange = searchParams.get('exchange') || undefined;
    const signalType = searchParams.get('signalType') as any || undefined;
    const agentId = searchParams.get('agentId') || undefined;
    const direction = searchParams.get('direction') as any || undefined;
    const limit = parseInt(searchParams.get('limit') || '50');
    const since = searchParams.get('since') || undefined;

    let signals = getSignalFeed({
      underlying,
      exchange,
      signalType,
      agentId,
      direction,
    });

    // Filter by since if provided
    if (since) {
      signals = signals.filter(s => s.timestamp >= since);
    }

    // Limit results
    signals = signals.slice(0, limit);

    // Sanitize evidence for external clients (Point 54)
    const sanitized = signals.map(s => ({
      id: s.id,
      agentId: s.agentId,
      timestamp: s.timestamp,
      market: s.market,
      exchange: s.exchange,
      underlying: s.underlying,
      signalType: s.signalType,
      direction: s.direction,
      optionType: s.optionType,
      strike: s.strike,
      expiry: s.expiry,
      confidence: s.confidence,
      thesis: s.thesis,
      lifecycle: s.lifecycle,
      validationStatus: s.validationStatus,
      executionStatus: s.executionStatus,
      expiresAt: s.expiresAt,
      // Evidence is sanitized — only non-sensitive fields
      evidence: {
        priceStructure: s.evidence.priceStructure,
        volume: s.evidence.volume,
        callOI: s.evidence.callOI,
        putOI: s.evidence.putOI,
        vix: s.evidence.vix,
      },
    }));

    return NextResponse.json({
      enabled: true,
      count: sanitized.length,
      signals: sanitized,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
