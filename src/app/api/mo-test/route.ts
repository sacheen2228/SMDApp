import { NextResponse } from 'next/server';
import { testMOConnection, isMOConfigured } from '@/lib/motilal-oswal-api';
import { fetchYahooIndexData, fetchIndiaVIX } from '@/lib/yahoo-finance-api';

export async function GET() {
  try {
    const configured = isMOConfigured();
    
    // Test Yahoo Finance
    const [niftyData, vixData] = await Promise.all([
      fetchYahooIndexData('NIFTY'),
      fetchIndiaVIX(),
    ]);

    // Test MO API
    let moResult = null;
    if (configured) {
      moResult = await testMOConnection();
    }
    
    return NextResponse.json({
      motilalOswal: {
        configured,
        ...(moResult || { message: 'Not configured' }),
        credentials: {
          apiKey: !!process.env.MO_API_KEY,
          apiSecret: !!process.env.MO_API_SECRET,
          userId: !!process.env.MO_USER_ID,
          password: !!process.env.MO_PASSWORD,
          totpSecret: !!process.env.MO_TOTP_SECRET,
          staticIP: process.env.MO_STATIC_IP || 'not set',
          baseUrl: process.env.MO_BASE_URL || 'default',
        },
      },
      yahooFinance: {
        nifty: niftyData ? {
          price: niftyData.regularMarketPrice,
          change: niftyData.change,
          changePct: niftyData.changePct?.toFixed(2) + '%',
          name: niftyData.name,
        } : null,
        indiaVIX: vixData ? {
          value: vixData.value,
          change: vixData.change,
        } : null,
      },
      dataSource: moResult?.success ? 'motilal-oswal' : (niftyData ? 'yahoo-finance-spot' : 'simulation'),
    });
  } catch (error: any) {
    return NextResponse.json({
      error: error.message,
    }, { status: 500 });
  }
}
