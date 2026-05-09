import { NextResponse } from 'next/server';
import { testMOConnection, isMOConfigured } from '@/lib/motilal-oswal-api';

export async function GET() {
  try {
    const configured = isMOConfigured();
    
    if (!configured) {
      return NextResponse.json({
        configured: false,
        message: 'Motilal Oswal API not configured',
        required: ['MO_API_KEY', 'MO_USER_ID', 'MO_PASSWORD', 'MO_TOTP_SECRET'],
        provided: {
          MO_API_KEY: !!process.env.MO_API_KEY,
          MO_USER_ID: !!process.env.MO_USER_ID,
          MO_PASSWORD: !!process.env.MO_PASSWORD,
          MO_TOTP_SECRET: !!process.env.MO_TOTP_SECRET,
          MO_BASE_URL: process.env.MO_BASE_URL || 'default',
        },
      });
    }

    const result = await testMOConnection();
    
    return NextResponse.json({
      configured: true,
      ...result,
    });
  } catch (error: any) {
    return NextResponse.json({
      configured: isMOConfigured(),
      success: false,
      message: error.message,
    }, { status: 500 });
  }
}
