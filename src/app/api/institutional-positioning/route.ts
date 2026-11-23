import { NextRequest, NextResponse } from 'next/server';
import { runInstitutionalPositioning, generateAIMarketSummary } from '@/lib/institutional-positioning-engine';

export async function GET(req: NextRequest) {
  try {
    // `?fast=1` — the persisted snapshot only (the engine's dbOnly path): no
    // NSE scan, so it answers in seconds instead of the ~5 minutes the full
    // participant-OI history scan can take. The source in the payload says
    // which path produced it ("db" vs "nse").
    const fast = req.nextUrl.searchParams.get('fast') === '1';
    const data = await runInstitutionalPositioning(fast ? { dbOnly: true } : undefined);
    const summary = generateAIMarketSummary(data);
    return NextResponse.json({
      success: true,
      ...data,
      aiSummary: summary,
      snapshotOnly: fast,
      warning: data.source === 'none' ? 'No participant OI data available. Analysis based on empty positions — results are not actionable.' : undefined,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message || 'Failed' },
      { status: 500 }
    );
  }
}
