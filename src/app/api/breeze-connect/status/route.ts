// API Route - Breeze Login Status

import { NextResponse } from 'next/server';
import { validateSession } from '@/lib/icici-breeze/auth';

export async function GET() {
  try {
    const isConnected = await validateSession();

    return NextResponse.json({
      success: true,
      data: {
        status: isConnected ? 'success' : 'failed',
        isConnected,
      },
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message,
    });
  }
}
