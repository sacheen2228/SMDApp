import { NextRequest, NextResponse } from 'next/server';
import { runInstitutionalPositioning, getInstitutionalFilter, todayDDMMYYYYIST, hasParticipantDataForDate } from '@/lib/institutional-positioning-engine';

const SECRET = process.env.DAILY_SCAN_SECRET;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const authHeader = request.headers.get('authorization');
    if (!SECRET || (authHeader !== `Bearer ${SECRET}` && searchParams.get('secret') !== SECRET)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const today = todayDDMMYYYYIST();
    const force = searchParams.get('force') === '1';

    // Freshness guard: if we already pulled today's data, skip re-fetch to avoid hammering NSE
    if (!force && await hasParticipantDataForDate(today)) {
      console.log('[InstPositioning Cron] Data already present for today', today, '- skipping fresh fetch');
      return NextResponse.json({
        success: true,
        message: 'Institutional positioning data already fresh for today',
        timestamp: new Date().toISOString(),
        alreadyFresh: true,
      });
    }

    console.log('[InstPositioning Cron] Fetching NSE participant OI data...');
    // Force fresh NSE fetch (skip 10-min cache) and verify today's date
    const data = await runInstitutionalPositioning({ skipCache: true });
    const todayDDMMYYYY = new Date().toISOString().slice(5, 10).replace(/-/g, '');
    if (data.date !== todayDDMMYYYY) {
      console.warn('[InstPositioning Cron] Expected date', todayDDMMYYYY, 'but got', data.date, '- returning data gap');
      return NextResponse.json(
        { success: false, error: 'NSE data not yet published for today; will retry on next scheduled run.' },
        { status: 200 }
      );
    }

    const filter = getInstitutionalFilter(data);
    console.log('[InstPositioning Cron] Done —',
      `scores=${data.strengthScores?.length || 0}`,
      `bias=${data.bias?.dominantDirection || 'unknown'}`,
      `filter=${filter.action}`);

    return NextResponse.json({
      success: true,
      message: 'Institutional positioning data refreshed',
      timestamp: new Date().toISOString(),
      summary: {
        bias: data.bias?.dominantDirection,
        filter: filter.action,
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
