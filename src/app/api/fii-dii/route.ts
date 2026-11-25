import { NextResponse } from 'next/server';
import { fetchFIIDII } from '@/lib/market-data-service';
import { buildFreshnessMeta } from '@/lib/api-freshness';
import { buildCardMeta, getMarketClock } from '@/lib/data-freshness';

/** Human label for the source of the numbers. */
function sourceLabel(source: string | undefined | null): string {
  if (source === 'nse') return 'NSE';
  if (source === 'nse-eod') return 'NSE EOD';
  if (source === 'mrchartist') return 'MrChartist (fallback)';
  return '';
}

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
          sourceLabel: '',
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
    // The feed is published once per session (~18:00 IST). Age the figure from
    // its publication instant — midnight would age a same-session figure into
    // "STALE" by the end of the evening.
    const { fiiDiiPublishedAtIso } = await import('@/lib/fii-dii');
    const publishedAtIso = dataDate ? fiiDiiPublishedAtIso(dataDate) : null;
    const providerStamp = publishedAtIso ? new Date(publishedAtIso) : (dataDate ? new Date(dataDate) : null);
    const freshness = buildFreshnessMeta({
      provider: envelope.provider,
      dataTimestamp: providerStamp ?? new Date(0),
      dataType: "fiiDii",
      fallbackUsed: envelope.fallbackUsed,
      fallbackReason: envelope.fallbackReason,
    });

    // FII/DII is a once-a-day EOD feed: the freshest published figure IS the
    // current one until the next session publishes. The card status is derived
    // from the SAME age/TTL + session classification as `freshness`, so the two
    // labels can never contradict (previously status=STALE while freshness=FRESH).
    const status = freshness.freshness === "STALE" || freshness.freshness === "UNAVAILABLE"
      ? "STALE"
      : "AVAILABLE";

    const meta = buildCardMeta({
      source: envelope.provider,
      providerTimestamp: providerStamp,
      ttlMs: 24 * 3600_000,
      freshness: freshness.freshness,
      reason: clock.isOpen
        ? undefined
        : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
    });

    const resp: any = {
      success: true,
      status,
      timestamp: providerStamp ? providerStamp.toISOString() : new Date(0).toISOString(),
      data: { ...meta, status },
      fiiNet: data.fiiNet,
      diiNet: data.diiNet,
      fiiBuy: data.fiiBuy,
      fiiSell: data.fiiSell,
      diiBuy: data.diiBuy,
      diiSell: data.diiSell,
      date: data.date,
      dataDate: data.date,
      source: envelope.provider,
      sourceLabel: sourceLabel(data.source),
      freshness,
      fiiNet5dAvg: data.fiiNet5dAvg ?? null,
      diiNet5dAvg: data.diiNet5dAvg ?? null,
      fiiFutLongRatio: data.fiiFutLongRatio ?? null,
      provenance: {
        source: envelope.provider,
        dataSource: data.source,
        retrievedAt: providerStamp ? providerStamp.toISOString() : null,
        collectedAt: new Date().toISOString(),
        freshness: freshness.freshness,
        isLive: freshness.freshness === 'LIVE',
        ageSeconds: Math.round(freshness.ageMs / 1000),
        ageLabel: meta.ageLabel,
        status: 'AVAILABLE',
        historyRows: data.history?.length ?? 0,
        ...(data.expectedSession ? { expectedSession: data.expectedSession } : {}),
        ...(data.rejectedSources?.length ? { rejectedSources: data.rejectedSources } : {}),
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
