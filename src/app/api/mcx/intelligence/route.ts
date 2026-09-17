// MCX Intelligence API — exposes MCX commodity intelligence to Hermes Pro
// GET /api/mcx/intelligence?symbol=CRUDEOIL — single instrument
// GET /api/mcx/intelligence — all instruments

import { NextRequest, NextResponse } from 'next/server';
import { analyzeMCXInstrument, scanAllMCX, getBestMCXOpportunity, getMCXSystemStatus } from '@/lib/mcx/mcx-intelligence';
import type { MCXCommodity } from '@/lib/mcx/types';
import { MCX_APPROVED_CONTRACTS } from '@/lib/mcx/types';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') as MCXCommodity | null;
    const action = searchParams.get('action');

    // Single instrument analysis (when symbol provided)
    if (symbol && MCX_APPROVED_CONTRACTS.includes(symbol)) {
      const intel = await analyzeMCXInstrument(symbol);
      return NextResponse.json({
        success: true,
        intelligence: {
          symbol: intel.symbol,
          regime: intel.regime,
          structure: intel.structure,
          volumeOI: intel.volumeOI,
          volatility: intel.volatility,
          optionIntel: intel.optionIntel,
          longScore: intel.longScore,
          shortScore: intel.shortScore,
          bestCandidate: intel.bestCandidate,
          dataFreshness: intel.dataFreshness,
        },
        timestamp: intel.timestamp,
      });
    }

    // Action-based endpoints (no symbol)
    switch (action) {
      case 'status': {
        const status = await getMCXSystemStatus();
        return NextResponse.json({ success: true, ...status });
      }

      case 'best': {
        const best = await getBestMCXOpportunity();
        return NextResponse.json({
          success: true,
          opportunity: best,
          timestamp: new Date().toISOString(),
        });
      }

      case 'scan': {
        const results = await scanAllMCX();
        return NextResponse.json({
          success: true,
          instruments: results.map(r => ({
            symbol: r.symbol,
            regime: r.regime.regime,
            regimeConfidence: r.regime.confidence,
            structureBias: r.structure.bias,
            structureEvent: r.structure.event,
            oiClassification: r.volumeOI.oiClassification,
            relativeVolume: r.volumeOI.relativeVolume,
            volatilityRegime: r.volatility.volatilityRegime,
            chainQuality: r.optionIntel.chainQuality,
            longScore: r.longScore.total,
            shortScore: r.shortScore.total,
            bestCandidate: r.bestCandidate ? {
              direction: r.bestCandidate.direction,
              score: r.bestCandidate.score.total,
              entry: r.bestCandidate.entry,
              stopLoss: r.bestCandidate.stopLoss,
              target1: r.bestCandidate.target1,
              target2: r.bestCandidate.target2,
              actualRR: r.bestCandidate.actualRR,
            } : null,
            dataFreshness: r.dataFreshness,
          })),
          timestamp: new Date().toISOString(),
        });
      }

      default: {
        // Default to status
        const status = await getMCXSystemStatus();
        return NextResponse.json({ success: true, ...status });
      }
    }
  } catch (error: any) {
    console.error('[MCX Intelligence API] Error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal error' },
      { status: 500 }
    );
  }
}
