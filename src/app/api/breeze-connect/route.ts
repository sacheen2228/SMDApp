// API Route - Breeze Connect using official SDK

import { NextRequest, NextResponse } from 'next/server';
import { generateSession, validateSession, getConfig } from '@/lib/icici-breeze/auth';

// ─── GET: Check connection status ─────────────────────────────────
export async function GET() {
  try {
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
      error: error.message,
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

    await generateSession(apiSession);

    return NextResponse.json({
      success: true,
      data: { message: 'Session generated successfully' },
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message,
    });
  }
}
