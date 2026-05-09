import { NextRequest, NextResponse } from 'next/server';
import { generateOptionChain } from '@/lib/option-chain-data';
import { fetchLiveOptionChain, isMOConfigured } from '@/lib/motilal-oswal-api';
import { calculateGreeks } from '@/lib/greeks';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || 'NIFTY';
    const expiry = searchParams.get('expiry') || undefined;

    // Try live data first if MO API is configured
    if (isMOConfigured()) {
      try {
        const liveResult = await fetchLiveOptionChain(symbol, expiry);

        if (liveResult.success && liveResult.data && liveResult.summary) {
          // Calculate Greeks for live data using Black-Scholes
          const spotPrice = liveResult.spotPrice || liveResult.summary.spotPrice;
          const selectedExpiry = expiry || liveResult.expiries?.[0]?.date || '';
          const expiryInfo = liveResult.expiries?.find(e => e.date === selectedExpiry);
          const daysToExpiry = expiryInfo?.daysToExpiry || 1;
          const timeToExpiry = Math.max(daysToExpiry / 365, 1 / 365);

          // Calculate Greeks for each strike
          const dataWithGreeks = liveResult.data.map(row => {
            const ceGreeks = row.ce && row.ce.iv > 0
              ? calculateGreeks(spotPrice, row.strike, timeToExpiry, row.ce.iv / 100, true)
              : null;
            const peGreeks = row.pe && row.pe.iv > 0
              ? calculateGreeks(spotPrice, row.strike, timeToExpiry, row.pe.iv / 100, false)
              : null;

            return {
              strike: row.strike,
              ce: row.ce ? {
                ...row.ce,
                iv: row.ce.iv || estimateIV(row.ce.ltp, spotPrice, row.strike, timeToExpiry, true),
                delta: ceGreeks?.delta ?? 0,
                theta: ceGreeks?.theta ?? 0,
                gamma: ceGreeks?.gamma ?? 0,
                vega: ceGreeks?.vega ?? 0,
              } : null,
              pe: row.pe ? {
                ...row.pe,
                iv: row.pe.iv || estimateIV(row.pe.ltp, spotPrice, row.strike, timeToExpiry, false),
                delta: peGreeks?.delta ?? 0,
                theta: peGreeks?.theta ?? 0,
                gamma: peGreeks?.gamma ?? 0,
                vega: peGreeks?.vega ?? 0,
              } : null,
            };
          });

          return NextResponse.json({
            symbol,
            spotPrice,
            expiries: liveResult.expiries || [],
            selectedExpiry,
            data: dataWithGreeks,
            summary: liveResult.summary,
            timestamp: new Date().toISOString(),
            isLive: true,
          });
        }
      } catch (liveError) {
        console.error('Live data fetch failed, falling back to simulated:', liveError);
      }
    }

    // Fallback to simulated data
    const data = generateOptionChain(symbol, expiry);

    return NextResponse.json({
      ...data,
      isLive: false,
    });
  } catch (error) {
    console.error('Error generating option chain:', error);
    return NextResponse.json(
      { error: 'Failed to generate option chain data' },
      { status: 500 }
    );
  }
}

// Estimate IV from option price using Newton-Raphson method
function estimateIV(
  optionPrice: number,
  spot: number,
  strike: number,
  timeToExpiry: number,
  isCall: boolean
): number {
  if (optionPrice <= 0 || timeToExpiry <= 0) return 15;

  let iv = 0.2; // Start with 20% guess
  const r = 0.07;
  const maxIterations = 20;
  const precision = 0.0001;

  for (let i = 0; i < maxIterations; i++) {
    const greeks = calculateGreeks(spot, strike, timeToExpiry, iv, isCall);
    const modelPrice = isCall
      ? spot * normalCDF(greeks.d1) - strike * Math.exp(-r * timeToExpiry) * normalCDF(greeks.d2)
      : strike * Math.exp(-r * timeToExpiry) * normalCDF(-greeks.d2) - spot * normalCDF(-greeks.d1);

    const diff = modelPrice - optionPrice;

    if (Math.abs(diff) < precision) break;

    // Vega for adjustment
    const vega = spot * Math.sqrt(timeToExpiry) * normalPDF(greeks.d1) / 100;

    if (vega < 0.0001) break;

    iv = iv - diff / (vega * 100);

    if (iv <= 0.01) iv = 0.01;
    if (iv > 5) iv = 5;
  }

  return Math.round(iv * 10000) / 100; // Return as percentage
}

function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
