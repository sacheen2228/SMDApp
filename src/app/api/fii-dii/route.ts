import { NextResponse } from 'next/server';
import { fetchFIIDII } from '@/lib/market-data-service';
import { buildFreshnessMeta } from '@/lib/api-freshness';
import { buildCardMeta, getMarketClock } from '@/lib/data-freshness';

export async function GET() {
  try {
    const envelope = await fetchFIIDII({
      symbol: "NIFTY",
      nowMs: Date.now(),
    });

    if (!envelope.available) {
      const clock = await getMarketClock();
      const meta = buildCardMeta({
        source: 'none',
        providerTimestamp: null,
        ttlMs: 24 * 3600_000,
        live: false,
        reason: 'FII/DII feed unavailable (all providers failed)',
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

    const clock = await getMarketClock();
    const data = envelope.data as any;
    const dataDate = data.date;
    const providerStamp = dataDate ? new Date(dataDate) : null;
    const freshness = buildFreshnessMeta({
      provider: envelope.provider,
      dataTimestamp: dataDate ? new Date(dataDate) : new Date(0),
      dataType: "fiiDii",
      fallbackUsed: envelope.fallbackUsed,
      fallbackReason: envelope.fallbackReason,
    });

    const meta = buildCardMeta({
      source: envelope.provider,
      providerTimestamp: providerStamp,
      ttlMs: 24 * 3600_000,
      live: clock.isOpen,
      reason: clock.isOpen ? undefined : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
    });

    const resp: any = {
      success: true,
      status: meta.status,
      data: meta,
      fiiNet: data.fiiNet,
      diiNet: data.diiNet,
      fiiBuy: data.fiiBuy,
      fiiSell: data.fiiSell,
      diiBuy: data.diiBuy,
      diiSell: data.diiSell,
      date: data.date,
      source: envelope.provider,
      freshness,
      fiiNet5dAvg: data.fiiNet5dAvg ?? null,
      diiNet5dAvg: data.diiNet5dAvg ?? null,
      fiiFutLongRatio: data.fiiFutLongRatio ?? null,
      provenance: {
        source: envelope.provider,
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
