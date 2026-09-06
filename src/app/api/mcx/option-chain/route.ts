// MCX Commodity Module — Option Chain API
// GET /api/mcx/option-chain?symbol=CRUDEOIL — option chain for a commodity

import { NextResponse } from 'next/server';
import { loadMCXOptionChain, loadAllMCXOptionChains } from '@/lib/mcx/option-chain';
import type { MCXCommodity } from '@/lib/mcx/types';
import { MCX_APPROVED_CONTRACTS } from '@/lib/mcx/types';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') as MCXCommodity | null;

    if (symbol) {
      // Single commodity option chain
      if (!MCX_APPROVED_CONTRACTS.includes(symbol)) {
        return NextResponse.json(
          { success: false, error: `Invalid symbol: ${symbol}. Only 10 approved MCX contracts.` },
          { status: 400 }
        );
      }

      const chain = await loadMCXOptionChain(symbol);
      if (!chain) {
        return NextResponse.json({
          success: true,
          symbol,
          chain: null,
          message: 'No option data available (Motilal not connected or no options listed)',
        });
      }

      return NextResponse.json({
        success: true,
        symbol,
        chain,
      });
    }

    // All MCX option chains
    const chains = await loadAllMCXOptionChains();
    const result: Record<string, any> = {};
    for (const [sym, chain] of chains) {
      result[sym] = chain;
    }

    return NextResponse.json({
      success: true,
      totalChains: Object.keys(result).length,
      chains: result,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message || 'Failed to fetch MCX option chain' },
      { status: 500 }
    );
  }
}
