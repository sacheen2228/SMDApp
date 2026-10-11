// POST /api/web-intel/sync — force one incremental sync pass
// (local cursor → server timestamp → dedupe → enrich → insert).
// GET  returns current cursor info without syncing.

import { NextResponse } from 'next/server';
import { syncWebIntelFull } from '@/lib/web-intel/sync';
import { getLocalTotal, getSyncCursor, getNewestPublishedAt } from '@/lib/web-intel/store';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const result = await syncWebIntelFull();
    return NextResponse.json({ success: !result.error, ...result });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: String(e?.message ?? e) },
      { status: 503 },
    );
  }
}

export async function GET() {
  try {
    const [cursor, localTotal, newestPublishedAt] = await Promise.all([
      getSyncCursor(),
      getLocalTotal(),
      getNewestPublishedAt(),
    ]);
    return NextResponse.json({
      success: true,
      cursor,
      localTotal,
      newestPublishedAt,
    });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: String(e?.message ?? e) },
      { status: 503 },
    );
  }
}
