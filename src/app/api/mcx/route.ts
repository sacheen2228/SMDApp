// MCX Commodity Module — API Endpoint
// GET /api/mcx — MCX market data, session, health

import { NextResponse } from 'next/server';
import { fetchMCXMarketData } from '@/lib/mcx/market-data';
import { getMCXSession, getMCXSessionLabel, getMCXSessionColor } from '@/lib/mcx/session';
import { MCX_APPROVED_CONTRACTS } from '@/lib/mcx/types';
import { MCX_CONTRACT_SPECS } from '@/lib/mcx/instrument-master';

export async function GET() {
  try {
    const [marketData, session] = await Promise.all([
      fetchMCXMarketData(),
      Promise.resolve(getMCXSession()),
    ]);

    // Build response with quotes organized by category
    const energy = MCX_APPROVED_CONTRACTS
      .filter(s => MCX_CONTRACT_SPECS[s].category === 'ENERGY')
      .map(s => ({
        ...marketData.quotes.get(s),
        spec: MCX_CONTRACT_SPECS[s],
      }));

    const preciousMetals = MCX_APPROVED_CONTRACTS
      .filter(s => MCX_CONTRACT_SPECS[s].category === 'PRECIOUS_METALS')
      .map(s => ({
        ...marketData.quotes.get(s),
        spec: MCX_CONTRACT_SPECS[s],
      }));

    return NextResponse.json({
      success: true,
      session: {
        state: session.state,
        label: getMCXSessionLabel(session.state),
        color: getMCXSessionColor(session.state),
        isActive: session.isActive,
        description: session.description,
        minutesRemaining: session.minutesRemaining,
      },
      data: {
        energy,
        preciousMetals,
      },
      health: marketData.dataHealth,
      lastUpdate: marketData.lastUpdate,
      totalContracts: MCX_APPROVED_CONTRACTS.length,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message || 'Failed to fetch MCX data' },
      { status: 500 }
    );
  }
}
