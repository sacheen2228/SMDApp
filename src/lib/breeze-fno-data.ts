// Breeze F&O Data Bridge
// Converts real ICICI Breeze option chain + futures quotes into the
// OptionChainSnapshot / FuturesData shapes the F&O engine expects.
// When Breeze has no data (auth dead, stock symbols unsupported by the SDK)
// we fall back to NSE's public option-chain-v3 — NEVER fabricate OI/IV/Greeks.
// When both fail we return null and the engine falls back to no-trade.

import { getOptionChain, getOptionChainExpiries, getQuotes } from './icici-breeze/option-chain';
import { getBreezeClient, withAuthRetry } from './icici-breeze/auth';
import { getNSEOptionChain } from './nse-api';
import { normalizeExpiry } from './option-bhavcopy';
import { findAtmStrike, deriveIvStats } from './option-chain-normalizer';
import type { OptionChainSnapshot, OptionChainStrike, FuturesData, OptionMetrics, FuturesOIState } from './auction-types';

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
async function fetchBreezeSnapshot(
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

// ─── NSE fallback → OptionChainSnapshot ───────────────────────────
// Breeze's SDK fails on stock symbols ("SDK internal error") and the session
// expires often — NSE's public option-chain-v3 works for both indices and
// equities with no token. Same snapshot shape, real data only.

const toNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function nseLegToMetrics(leg: any): OptionMetrics {
  const bid = toNum(leg?.bidprice ?? leg?.bid);
  const ask = toNum(leg?.askPrice ?? leg?.ask);
  const g = leg?.greeks || {};
  const spread = Math.max(0, ask - bid);
  return {
    ltp: toNum(leg?.lastPrice),
    volume: toNum(leg?.totalTradedVolume),
    oi: toNum(leg?.openInterest),
    oiChange: toNum(leg?.changeinOpenInterest),
    iv: toNum(leg?.impliedVolatility),
    bid,
    ask,
    bidQty: 0,
    askQty: 0,
    delta: toNum(g.delta ?? leg?.delta),
    gamma: toNum(g.gamma ?? leg?.gamma),
    theta: toNum(g.theta ?? leg?.theta),
    vega: toNum(g.vega ?? leg?.vega),
    spread,
    spreadPct: ask ? (spread / ask) * 100 : 0,
  };
}

/**
 * Pure mapper: raw NSE option-chain-v3 response → OptionChainSnapshot.
 * Keeps only the nearest expiry (records.expiryDates[0]); rows dated to
 * another expiry are filtered by normalizeExpiry so stale strikes never
 * pollute the chain. Returns null when there is no usable data.
 */
export function nseChainToSnapshot(
  raw: any,
  spot: number,
  symbol: string
): OptionChainSnapshot | null {
  const records = raw?.records;
  const rows: any[] = records?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const expiryDates: string[] = Array.isArray(records?.expiryDates) ? records.expiryDates : [];
  const expiry = expiryDates[0] || '';
  const expiryKey = normalizeExpiry(expiry);

  const chainStrikes: OptionChainStrike[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    const strike = Number(row?.strikePrice);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    if (!row?.CE && !row?.PE) continue;
    const rowKey = normalizeExpiry(row?.CE?.expiryDate) ?? normalizeExpiry(row?.PE?.expiryDate);
    if (expiryKey && rowKey && rowKey !== expiryKey) continue;
    if (seen.has(strike)) continue;
    seen.add(strike);
    chainStrikes.push({ strike, expiry, ce: nseLegToMetrics(row.CE), pe: nseLegToMetrics(row.PE) });
  }
  if (chainStrikes.length === 0) return null;

  const spotForChain = spot || toNum(records?.underlyingValue);
  if (spotForChain <= 0) return null;

  const strikesList = chainStrikes.map(s => s.strike);
  const atmStrike = findAtmStrike(strikesList, spotForChain);
  const stats = deriveIvStats(chainStrikes, atmStrike);

  const callOiMap = new Map<number, number>();
  const putOiMap = new Map<number, number>();
  const callOiChangeMap = new Map<number, number>();
  const putOiChangeMap = new Map<number, number>();
  const callVolumeMap = new Map<number, number>();
  const putVolumeMap = new Map<number, number>();
  let callOITotal = 0;
  let putOITotal = 0;
  for (const s of chainStrikes) {
    callOiMap.set(s.strike, s.ce.oi);
    putOiMap.set(s.strike, s.pe.oi);
    callOiChangeMap.set(s.strike, s.ce.oiChange);
    putOiChangeMap.set(s.strike, s.pe.oiChange);
    callVolumeMap.set(s.strike, s.ce.volume);
    putVolumeMap.set(s.strike, s.pe.volume);
    callOITotal += s.ce.oi;
    putOITotal += s.pe.oi;
  }

  // Max Pain: strike where the total payout to option buyers is minimum
  let maxPain = atmStrike;
  let minPayout = Infinity;
  for (const price of strikesList) {
    let payout = 0;
    for (const s of chainStrikes) {
      if (price > s.strike) payout += (price - s.strike) * s.ce.oi;
      else if (price < s.strike) payout += (s.strike - price) * s.pe.oi;
    }
    if (payout < minPayout) {
      minPayout = payout;
      maxPain = price;
    }
  }

  // IV skew: avg OTM CE IV vs ATM IV (same approximation as the Breeze mapper)
  const ceIvs = chainStrikes.map(s => s.ce.iv).filter(v => v > 0);
  const avgCeIv = ceIvs.length ? ceIvs.reduce((a, b) => a + b, 0) / ceIvs.length : 0;
  const otmCeIvs = chainStrikes.filter(s => s.strike > atmStrike + 0.5).map(s => s.ce.iv).filter(v => v > 0);
  const avgOtmCeIv = otmCeIvs.length ? otmCeIvs.reduce((a, b) => a + b, 0) / otmCeIvs.length : avgCeIv;
  const ivSkew = stats.atmIV > 0 ? (avgOtmCeIv - stats.atmIV) / stats.atmIV : 0;

  return {
    symbol,
    spot: spotForChain,
    atmStrike,
    expiry,
    strikes: chainStrikes,
    callOiMap,
    putOiMap,
    callOiChangeMap,
    putOiChangeMap,
    callVolumeMap,
    putVolumeMap,
    maxPain,
    pcr: callOITotal > 0 ? putOITotal / callOITotal : 0,
    ivRank: stats.ivRank,
    ivPercentile: stats.ivRank,
    atmIV: stats.atmIV,
    ivSkew: Math.round(ivSkew * 10000) / 10000,
  };
}

// First non-null result wins; nulls decrement a pending counter. Used to race
// Breeze and NSE against each other without waiting for the slower provider.
function firstNonNull<T>(promises: Promise<T | null>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let pending = promises.length;
    if (pending === 0) return resolve(null);
    for (const p of promises) {
      p.then((v) => {
        if (v != null) resolve(v);
        else if (--pending === 0) resolve(null);
      }).catch(() => {
        if (--pending === 0) resolve(null);
      });
    }
  });
}

// Bound a provider attempt: slow = unavailable for this call. Without this a
// hanging Breeze SDK (session retry loop, 10-20s) starves the probe race even
// though NSE would answer in seconds.
function withTimeout<T>(
  p: Promise<T | null>,
  ms: number,
  onTimeout?: () => void
): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) { done = true; onTimeout?.(); resolve(null); }
    }, ms);
    p.then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } })
      .catch(() => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
  });
}

// Breeze and NSE IN PARALLEL — first real chain wins, each under its own cap
// (Breeze 6s / NSE 10s). Sequential Breeze-then-NSE was too slow: the Breeze
// SDK can burn 10-20s on session retries before NSE is even attempted, which
// blew the scanner's probe budget and made every probe fail (chains always
// null at night). On Breeze failure/timeout the cooldown skips it on later
// calls so the window stays NSE-only and fast.
export async function fetchOptionChainSnapshot(
  symbol: string,
  spot: number
): Promise<OptionChainSnapshot | null> {
  const useBreeze = Date.now() >= breezeOptionsCooldownUntil;
  const breezeP: Promise<OptionChainSnapshot | null> = useBreeze
    ? withTimeout(
        fetchBreezeSnapshot(symbol, spot).then((r) => {
          breezeOptionsCooldownUntil = r ? 0 : Date.now() + OPTION_CHAIN_COOLDOWN;
          return r;
        }),
        6_000,
        () => { breezeOptionsCooldownUntil = Date.now() + OPTION_CHAIN_COOLDOWN; }
      )
    : Promise.resolve(null);

  const nseP = withTimeout(
    (async (): Promise<OptionChainSnapshot | null> => {
      try {
        const raw = await getNSEOptionChain(symbol);
        const snap = nseChainToSnapshot(raw, spot, symbol);
        if (!snap) console.warn(`[F&O] NSE chain empty or unusable for ${symbol}`);
        return snap;
      } catch (err) {
        const msg = typeof err === 'string' ? err : (err as any)?.message || String(err);
        console.warn(`[F&O] NSE fallback chain failed for ${symbol}: ${msg.substring(0, 100)}`);
        return null;
      }
    })(),
    10_000
  );

  return firstNonNull([breezeP, nseP]);
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
  const cached = optionChainCache.get(symbol);
  if (cached && Date.now() - cached.ts < OPTION_CHAIN_TTL) return cached.data;

  const data = await fetchOptionChainSnapshot(symbol, spot);
  optionChainCache.set(symbol, { data, ts: Date.now() });
  return data;
}

export async function fetchAllOptionChains(
  symbols: string[],
  spotBySymbol: Map<string, number>
): Promise<Map<string, OptionChainSnapshot | null>> {
  const chains = new Map<string, OptionChainSnapshot | null>();
  if (symbols.length === 0) return chains;

  // Probe with a hard timeout — when Breeze auth is dead, the SDK's
  // generateSession() hangs indefinitely on the network call. The probe races
  // Breeze ∥ NSE (first success wins, per-provider caps 6s/10s), so 12s
  // bounds the worst healthy case; failing fast when both are down.
  const probe = await Promise.race([
    fetchStockOptionChain(symbols[0], spotBySymbol.get(symbols[0]) || 0),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
  ]);
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