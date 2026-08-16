// Breeze F&O Data Bridge
// Converts real ICICI Breeze option chain + futures quotes into the
// OptionChainSnapshot / FuturesData shapes the F&O engine expects.
// NEVER fabricates OI/IV/Greeks — when Breeze has no data we return null
// and let the engine fall back to a no-trade decision.

import { getOptionChain, getOptionChainExpiries, getQuotes } from './icici-breeze/option-chain';
import { getBreezeClient, withAuthRetry } from './icici-breeze/auth';
import type { OptionChainSnapshot, FuturesData, OptionMetrics, FuturesOIState } from './auction-types';

// BSE symbols that need BFO exchange code (BSE F&O segment)
const BSE_SYMBOLS = new Set(['SENSEX', 'BANKEX']);

const BFO_STOCK_CODE: Record<string, string> = {
  SENSEX: 'BSESEN',
  BANKEX: 'BANKEX',
};

function getExchangeCode(symbol: string): 'NFO' | 'BFO' {
  return BSE_SYMBOLS.has(symbol.toUpperCase()) ? 'BFO' : 'NFO';
}

function bfoStockCode(symbol: string): string {
  return BFO_STOCK_CODE[symbol.toUpperCase()] ?? symbol.toUpperCase();
}

function formatExpiryForSDK(dateStr: string): string {
  if (/^\d{2}-[A-Z][a-z]{2}-\d{4}$/.test(dateStr)) return dateStr;
  const date = new Date(dateStr);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = date.getUTCDate().toString().padStart(2, '0');
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

// ─── Option Chain → OptionChainSnapshot ───────────────────────────
export async function fetchOptionChainSnapshot(
  symbol: string,
  spot: number
): Promise<OptionChainSnapshot | null> {
  try {
    const expiries = await getOptionChainExpiries(symbol);
    if (!expiries || expiries.length === 0) return null;

    let chain: Awaited<ReturnType<typeof getOptionChain>> = null;
    let chosenExpiry = '';
    for (const exp of expiries) {
      const result = await getOptionChain(symbol, exp);
      if (result && result.calls.length + result.puts.length > 0) {
        chain = result;
        chosenExpiry = exp;
        break;
      }
    }

    if (!chain) return null;

    // Build per-strike CE/PE metrics
    const strikeSet = new Set<number>();
    const ceByStrike = new Map<number, any>();
    const peByStrike = new Map<number, any>();

    for (const c of chain.calls) {
      strikeSet.add(c.strikePrice);
      ceByStrike.set(c.strikePrice, c);
    }
    for (const p of chain.puts) {
      strikeSet.add(p.strikePrice);
      peByStrike.set(p.strikePrice, p);
    }

    const strikes = Array.from(strikeSet).sort((a, b) => a - b);
    if (strikes.length === 0) return null;

    const toMetrics = (q: any): OptionMetrics => ({
      ltp: q.ltp ?? 0,
      volume: q.volume ?? 0,
      oi: q.openInterest ?? 0,
      oiChange: q.oiChange ?? 0,
      iv: q.iv ?? 0,
      bid: q.bid ?? 0,
      ask: q.ask ?? 0,
      bidQty: q.bidQty ?? 0,
      askQty: q.askQty ?? 0,
      delta: q.delta ?? 0,
      gamma: q.gamma ?? 0,
      theta: q.theta ?? 0,
      vega: q.vega ?? 0,
      spread: Math.max(0, (q.ask ?? 0) - (q.bid ?? 0)),
      spreadPct: q.ask ? Math.max(0, ((q.ask ?? 0) - (q.bid ?? 0)) / q.ask) * 100 : 0,
    });

    const chainStrikes = strikes.map(strike => ({
      strike,
      expiry: chosenExpiry,
      ce: toMetrics(ceByStrike.get(strike)),
      pe: toMetrics(peByStrike.get(strike)),
    }));

    const callOiMap = new Map<number, number>();
    const putOiMap = new Map<number, number>();
    const callOiChangeMap = new Map<number, number>();
    const putOiChangeMap = new Map<number, number>();
    const callVolumeMap = new Map<number, number>();
    const putVolumeMap = new Map<number, number>();

    let callOITotal = 0;
    let putOITotal = 0;
    let callOiChangeTotal = 0;
    let putOiChangeTotal = 0;

    for (const s of chainStrikes) {
      callOiMap.set(s.strike, s.ce.oi);
      putOiMap.set(s.strike, s.pe.oi);
      callOiChangeMap.set(s.strike, s.ce.oiChange);
      putOiChangeMap.set(s.strike, s.pe.oiChange);
      callVolumeMap.set(s.strike, s.ce.volume);
      putVolumeMap.set(s.strike, s.pe.volume);
      callOITotal += s.ce.oi;
      putOITotal += s.pe.oi;
      callOiChangeTotal += s.ce.oiChange;
      putOiChangeTotal += s.pe.oiChange;
    }

    const spotForChain = spot || chain.spotPrice || 0;
    const atmStrike = strikes.reduce((prev, curr) =>
      Math.abs(curr - spotForChain) < Math.abs(prev - spotForChain) ? curr : prev
    );

    // Max Pain: strike with lowest total option value (call OI*abs(spot-strike) + put OI*abs(spot-strike))
    let maxPain = atmStrike;
    let maxPainValue = Infinity;
    for (const s of chainStrikes) {
      const totalValue =
        s.ce.oi * Math.max(0, spotForChain - s.strike) +
        s.pe.oi * Math.max(0, s.strike - spotForChain);
      if (totalValue < maxPainValue) {
        maxPainValue = totalValue;
        maxPain = s.strike;
      }
    }

    // IV rank/percentile from real ATM IV distribution
    const atmCe = ceByStrike.get(atmStrike);
    const atmPe = peByStrike.get(atmStrike);
    const atmIV = Math.max(atmCe?.iv ?? 0, atmPe?.iv ?? 0) || 0;

    const ivValues = chainStrikes
      .map(s => [s.ce.iv, s.pe.iv])
      .flat()
      .filter(v => v > 0);
    const ivPercentile = ivValues.length > 0
      ? Math.min(100, (ivValues.filter(v => v <= (atmIV || 0)).length / ivValues.length) * 100)
      : 0;
    const ivRank = ivPercentile; // percentile of current IV within today's distribution

    const avgCeIv = ivValues.length ? ivValues.reduce((a, b) => a + b, 0) / ivValues.length : 0;
    const otmCeIv = chainStrikes.filter(s => s.strike > atmStrike + 0.5).map(s => s.ce.iv).filter(v => v > 0);
    const avgOtmCeIv = otmCeIv.length ? otmCeIv.reduce((a, b) => a + b, 0) / otmCeIv.length : avgCeIv;
    const ivSkew = atmIV > 0 ? (avgOtmCeIv - atmIV) / atmIV : 0;

    return {
      symbol,
      spot: spotForChain,
      atmStrike,
      expiry: chosenExpiry,
      strikes: chainStrikes,
      callOiMap,
      putOiMap,
      callOiChangeMap,
      putOiChangeMap,
      callVolumeMap,
      putVolumeMap,
      maxPain,
      pcr: callOITotal > 0 ? putOITotal / callOITotal : 0,
      ivRank: Math.round(ivRank * 10) / 10,
      ivPercentile: Math.round(ivPercentile * 10) / 10,
      atmIV: Math.round(atmIV * 10) / 10,
      ivSkew: Math.round(ivSkew * 10000) / 10000,
    };
  } catch (err) {
    const msg = typeof err === 'string' ? err : (err as any)?.message || String(err);
    console.warn('[Breeze F&O] Option chain fetch failed for', symbol, ':', msg.substring(0, 100));
    return null;
  }
}

// Concurrent batch fetch of per-stock option chains with a module-level cache
// + failure cooldown. All NIFTY50 names are F&O-eligible, so a null probe
// means Breeze is unavailable for everything — we back off and skip the rest
// instead of hammering Breeze 50x in a single scan.
const optionChainCache = new Map<string, { data: OptionChainSnapshot | null; ts: number }>();
const OPTION_CHAIN_TTL = 5 * 60 * 1000;
const OPTION_CHAIN_COOLDOWN = 5 * 60 * 1000;
let breezeOptionsCooldownUntil = 0;

export async function fetchStockOptionChain(
  symbol: string,
  spot: number
): Promise<OptionChainSnapshot | null> {
  if (Date.now() < breezeOptionsCooldownUntil) return null;

  const cached = optionChainCache.get(symbol);
  if (cached && Date.now() - cached.ts < OPTION_CHAIN_TTL) return cached.data;

  const data = await fetchOptionChainSnapshot(symbol, spot);
  optionChainCache.set(symbol, { data, ts: Date.now() });
  if (!data) breezeOptionsCooldownUntil = Date.now() + OPTION_CHAIN_COOLDOWN;
  else breezeOptionsCooldownUntil = 0;
  return data;
}

export async function fetchAllOptionChains(
  symbols: string[],
  spotBySymbol: Map<string, number>
): Promise<Map<string, OptionChainSnapshot | null>> {
  const chains = new Map<string, OptionChainSnapshot | null>();
  if (symbols.length === 0) return chains;

  const probe = await fetchStockOptionChain(symbols[0], spotBySymbol.get(symbols[0]) || 0);
  chains.set(symbols[0], probe);
  if (!probe) {
    for (const sym of symbols.slice(1)) chains.set(sym, null);
    return chains;
  }

  const DEADLINE = Date.now() + 12_000;
  const CONCURRENCY = 5;
  for (let i = 1; i < symbols.length && Date.now() < DEADLINE; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(sym => fetchStockOptionChain(sym, spotBySymbol.get(sym) || 0))
    );
    results.forEach((r, j) => {
      chains.set(batch[j], r.status === "fulfilled" ? r.value : null);
    });
  }
  return chains;
}

// ─── Futures Quotes → FuturesData ─────────────────────────────────
export async function fetchFuturesData(symbol: string, spot: number): Promise<FuturesData | null> {
  try {
    const exchangeCode = getExchangeCode(symbol);
    const breezeStockCode = bfoStockCode(symbol);

    const result = await withAuthRetry(async (breeze) => {
      return breeze.getOptionChainQuotes({
        stockCode: breezeStockCode,
        exchangeCode: exchangeCode as any,
        productType: 'futures',
      });
    });

    const rows = result?.Success || [];
    if (!rows || rows.length === 0) return null;

    // Pick the nearest-dated future contract
    const now = Date.now();
    let best: any = null;
    let bestDist = Infinity;
    for (const row of rows) {
      if (!row?.expiry_date) continue;
      const d = new Date(row.expiry_date);
      if (isNaN(d.getTime())) continue;
      const dist = Math.abs(d.getTime() - now);
      if (dist < bestDist) {
        bestDist = dist;
        best = row;
      }
    }

    if (!best) return null;

    const futuresPrice = parseFloat(best?.ltp || best?.stock_price || '0') || spot;
    const prevClose = parseFloat(best?.previous_close || best?.prev_close || '0') || spot;
    const basis = futuresPrice - spot;
    const basisPct = spot > 0 ? (basis / spot) * 100 : 0;
    const priceChange = futuresPrice - prevClose;
    const priceChangePct = prevClose > 0 ? (priceChange / prevClose) * 100 : 0;
    const oi = parseInt(best?.open_interest || '0') || 0;
    const oiChange = parseInt(best?.chnge_oi || best?.change_oi || '0') || 0;
    const oiChangePct = oi > 0 ? (oiChange / oi) * 100 : 0;
    const volume = parseInt(best?.total_quantity_traded || '0') || 0;

    const oiState: FuturesOIState =
      priceChange > 0 && oiChange > 0 ? 'LONG_BUILDUP' :
      priceChange < 0 && oiChange > 0 ? 'SHORT_BUILDUP' :
      priceChange < 0 && oiChange < 0 ? 'LONG_UNWINDING' :
      priceChange > 0 && oiChange < 0 ? 'SHORT_COVERING' : 'NEUTRAL';

    return {
      symbol,
      spot,
      futures: futuresPrice,
      basis: Math.round(basis * 100) / 100,
      basisPct: Math.round(basisPct * 100) / 100,
      volume,
      oi,
      oiChange,
      oiChangePct: Math.round(oiChangePct * 100) / 100,
      priceChange: Math.round(priceChange * 100) / 100,
      priceChangePct: Math.round(priceChangePct * 100) / 100,
      oiState,
    };
  } catch (err) {
    const msg = typeof err === 'string' ? err : (err as any)?.message || String(err);
    console.warn('[Breeze F&O] Futures fetch failed for', symbol, ':', msg.substring(0, 100));
    return null;
  }
}