// Master Selection API - Best Market/Instrument Selection

import { runMasterSelection } from '@/lib/master-selection';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    const config = {
      equityPriceFilter: parseInt(searchParams.get('equityPriceFilter') || '1000'),
      minLiquidity: parseInt(searchParams.get('minLiquidity') || '50'),
      minSignalStrength: parseInt(searchParams.get('minSignalStrength') || '60'),
      minRr: parseFloat(searchParams.get('minRr') || '1.5'),
      maxOpportunities: parseInt(searchParams.get('maxOpportunities') || '50'),
      includeIndices: searchParams.get('includeIndices') !== 'false',
      includeEquities: searchParams.get('includeEquities') !== 'false',
      includeStockFutures: searchParams.get('includeStockFutures') !== 'false',
      includeStockOptions: searchParams.get('includeStockOptions') !== 'false',
      includeIndexFutures: searchParams.get('includeIndexFutures') !== 'false',
      includeIndexOptions: searchParams.get('includeIndexOptions') !== 'false',
    };

    const result = await runMasterSelection(config);

    return NextResponse.json({
      success: true,
      data: {
        bestOverall: result.bestOverall,
        byMarket: Object.fromEntries(result.byMarket),
        allOpportunities: result.allOpportunities,
        timestamp: result.timestamp,
        scanStats: result.scanStats,
      },
    });
  } catch (error: any) {
    console.error('[Master Selection API] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}