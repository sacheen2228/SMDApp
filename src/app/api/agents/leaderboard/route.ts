// ═══════════════════════════════════════════════════════════════════════════
// GET /api/agents/leaderboard — Agent performance leaderboard
// ═══════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { isFeatureEnabled } from '@/lib/agents/registry';
import { getLeaderboard } from '@/lib/agents/reputation';

export async function GET(req: NextRequest) {
  try {
    if (!isFeatureEnabled('AGENT_PERFORMANCE_ENABLED')) {
      return NextResponse.json({ error: 'Performance tracking disabled', enabled: false }, { status: 503 });
    }

    const leaderboard = getLeaderboard();

    return NextResponse.json({
      enabled: true,
      count: leaderboard.length,
      leaderboard,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
