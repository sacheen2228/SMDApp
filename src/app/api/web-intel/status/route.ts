// GET /api/web-intel/status — collector ONLINE/OFFLINE, last collection,
// last sync, market + news freshness, per-source health, missed records.
// Evidence-layer status only; never gates or creates trades.

import { NextResponse } from 'next/server';
import { getWebIntelStatus } from '@/lib/web-intel/status';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const status = await getWebIntelStatus();
    return NextResponse.json({ success: true, ...status }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e: any) {
    return NextResponse.json(
      {
        success: false,
        error: String(e?.message ?? e),
        evidenceOnly: true,
      },
      { status: 503 },
    );
  }
}
