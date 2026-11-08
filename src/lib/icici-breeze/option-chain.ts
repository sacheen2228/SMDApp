// ICICI Breeze API - Option Chain using official SDK
// Note: SDK's getOptionChainQuotes has broken validation — patched in auth.ts

import { getBreezeClient, getConfig, withAuthRetry } from './auth';
import type { OptionChainData, OptionQuote } from '@/types';
import { calculateGreeks, parseExpiryDateLoose } from '@/lib/greeks';
import { reportSessionFailure, classifySourceError } from '@/lib/session-health';
import { mergeExpiryCandidates } from '@/lib/expiry-calculator';
import { toContracts } from '@/lib/oi-units';

// BSE symbols that need BFO exchange code (BSE F&O segment)
const BSE_SYMBOLS = new Set(['SENSEX', 'BANKEX']);

// BFO stock codes differ from display names in some cases.
// Security master ShortName (field #3) is what Breeze expects as stock_code.
const BFO_STOCK_CODE: Record<string, string> = {
  SENSEX: 'BSESEN',
  BANKEX: 'BANKEX',
};

function getExchangeCode(symbol: string): string {
  return BSE_SYMBOLS.has(symbol.toUpperCase()) ? 'BFO' : 'NFO';
}

function bfoStockCode(symbol: string): string {
  return BFO_STOCK_CODE[symbol.toUpperCase()] ?? symbol.toUpperCase();
}

function isBSE(symbol: string): boolean {
  return BSE_SYMBOLS.has(symbol.toUpperCase());
}

// ─── Get Option Chain (calls + puts merged) ──────────────────────
export async function getOptionChain(
  stockCode: string,
  expiryDate: string
): Promise<OptionChainData | null> {
  try {
    // Callers pass "" meaning "current/nearest expiry" (tiger-monitor,
    // backtest-audit). Resolve it to a real listed expiry BEFORE the SDK
    // call — formatExpiryForSDK("") used to produce the garbage
    // "NaN-undefined-NaN" expiry string and wasted a full API round-trip.
    let expiry = expiryDate;
    if (!expiry) {
      const exps = await getOptionChainExpiries(stockCode);
      expiry = exps[0] || "";
    }
    const expiryFormatted = formatExpiryForSDK(expiry);
    if (!expiryFormatted) {
      console.warn(
        "[Breeze SDK] Invalid expiry for",
        stockCode,
        JSON.stringify(expiryDate),
        "— skipping SDK call"
      );
      return null;
    }

    return await withAuthRetry(async (breeze) => {
      const exchangeCode = getExchangeCode(stockCode);

      const breezeStockCode = bfoStockCode(stockCode);
      console.log('[Breeze SDK] Fetching option chain:', breezeStockCode, expiryFormatted, exchangeCode);

      // Fetch calls and puts separately (API requires right param)
      const [callsResult, putsResult] = await Promise.all([
        breeze.getOptionChainQuotes({
          stockCode: breezeStockCode,
          exchangeCode: exchangeCode as any,
          productType: 'options',
          expiryDate: expiryFormatted,
          right: 'call',
        }),
        breeze.getOptionChainQuotes({
          stockCode: breezeStockCode,
          exchangeCode: exchangeCode as any,
          productType: 'options',
          expiryDate: expiryFormatted,
          right: 'put',
        }),
      ]);

      const callOptions = callsResult?.Success || [];
      const putOptions = putsResult?.Success || [];

      console.log('[Breeze SDK] Option chain: calls=%d, puts=%d', callOptions.length, putOptions.length);

      if (callsResult?.Status === 500 || putsResult?.Status === 500) {
        console.warn('[Breeze SDK] BFO/NFO error:', callsResult?.Error || putsResult?.Error || 'unknown');
        return null;
      }

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
          // Breeze reports volume/OI/OI-change in UNDERLYING UNITS
          // (contracts × lot) — the canonical chain unit is CONTRACTS.
          volume: toContracts(parseInt(opt.total_quantity_traded || '0'), stockCode),
          openInterest: toContracts(parseInt(opt.open_interest || '0'), stockCode),
          oiChange: toContracts(parseInt(opt.chnge_oi || '0'), stockCode),
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
    });
  } catch (err: any) {
    // SDK throws broken error strings like "getOptionChainQuotes() Errorundefined"
    // Extract the meaningful part
    const raw = typeof err === 'string' ? err : String(err?.message || err || '');
    const meaningful = raw.includes('Errorundefined') ? 'SDK internal error (likely Unauthorized User or timeout)' : raw.substring(0, 120);
    console.warn('[Breeze SDK] getOptionChain failed for', stockCode, expiryDate, ':', meaningful);
    reportSessionFailure("breeze", classifySourceError("breeze", meaningful), meaningful);
    return null;
  }
}

// ─── Get Option Chain Expiries ────────────────────────────────────
// Expiry lists change only weekly (Thursday rollover) — cache per symbol so
// the chain path skips the ~2-3s futures-quotes probe on every request.
const expiriesCache = new Map<string, { list: string[]; ts: number }>();
const EXPIRIES_TTL_MS = 6 * 3600 * 1000;

export async function getOptionChainExpiries(stockCode: string): Promise<string[]> {
  const cacheKey = stockCode.toUpperCase();
  const hit = expiriesCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < EXPIRIES_TTL_MS) return hit.list;

  try {
    const breeze = getBreezeClient();
    const exchangeCode = getExchangeCode(stockCode);

    const breezeStockCode = bfoStockCode(stockCode);
    console.log('[Breeze SDK] Fetching expiries for:', breezeStockCode, exchangeCode);

    // Fetch monthly expiries from futures
    const futuresResult = await breeze.getOptionChainQuotes({
      stockCode: breezeStockCode,
      exchangeCode: exchangeCode as any,
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

    // The calendar side comes from the expiry-calculator (exchange-aware,
    // holiday-shift aware) merged with the real futures contract dates above.
    // NEVER ladder dates inline: the old rule ("every Tuesday, 35 days out")
    // invented holiday expiries — Tue 10-Nov-2026 is a trading holiday, that
    // week settles Mon 09-Nov-2026 — and the gate rejected the invented date
    // with EXPIRY_UNAVAILABLE while the UI auto-selected expiries[0] from it,
    // looping the option-chain tab on 400s.
    const expiryList = mergeExpiryCandidates(stockCode, Array.from(expiries));

    console.log('[Breeze SDK] Found %d expiries (futures + calendar)', expiryList.length);

    // Cache only real results — never cache the error/empty fallback
    if (expiryList.length > 0) {
      expiriesCache.set(cacheKey, { list: expiryList, ts: Date.now() });
    }
    return expiryList;
  } catch (error) {
    const msg = typeof error === 'string' ? error : error?.message || String(error);
    console.warn('[Breeze SDK] Expiry fetch error:', msg.substring(0, 100));
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
  // Empty / unparseable input must return "" (callers skip the SDK call)
  // instead of "NaN-undefined-NaN"
  if (!dateStr || !dateStr.trim()) return "";
  // If already in DD-MMM-YYYY format, return as-is
  if (/^\d{2}-[A-Z][a-z]{2}-\d{4}$/.test(dateStr)) {
    return dateStr;
  }
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "";
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = date.getUTCDate().toString().padStart(2, '0');
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

// ─── Calculate Time to Expiry ─────────────────────────────────────
function calculateTimeToExpiry(expiryDate: string): number {
  // Breeze/DD-MMM-YYYY/ISO — never new Date() alone
  const expiry = parseExpiryDateLoose(expiryDate) ?? new Date(expiryDate);
  const now = new Date();
  // parseExpiryDateLoose already lands at 15:30 IST; native fallback needs the set.
  if (!(parseExpiryDateLoose(expiryDate))) expiry.setHours(15, 30, 0, 0);
  const diffMs = expiry.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return Math.max(diffDays / 365, 1 / 365);
}
