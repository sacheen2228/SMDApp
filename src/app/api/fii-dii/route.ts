import { NextResponse } from 'next/server';
import { fetchFiiDiiData } from '@/lib/fii-dii';
import { buildFreshnessMeta } from '@/lib/api-freshness';

export async function GET() {
  try {
    const data = await fetchFiiDiiData();
    const dataDate = data.latest.date;
    const freshness = buildFreshnessMeta({
      provider: data.latest.source || "nse",
      dataTimestamp: dataDate ? new Date(dataDate) : new Date(),
      dataType: "fiiDii",
    });

    const resp: any = {
      success: true,
      fiiNet: data.latest.fiiNet,
      diiNet: data.latest.diiNet,
      fiiBuy: data.latest.fiiBuy,
      fiiSell: data.latest.fiiSell,
      diiBuy: data.latest.diiBuy,
      diiSell: data.latest.diiSell,
      date: data.latest.date,
      source: data.latest.source,
      freshness,
      fiiNet5dAvg: data.fiiNet5dAvg ?? 0,
      diiNet5dAvg: data.diiNet5dAvg ?? 0,
      fiiFutLongRatio: data.fiiFutLongRatio ?? 0.5,
      provenance: {
        source: data.latest.source || 'NSE',
        retrievedAt: new Date().toISOString(),
        freshness: freshness.freshness === 'LIVE' ? 'LIVE' : freshness.freshness === 'FRESH' ? 'FRESH' : 'DELAYED',
        isLive: freshness.freshness === 'LIVE',
        ageSeconds: Math.round(freshness.ageMs / 1000),
        status: 'AVAILABLE',
      },
      history: data.history,
    };
    if (data.participantOI) {
      resp.participantOI = data.participantOI;
    }
    return NextResponse.json(resp);
  } catch (err: any) {
    console.error('[API] FII/DII error:', err);
    return NextResponse.json(
      { success: false, error: err.message || 'Failed to fetch FII/DII data' },
      { status: 500 },
    );
  }
}
