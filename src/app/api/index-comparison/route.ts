// Index Comparison API - Compare all 5 primary indices side by side

import { analyzeAllIndices } from '@/lib/index-comparison';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const interval = searchParams.get('interval') || '5m';
    const limit = Math.min(parseInt(searchParams.get('limit') || '300'), 500);

    const result = await analyzeAllIndices(interval, limit);

    return NextResponse.json({
      success: true,
      data: {
        comparison: result.comparison,
        relativeStrength: result.relativeStrength,
        ranking: result.ranking,
        timestamp: result.timestamp,
      },
    });
  } catch (error: any) {
    console.error('[Index Comparison API] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}