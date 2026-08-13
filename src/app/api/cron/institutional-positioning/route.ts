import { NextRequest, NextResponse } from 'next/server';
import { runInstitutionalPositioning } from '@/lib/institutional-positioning-engine';

const SECRET = process.env.DAILY_SCAN_SECRET;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const authHeader = request.headers.get('authorization');
    if (!SECRET || (authHeader !== `Bearer ${SECRET}` && searchParams.get('secret') !== SECRET)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('[InstPositioning Cron] Fetching NSE participant OI data...');
    const data = await runInstitutionalPositioning();
    console.log('[InstPositioning Cron] Done —',
      `scores=${data.strengthScores?.length || 0}`,
      `bias=${data.bias?.dominantDirection || 'unknown'}`,
      `filter=${data.institutionalFilter?.verdict || 'unknown'}`);

    return NextResponse.json({
      success: true,
      message: 'Institutional positioning data refreshed',
      timestamp: new Date().toISOString(),
      summary: {
        bias: data.bias?.dominantDirection,
        filter: data.institutionalFilter?.verdict,
        prediction: data.prediction?.tomorrowBias,
        trapDetected: data.retailTrap?.detected,
        scores: (data.strengthScores || []).map((s: any) => ({
          participant: s.participant,
          score: s.score,
          direction: s.direction,
        })),
      },
    });
  } catch (error: any) {
    console.error('[InstPositioning Cron] Failed:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
