import { NextRequest, NextResponse } from 'next/server';
import { generateOptionChain } from '@/lib/option-chain-data';
import { fetchLiveOptionChain, isMOConfigured } from '@/lib/motilal-oswal-api';
import { fetchYahooIndexData, fetchIndiaVIX } from '@/lib/yahoo-finance-api';
import { calculateGreeks } from '@/lib/greeks';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || 'NIFTY';
    const expiry = searchParams.get('expiry') || undefined;

    // ─── Strategy 1: Try MO API for full live option chain ───
    if (isMOConfigured()) {
      try {
        const liveResult = await fetchLiveOptionChain(symbol, expiry);

        if (liveResult.success && liveResult.data && liveResult.summary) {
          const spotPrice = liveResult.spotPrice || liveResult.summary.spotPrice;
          const selectedExpiry = expiry || liveResult.expiries?.[0]?.date || '';
          const expiryInfo = liveResult.expiries?.find(e => e.date === selectedExpiry);
          const daysToExpiry = expiryInfo?.daysToExpiry || 1;
          const timeToExpiry = Math.max(daysToExpiry / 365, 1 / 365);

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

          // Try to get real VIX from Yahoo
          const vixData = await fetchIndiaVIX();

          return NextResponse.json({
            symbol,
            spotPrice,
            expiries: liveResult.expiries || [],
            selectedExpiry,
            data: dataWithGreeks,
            summary: {
              ...liveResult.summary,
              indiaVIX: vixData?.value || liveResult.summary.indiaVIX,
              vixChange: vixData?.change || liveResult.summary.vixChange,
            },
            timestamp: new Date().toISOString(),
            isLive: true,
            dataSource: 'motilal-oswal',
          });
        }
      } catch (liveError) {
        console.error('[Option Chain] MO API failed, trying Yahoo fallback:', liveError);
      }
    }

    // ─── Strategy 2: Yahoo Finance for real spot prices + enhanced simulation ───
    try {
      const [indexData, vixData] = await Promise.all([
        fetchYahooIndexData(symbol),
        fetchIndiaVIX(),
      ]);

      if (indexData) {
        console.log(`[Option Chain] Using Yahoo Finance data for ${symbol}: ${indexData.regularMarketPrice}`);
        
        // Generate simulated option chain but with REAL spot price and VIX
        const simData = generateOptionChain(symbol, expiry, {
          spotPrice: indexData.regularMarketPrice,
          spotChange: indexData.change,
          spotChangePct: indexData.changePct,
          open: indexData.open,
          high: indexData.dayHigh,
          low: indexData.dayLow,
          prevClose: indexData.previousClose,
          indiaVIX: vixData?.value,
          vixChange: vixData?.change,
        });

        return NextResponse.json({
          ...simData,
          isLive: false,
          dataSource: 'yahoo-finance-spot',
          spotPriceReal: true,
          vixReal: !!vixData,
        });
      }
    } catch (yahooError) {
      console.error('[Option Chain] Yahoo Finance fallback also failed:', yahooError);
    }

    // ─── Strategy 3: Pure simulation fallback ───
    const data = generateOptionChain(symbol, expiry);

    return NextResponse.json({
      ...data,
      isLive: false,
      dataSource: 'simulation',
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

  let iv = 0.2;
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

    const vega = spot * Math.sqrt(timeToExpiry) * normalPDF(greeks.d1) / 100;
    if (vega < 0.0001) break;

    iv = iv - diff / (vega * 100);
    if (iv <= 0.01) iv = 0.01;
    if (iv > 5) iv = 5;
  }

  return Math.round(iv * 10000) / 100;
}

function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
