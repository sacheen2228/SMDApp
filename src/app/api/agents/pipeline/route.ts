// ═══════════════════════════════════════════════════════════════════════════
// /api/agents/pipeline — production entry for the 30-agent system (v2 §3)
// Builds ONE shared snapshot, runs all 30 agents, Grok, engines.
// dryRun defaults to TRUE: no trade registration unless explicitly disabled.
// Alert-only scope (v2 §0): never places broker orders.
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import { buildAgentSnapshot } from '@/lib/agents/snapshot';
import { runFullPipeline } from '@/lib/agents/pipeline';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get('symbol') || 'NIFTY').toUpperCase();
  const dryRun = req.nextUrl.searchParams.get('dryRun') !== '0';

  try {
    const { ctx, fetchedAtIso } = await buildAgentSnapshot(symbol);
    const result = await runFullPipeline(symbol, ctx, { dryRun });

    return Response.json({
      ok: true,
      symbol,
      fetchedAtIso,
      dryRun,
      result,
    });
  } catch (err: any) {
    return Response.json(
      { ok: false, symbol, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
