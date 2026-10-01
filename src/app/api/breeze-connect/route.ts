// API Route - Breeze Connect using official SDK
//
// Token activation delegates to session-health applyBreezeSession — the
// single owner of: generateSession + circuit-breaker reset + expiry-episode
// re-arm. (Direct generateSession here previously skipped the re-arm.)

import { NextRequest, NextResponse } from 'next/server';
import { validateSession, getConfig } from '@/lib/icici-breeze/auth';

// ─── GET: Check connection status (or activate via ?apisession=) ──
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const apiSessionParam = searchParams.get('apisession');

    // If ?apisession= is provided, activate session immediately
    if (apiSessionParam) {
      const { applyBreezeSession } = await import('@/lib/session-health');
      const res = await applyBreezeSession(apiSessionParam);
      if (!res.success) {
        return NextResponse.json({ success: false, error: res.error || 'session activation failed' });
      }
      return NextResponse.json({
        success: true,
        data: { isConnected: true, message: 'Session activated' },
      });
    }

    const isConnected = await validateSession();
    const config = getConfig();

    return NextResponse.json({
      success: true,
      data: {
        isConnected,
        hasCredentials: !!(config.appKey && config.secretKey),
        hasUsername: !!process.env.BREEZE_USERNAME,
        loginUrl: `https://api.icicidirect.com/apiuser/login?api_key=${encodeURIComponent(config.appKey)}`,
      },
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: String(error?.message || error || 'request failed'),
    });
  }
}

// ─── POST: Generate session with provided api_session ─────────────
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const apiSession = body.apiSession || process.env.BREEZE_SESSION_TOKEN;

    if (!apiSession) {
      return NextResponse.json({
        success: false,
        error: 'No API session provided. Please provide apiSession in request body or set BREEZE_SESSION_TOKEN in .env',
      });
    }

    const { applyBreezeSession } = await import('@/lib/session-health');
    const res = await applyBreezeSession(apiSession);
    if (!res.success) {
      return NextResponse.json({ success: false, error: res.error || 'session generation failed' });
    }

    return NextResponse.json({
      success: true,
      data: { message: 'Session generated successfully', status: res.status },
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: String(error?.message || error || 'request failed'),
    });
  }
}
