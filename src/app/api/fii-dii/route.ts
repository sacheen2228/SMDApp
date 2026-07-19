import { NextResponse } from 'next/server';
import { fetchFiiDiiData } from '@/lib/fii-dii';

export async function GET() {
  try {
    const data = await fetchFiiDiiData();
    return NextResponse.json({
      success: true,
      fiiNet: data.latest.fiiNet,
      diiNet: data.latest.diiNet,
      fiiBuy: data.latest.fiiBuy,
      fiiSell: data.latest.fiiSell,
      diiBuy: data.latest.diiBuy,
      diiSell: data.latest.diiSell,
      date: data.latest.date,
      source: data.latest.source,
      history: data.history,
    });
  } catch (err: any) {
    console.error('[API] FII/DII error:', err);
    return NextResponse.json(
      { success: false, error: err.message || 'Failed to fetch FII/DII data' },
      { status: 500 },
    );
  }
}
