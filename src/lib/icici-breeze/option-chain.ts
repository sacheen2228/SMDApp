// ICICI Breeze API - Option Chain using official SDK
// Note: SDK's getOptionChainQuotes has broken validation — patched in auth.ts

import { getBreezeClient, getConfig } from './auth';
import type { OptionChainData, OptionQuote } from '@/types';
import { calculateGreeks } from '@/lib/greeks';

// ─── Get Option Chain (calls + puts merged) ──────────────────────
export async function getOptionChain(
  stockCode: string,
  expiryDate: string
): Promise<OptionChainData | null> {
  try {
    const breeze = getBreezeClient();
    const expiryFormatted = formatExpiryForSDK(expiryDate);

    console.log('[Breeze SDK] Fetching option chain:', stockCode, expiryFormatted);

    // Fetch calls and puts separately (API requires right param)
    const [callsResult, putsResult] = await Promise.all([
      breeze.getOptionChainQuotes({
        stockCode,
        exchangeCode: 'NFO',
        productType: 'options',
        expiryDate: expiryFormatted,
        right: 'call',
      }),
      breeze.getOptionChainQuotes({
        stockCode,
        exchangeCode: 'NFO',
        productType: 'options',
        expiryDate: expiryFormatted,
        right: 'put',
      }),
    ]);

    const callOptions = callsResult?.Success || [];
    const putOptions = putsResult?.Success || [];

    console.log('[Breeze SDK] Option chain: calls=%d, puts=%d', callOptions.length, putOptions.length);

    if (callOptions.length === 0 && putOptions.length === 0) {
      return null;
    }

    // Get spot price — try multiple field names
    const sample = callOptions[0] || putOptions[0];
    const spotPrice = parseFloat(
      sample?.spot_price || sample?.spotPrice || sample?.stock_price || '0'
    );

    // Group by strike price
    const strikeMap = new Map<number, { calls: OptionQuote[]; puts: OptionQuote[] }>();

    const processOption = (opt: any, isCall: boolean) => {
      const strike = parseFloat(opt.strike_price || '0');
      if (!strikeMap.has(strike)) {
        strikeMap.set(strike, { calls: [], puts: [] });
      }

      const quote: OptionQuote = {
        symbol: opt.stock_code || stockCode,
        strikePrice: strike,
        expiryDate: opt.expiry_date || expiryDate,
        optionType: isCall ? 'call' : 'put',
        ltp: parseFloat(opt.ltp || '0'),
        bid: parseFloat(opt.best_bid_price || '0'),
        ask: parseFloat(opt.best_offer_price || '0'),
        volume: parseInt(opt.total_quantity_traded || '0'),
        openInterest: parseInt(opt.open_interest || '0'),
        oiChange: parseInt(opt.chnge_oi || '0'),
        iv: parseFloat(opt.implied_volatility || '0'),
        delta: 0,
        gamma: 0,
        theta: 0,
        vega: 0,
      };

      if (quote.iv > 0 && spotPrice > 0) {
        const timeToExpiry = calculateTimeToExpiry(expiryDate);
        const greeks = calculateGreeks(spotPrice, strike, timeToExpiry, quote.iv / 100, isCall);
        quote.delta = greeks.delta;
        quote.gamma = greeks.gamma;
        quote.theta = greeks.theta;
        quote.vega = greeks.vega;
      }

      strikeMap.get(strike)![isCall ? 'calls' : 'puts'].push(quote);
    };

    callOptions.forEach((opt: any) => processOption(opt, true));
    putOptions.forEach((opt: any) => processOption(opt, false));

    // Sort strikes
    const strikes = Array.from(strikeMap.keys()).sort((a, b) => a - b);

    // Find ATM strike
    const atmStrike = strikes.reduce((prev, curr) =>
      Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
    );

    // Flatten calls and puts
    const calls: OptionQuote[] = [];
    const puts: OptionQuote[] = [];
    for (const strike of strikes) {
      const data = strikeMap.get(strike)!;
      calls.push(...data.calls);
      puts.push(...data.puts);
    }

    return {
      symbol: stockCode,
      expiryDate,
      spotPrice,
      strikes,
      calls,
      puts,
      atmStrike,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[Breeze SDK] Option chain error:', error);
    return null;
  }
}

// ─── Get Option Chain Expiries ────────────────────────────────────
export async function getOptionChainExpiries(stockCode: string): Promise<string[]> {
  try {
    const breeze = getBreezeClient();

    console.log('[Breeze SDK] Fetching expiries for:', stockCode);

    // Fetch monthly expiries from futures
    const futuresResult = await breeze.getOptionChainQuotes({
      stockCode,
      exchangeCode: 'NFO',
      productType: 'futures',
    }).catch(() => null);

    const expiries = new Set<string>();

    if (futuresResult?.Success) {
      for (const opt of futuresResult.Success) {
        if (opt.expiry_date) {
          expiries.add(opt.expiry_date);
        }
      }
    }

    // Add weekly expiry dates (NIFTY weekly options expire on Tuesdays)
    const now = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (let i = 0; i < 10; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      while (d.getDay() !== 2) d.setDate(d.getDate() + 1); // Tuesday = 2
      const dd = d.getDate().toString().padStart(2, '0');
      expiries.add(`${dd}-${months[d.getMonth()]}-${d.getFullYear()}`);
    }

    console.log('[Breeze SDK] Found %d expiries (futures + weekly probe)', expiries.size);

    // Sort chronologically (nearest expiry first)
    const expiryList = Array.from(expiries).sort((a, b) => {
      return new Date(a).getTime() - new Date(b).getTime();
    });

    return expiryList;
  } catch (error) {
    console.error('[Breeze SDK] Expiry fetch error:', error);
    return [];
  }
}

// ─── Get Quotes ───────────────────────────────────────────────────
export async function getQuotes(stockCode: string, exchangeCode: 'NSE' | 'NFO' = 'NSE'): Promise<any> {
  const breeze = getBreezeClient();
  return breeze.getQuotes({
    stockCode,
    exchangeCode,
  });
}

// ─── Format Expiry Date for SDK ───────────────────────────────────
// SDK expects DD-MMM-YYYY format (e.g., "09-Jul-2026")
function formatExpiryForSDK(dateStr: string): string {
  // If already in DD-MMM-YYYY format, return as-is
  if (/^\d{2}-[A-Z][a-z]{2}-\d{4}$/.test(dateStr)) {
    return dateStr;
  }
  const date = new Date(dateStr);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = date.getUTCDate().toString().padStart(2, '0');
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

// ─── Calculate Time to Expiry ─────────────────────────────────────
function calculateTimeToExpiry(expiryDate: string): number {
  const expiry = new Date(expiryDate);
  const now = new Date();
  expiry.setHours(15, 30, 0, 0);
  const diffMs = expiry.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return Math.max(diffDays / 365, 1 / 365);
}
