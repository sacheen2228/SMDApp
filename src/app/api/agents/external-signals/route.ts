// ═══════════════════════════════════════════════════════════════════════════
// GET /api/agents/external-signals — Fetch and normalize external agent signals
// POST /api/agents/external-signals — Submit external signal for ingestion
// ═══════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { isFeatureEnabled, getSignalsByAgent } from '@/lib/agents/registry';
import { syncExternalAgents, ingestExternalSignals, getExternalAgentStats, initAITraderAdapter } from '@/lib/external/ai-trader/adapter';
import { normalizeSignal } from '@/lib/external/ai-trader/normalizer';
import { validateExternalSignal } from '@/lib/external/ai-trader/validator';
import { registerAgent, getAgentByName, createSignal, emitEvent } from '@/lib/agents/registry';

export async function GET(req: NextRequest) {
  try {
    if (!isFeatureEnabled('EXTERNAL_AGENT_ENABLED')) {
      return NextResponse.json({ error: 'External agents disabled', enabled: false }, { status: 503 });
    }

    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');

    if (action === 'sync') {
      const agents = await syncExternalAgents();
      return NextResponse.json({
        ok: true,
        synced: agents.length,
        agents: agents.map(a => ({ id: a.id, name: a.name, status: a.status })),
      });
    }

    if (action === 'ingest') {
      const result = await ingestExternalSignals();
      return NextResponse.json({ ok: true, ...result });
    }

    // Default: show stats
    const stats = getExternalAgentStats();
    return NextResponse.json({
      enabled: true,
      stats,
      usage: 'GET ?action=sync to sync agents, ?action=ingest to ingest signals',
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!isFeatureEnabled('EXTERNAL_AGENT_ENABLED')) {
      return NextResponse.json({ error: 'External agents disabled' }, { status: 503 });
    }

    const body = await req.json();
    const { agent_name, signal } = body;

    if (!agent_name || !signal) {
      return NextResponse.json({ error: 'agent_name and signal required' }, { status: 400 });
    }

    // Find or register agent
    let agent = getAgentByName(agent_name);
    if (!agent) {
      agent = registerAgent({
        name: agent_name,
        type: 'EXTERNAL_AGENT',
        version: signal.version || '0.1',
        description: `External agent: ${agent_name}`,
        metadata: { source: 'AI_TRADER' },
      });
    }

    // Normalize
    const normalized = normalizeSignal({ ...signal, agent_name }, agent.id);

    // Validate
    const validation = validateExternalSignal(normalized);
    if (!validation.valid) {
      emitEvent('EXTERNAL_SIGNAL_REJECTED', agent.id, {
        signalId: signal.id,
        reasons: validation.reasons,
      });
      return NextResponse.json({
        ok: false,
        rejected: true,
        reasons: validation.reasons,
        warnings: validation.warnings,
      }, { status: 422 });
    }

    // Create signal
    const created = createSignal({
      agentId: agent.id,
      market: normalized.market,
      exchange: normalized.exchange,
      underlying: normalized.underlying,
      signalType: 'EXTERNAL',
      direction: normalized.direction,
      optionType: normalized.optionType || undefined,
      strike: normalized.strike || undefined,
      expiry: normalized.expiry || undefined,
      entryPrice: normalized.entryPrice || undefined,
      stopLoss: normalized.stopLoss || undefined,
      target1: normalized.target1 || undefined,
      target2: normalized.target2 || undefined,
      confidence: normalized.confidence,
      thesis: normalized.thesis,
      evidence: normalized.evidence,
      dataSource: 'EXTERNAL_AGENT',
      dataFreshness: 'SNAPSHOT',
    });

    emitEvent('EXTERNAL_SIGNAL_RECEIVED', agent.id, {
      signalId: created.id,
      direction: normalized.direction,
    });

    return NextResponse.json({
      ok: true,
      signalId: created.id,
      lifecycle: created.lifecycle,
      warnings: validation.warnings,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
