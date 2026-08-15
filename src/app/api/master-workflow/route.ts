// Master Trading Workflow API - Complete end-to-end analysis

import { runMasterTradingWorkflow } from '@/lib/master-workflow';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    const config = {
      scanIndices: searchParams.get('scanIndices') !== 'false',
      scanEquities: searchParams.get('scanEquities') !== 'false',
      scanStockFutures: searchParams.get('scanStockFutures') !== 'false',
      scanStockOptions: searchParams.get('scanStockOptions') !== 'false',
      scanIndexFutures: searchParams.get('scanIndexFutures') !== 'false',
      scanIndexOptions: searchParams.get('scanIndexOptions') !== 'false',
      equityPriceFilter: parseInt(searchParams.get('equityPriceFilter') || '1000'),
      minSignalStrength: parseInt(searchParams.get('minSignalStrength') || '60'),
      minLiquidity: parseInt(searchParams.get('minLiquidity') || '50'),
      minRr: parseFloat(searchParams.get('minRr') || '1.5'),
      interval: searchParams.get('interval') || '5m',
      limit: Math.min(parseInt(searchParams.get('limit') || '300'), 500),
    };

    const result = await runMasterTradingWorkflow(config);

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error('[Master Workflow API] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}