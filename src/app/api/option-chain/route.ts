import { NextRequest, NextResponse } from 'next/server';
import { generateOptionChain } from '@/lib/option-chain-data';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || 'NIFTY';
    const expiry = searchParams.get('expiry') || undefined;

    const data = generateOptionChain(symbol, expiry);

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error generating option chain:', error);
    return NextResponse.json(
      { error: 'Failed to generate option chain data' },
      { status: 500 }
    );
  }
}
