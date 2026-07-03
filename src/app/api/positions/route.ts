// API Route - Positions & Holdings
// Get positions, holdings, and funds from ICICI Breeze

import { NextRequest, NextResponse } from 'next/server';
import { getPositions, getHoldings, getFunds } from '@/lib/icici-breeze/positions';

// ─── GET: Get positions and holdings ──────────────────────────────
export async function GET() {
  try {
    const [positions, holdings, funds] = await Promise.all([
      getPositions().catch(() => []),
      getHoldings().catch(() => []),
      getFunds().catch(() => null),
    ]);
    
    return NextResponse.json({
      success: true,
      data: {
        positions,
        holdings,
        funds,
      },
    });
  } catch (error: any) {
    console.error('[API] Get positions error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to fetch positions' },
      { status: 500 }
    );
  }
}
