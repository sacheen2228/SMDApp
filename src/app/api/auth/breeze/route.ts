// API Route - Breeze Auth Callback
// Handles OAuth redirect from ICICI Breeze

import { NextRequest, NextResponse } from 'next/server';
import { generateSession } from '@/lib/icici-breeze/auth';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const apiSession = searchParams.get('api_session');

    if (!apiSession) {
      return NextResponse.redirect(
        new URL('/?error=no_session', request.url)
      );
    }

    // Store session token via SDK
    await generateSession(apiSession);

    // Redirect to dashboard
    return NextResponse.redirect(
      new URL('/?success=connected', request.url)
    );
  } catch (error) {
    console.error('[Auth] Callback error:', error);
    return NextResponse.redirect(
      new URL('/?error=auth_failed', request.url)
    );
  }
}
