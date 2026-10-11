// GET /api/web-intel/records — locally synced + enriched web records.
// Filters: limit, hours (recency window), symbol, impact, source.
// Evidence only — reading these never places an order.

import { NextRequest, NextResponse } from 'next/server';
import { getRecentRecords } from '@/lib/web-intel/store';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const limit = Math.min(parseInt(sp.get('limit') || '50', 10) || 50, 500);
    const hours = Math.min(parseInt(sp.get('hours') || '48', 10) || 48, 24 * 30);
    const symbol = (sp.get('symbol') || '').toUpperCase();
    const impact = (sp.get('impact') || '').toUpperCase();
    const source = sp.get('source') || '';

    let records = await getRecentRecords({ limit: 500, sinceHours: hours });
    if (symbol) records = records.filter((r) => r.symbols.includes(symbol));
    if (impact) records = records.filter((r) => r.impact === impact);
    if (source) records = records.filter((r) => r.source === source);

    const sliced = records.slice(0, limit);
    return NextResponse.json({
      success: true,
      count: sliced.length,
      total: records.length,
      evidenceOnly: true,
      records: sliced,
    });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: String(e?.message ?? e) },
      { status: 503 },
    );
  }
}
