import { NextResponse } from 'next/server';
import { fetchFiiDiiData } from '@/lib/fii-dii';
import { buildFreshnessMeta } from '@/lib/api-freshness';
import { buildCardMeta, getMarketClock } from '@/lib/data-freshness';

export async function GET() {
  try {
    const data = await fetchFiiDiiData();
    const clock = await getMarketClock();

    if (!data.available) {
      // Neither NSE nor MrChartist answered — say so instead of rendering
      // the zero-filled placeholder as "FII net 0".
      const meta = buildCardMeta({
        source: 'none',
        providerTimestamp: null,
        ttlMs: 24 * 3600_000,
        live: false,
        reason: 'FII/DII feed unavailable (neither NSE nor MrChartist answered)',
      });
      return NextResponse.json(
        {
          success: false,
          status: 'UNAVAILABLE',
          error: meta.reason,
          data: meta,
          date: null,
          source: null,
          fiiNet: null,
          diiNet: null,
          fiiBuy: null,
          fiiSell: null,
          diiBuy: null,
          diiSell: null,
          fiiNet5dAvg: null,
          diiNet5dAvg: null,
          fiiFutLongRatio: null,
          history: [],
          timestamp: new Date().toISOString(),
        },
        { status: 503 },
      );
    }

    const dataDate = data.latest.date;
    // An undated feed is not LIVE — it is an undated snapshot. Fall back to
    // epoch 0 so classifyFreshness() honestly reports STALE/UNAVAILABLE
    // rather than fabricating "collected right now".
    const freshness = buildFreshnessMeta({
      provider: data.latest.source || "nse",
      dataTimestamp: dataDate ? new Date(dataDate) : new Date(0),
      dataType: "fiiDii",
    });

    const providerStamp = dataDate ? new Date(dataDate) : null;
    const meta = buildCardMeta({
      source: data.latest.source || "nse",
      providerTimestamp: providerStamp,
      ttlMs: 24 * 3600_000,
      live: clock.isOpen,
      reason: clock.isOpen ? undefined : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
    });

    const resp: any = {
      success: true,
      status: meta.status,
      data: meta,
      fiiNet: data.latest.fiiNet,
      diiNet: data.latest.diiNet,
      fiiBuy: data.latest.fiiBuy,
      fiiSell: data.latest.fiiSell,
      diiBuy: data.latest.diiBuy,
      diiSell: data.latest.diiSell,
      date: data.latest.date,
      source: data.latest.source,
      freshness,
      // null when the feed had no history / no participant OI — never a 0
      // that reads like "FII was flat".
      fiiNet5dAvg: data.fiiNet5dAvg ?? null,
      diiNet5dAvg: data.diiNet5dAvg ?? null,
      fiiFutLongRatio: data.fiiFutLongRatio ?? null,
      provenance: {
        source: data.latest.source || 'NSE',
        // The provider's own trade date (the FII/DII file is published for a
        // session, not "now").
        retrievedAt: providerStamp ? providerStamp.toISOString() : null,
        collectedAt: new Date().toISOString(),
        freshness: freshness.freshness,
        isLive: freshness.freshness === 'LIVE',
        ageSeconds: Math.round(freshness.ageMs / 1000),
        ageLabel: meta.ageLabel,
        status: 'AVAILABLE',
        historyRows: data.history?.length ?? 0,
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
      { success: false, status: 'UNAVAILABLE', error: err.message || 'Failed to fetch FII/DII data' },
      { status: 500 },
    );
  }
}
