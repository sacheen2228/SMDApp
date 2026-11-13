// API Route - Option Chain with SDM Analysis
// Fetch option chain data and run SDM analysis

import { NextRequest, NextResponse } from 'next/server';
import { getOptionChain, getOptionChainExpiries } from '@/lib/icici-breeze/option-chain';
import { runOptionChainRace } from '@/lib/market-data-race';
import { initSession } from '@/lib/icici-breeze/auth';
import { runFullAnalysis } from '@/lib/sdm-engine';
import { validateAndSanitize } from '@/lib/data-validation';
import { calculateGreeks, getGreeksAssumptions, parseExpiryDateLoose } from '@/lib/greeks';
import { normalizeOptionChain } from '@/lib/data-layer';
import {
  EXPIRY_UNAVAILABLE,
  expiryUnavailableReason,
  isExpiryExpired,
  isExpiryUnavailableReason,
  isSameExpiry,
  selectNearestLiveExpiry,
  toIsoDate,
  toNseExpiry,
} from '@/lib/data-layer/chains/option-chain';
import { getNSEOptionChain } from '@/lib/nse-api';
import { needsIvEnrichment, mergeNseIv } from '@/lib/option-iv-enrich';
import { isBSEIndex, getBSEOptionChain, getBSEExpiryDates } from '@/lib/bse-api';
import { sendTradeAlert } from '@/lib/telegram';
import { buildFreshnessMeta, withSessionAwareFreshness, providerTimestamp } from '@/lib/api-freshness';
import { getTradingSession } from '@/lib/expiry-liquidity/market-session-config';
import { providerHealth } from '@/lib/provider-health';
import { getCurrentSession } from '@/lib/market-session';
import { isPlausibleOptionSymbol } from '@/lib/stockUniverse';
import { setExchangeExpiries, classifyExpiryType } from '@/lib/expiry-calculator';
import type { OptionChainStrike } from '@/lib/sdm-engine';

// Init Breeze session on first request
let sessionInitialized = false;

function parseBreezeDate(dateStr: string): Date {
  if (!dateStr) return new Date();
  // Format: "28-Jul-2026"
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const month = months[parts[1]] ?? 0;
    const year = parseInt(parts[2], 10);
    return new Date(year, month, day);
  }
  return new Date(dateStr);
}

/**
 * A provider field the exchange did NOT send is UNKNOWN, not 0.
 *
 * `row.CE.lastPrice || 0` turned a missing quote into a real "₹0 premium"
 * and a missing open interest into "no open interest" — a claim the exchange
 * never made (and one every downstream consumer then trusted). The canonical
 * leg schema allows null, so null is what we carry.
 */
function numOrNull(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The same, for the legacy numeric shape the SDM engine consumes. */
function numOrZero(v: any): number {
  const n = numOrNull(v);
  return n === null ? 0 : n;
}

/**
 * THE CONTRACT THIS RESPONSE IS FOR.
 *
 * The exchange lists the JUST-EXPIRED contract first (live-verified 2026-10-20:
 * NSE listed "19-Oct-2026" — a dead contract — ahead of "27-Oct-2026"), so
 * `expiries[0]` is never a safe pick. The rules:
 *   • `?expiry=` is honoured when the chain carries that contract
 *   • otherwise the NEAREST expiry whose session has not ended wins
 *     (today's expiry is still live until 15:30 IST)
 *   • a requested expiry the chain does not carry is an EXPLICIT failure —
 *     never a silent substitution with another contract
 */
function resolveChainExpiry(input: {
  symbol: string;
  requestedRaw: string | undefined;
  requestedIso: string | null;
  providerExpiry: string | null;
  available: string[];
}): { expiry: string | null; error: string | null } {
  const { symbol, requestedRaw, requestedIso, providerExpiry, available } = input;

  if (requestedIso) {
    const match = available.find((e) => isSameExpiry(e, requestedIso));
    if (match) return { expiry: match, error: null };
    // The provider may have served the requested contract without listing it.
    if (providerExpiry && isSameExpiry(providerExpiry, requestedIso)) {
      return { expiry: providerExpiry, error: null };
    }
    return {
      expiry: null,
      error: expiryUnavailableReason(symbol, requestedRaw || requestedIso, available),
    };
  }

  // No request → the nearest contract that is still trading.
  const nearest = selectNearestLiveExpiry(available);
  if (nearest) return { expiry: nearest, error: null };
  if (providerExpiry && !isExpiryExpired(providerExpiry)) {
    return { expiry: providerExpiry, error: null };
  }
  // Nothing live in the list and nothing live from the provider.
  if (providerExpiry) {
    return {
      expiry: null,
      error:
        `${EXPIRY_UNAVAILABLE}: every contract for ${symbol} has expired ` +
        `(latest: ${providerExpiry}). No tradable contract is available.`,
    };
  }
  return { expiry: null, error: null };
}

export async function GET(request: NextRequest) {
  // Overall endpoint timeout: 24 seconds max
  // Provider budget: MO 6s + Breeze 7s + NSE 7s (cold-cookie) = 21s worst
  // case + ~2s post-processing, leaving margin under the endpoint cap.
  // Frontend aborts at 25s (page.tsx) — must stay ABOVE this.
  const controller = new AbortController();
  const ENDPOINT_TIMEOUT_MS = 24000;
  const timeoutId = setTimeout(() => controller.abort(), ENDPOINT_TIMEOUT_MS);

  const mainLogic = async () => {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || 'NIFTY';
    const rawExpiry = searchParams.get('expiry') || undefined;
    // Read-only probes (the SL/TP monitor) must never trigger the alert/addTrade side effects.
    const readOnly = searchParams.get('readonly') === '1';

    // The requested contract. Accepted forms: YYYY-MM-DD and DD-Mon-YYYY
    // (also "DD Mon YYYY"). The value is normalised to ISO for comparison and
    // handed to the providers in their own format.
    const requestedExpiryIso = rawExpiry ? toIsoDate(rawExpiry) : null;
    if (rawExpiry && !requestedExpiryIso) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid expiry "${rawExpiry.slice(0, 40)}". Use YYYY-MM-DD or DD-Mon-YYYY.`,
        },
        { status: 400 }
      );
    }
    // Set when a provider reports that the requested contract does not exist.
    let expiryError: string | null = null;
    // The contract the chain we ended up with is for (null until known).
    let effectiveExpiry: string | null = null;

    // Fast-reject synthetic/test IDs (epoch-digit runs) — never contact
    // NSE/Breeze with garbage (a single bad symbol used to walk all 7
    // Breeze expiries + NSE; 60+ wasted provider calls per test run).
    if (!isPlausibleOptionSymbol(symbol)) {
      return NextResponse.json(
        { success: false, error: `Invalid symbol: ${symbol.slice(0, 40)}` },
        { status: 400 }
      );
    }

    // Initialize session once (don't block on it)
    if (!sessionInitialized) {
      sessionInitialized = true;
      initSession().catch(() => {});
    }

    // Fetch live India VIX + previous close with timeout
    let liveVix: number | null = null;
    let livePrevClose: number | null = null;
    try {
      const { getNSEIndiaVIX } = await import('@/lib/nse-api');
      const vixRes = await Promise.race([
        getNSEIndiaVIX(),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('VIX_TIMEOUT')), 2000))
      ]);
      liveVix = vixRes?.value ?? null;
    } catch {}

    // Previous close with timeout
    try {
      const nseRes = await fetch('https://www.nseindia.com/api/marketStatus', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (nseRes.ok) {
        const nseData = await nseRes.json();
        const niftyIdx = nseData?.marketState?.find((i: any) => i.index === 'NIFTY 50');
        if (niftyIdx) {
          const variation = parseFloat(niftyIdx.variation) || 0;
          const last = parseFloat(niftyIdx.last) || 0;
          if (last > 0 && variation !== 0) livePrevClose = last - variation;
        }
      }
    } catch {}

    // Free NSE fallback for prev close (with timeout)
    if (!livePrevClose) {
      try {
        const { getNSEPrevClose } = await import('@/lib/nse-api');
        livePrevClose = await Promise.race([
          getNSEPrevClose(symbol),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error('PREVCLOSE_TIMEOUT')), 2000))
        ]);
      } catch {}
    }

    let chainData: any = null;
    let source = 'NO_DATA';
    let dataTimestamp: Date = new Date();
    // The provider's own publication timestamp, when it ships one. Null means
    // "we collected this, but cannot verify how current it is" — never LIVE.
    let providerTs: Date | null = null;
    // Provenance stamps for the chain (see the `chain` block in the response).
    let chainAsOf: string | null = null;
    let chainIsEod = false;
    let chainExpirySelection: string | null = null;
    
    // Option chain: parallel provider race (central engine)
    // First complete, valid, fresh chain wins. Tie-break Breeze → MOAPI → NSE → BSE.
    // Never merges providers; never labels stale/delayed as LIVE; off-hours skips
    // broker feeds (NSE/BSE only).
    const exchange = isBSEIndex(symbol) ? 'BSE' : 'NSE';
    const raceStart = Date.now();
    // Off-hours: broker feeds (Breeze / MOAPI) are not used for live option data —
    // only the exchange archives (NSE / BSE). Mirrors fetchOptionChainRace.
    // Each archive only carries its OWN contracts: racing NSE for SENSEX (or BSE
    // for NIFTY) is a guaranteed failure that just logs "No expiry dates found
    // for symbol: SENSEX" on every single poll.
    let raceProviders: any;
    try {
      const session = getCurrentSession();
      if (session && session.isMarketOpen === false) {
        raceProviders = exchange === 'BSE' ? ['bse-api'] : ['nse-api'];
      }
    } catch {}
    const race = await runOptionChainRace({
      symbol,
      exchange,
      expiry: requestedExpiryIso,
      nowMs: Date.now(),
      shadow: false,
      providers: raceProviders,
    });

    const winner = race.winner;
    const winnerProvider = race.winnerProvider;

    // Attempt-level failures already recorded with provider-health inside the
    // engine race; here we just convert the winner into the route's chainData
    // shape (one provider only — CE/PE legs never mixed across providers).
    if (winner) {
      const c = winner;
      providerTs = c.providerTimestamp ? new Date(c.providerTimestamp) : null;
      dataTimestamp = providerTs ?? new Date();
      effectiveExpiry = c.expiry || null;
      chainAsOf = c.providerTimestamp ?? c.fetchedAt;
      chainExpirySelection = rawExpiry ? 'requested' : 'nearest-live';

      chainData = {
        data: c.strikes.map((s: any) => ({
          strike: s.strike,
          ce: s.ce ? {
            ltp: numOrNull(s.ce.ltp),
            oi: numOrNull(s.ce.oi),
            oiChg: numOrNull(s.ce.oiChg),
            volume: numOrNull(s.ce.volume),
            iv: numOrNull(s.ce.iv),
            delta: numOrNull(s.ce.delta),
            gamma: numOrNull(s.ce.gamma),
            theta: numOrNull(s.ce.theta),
            vega: numOrNull(s.ce.vega),
            bid: numOrNull(s.ce.bid),
            ask: numOrNull(s.ce.ask),
          } : null,
          pe: s.pe ? {
            ltp: numOrNull(s.pe.ltp),
            oi: numOrNull(s.pe.oi),
            oiChg: numOrNull(s.pe.oiChg),
            volume: numOrNull(s.pe.volume),
            iv: numOrNull(s.pe.iv),
            delta: numOrNull(s.pe.delta),
            gamma: numOrNull(s.pe.gamma),
            theta: numOrNull(s.pe.theta),
            vega: numOrNull(s.pe.vega),
            bid: numOrNull(s.pe.bid),
            ask: numOrNull(s.pe.ask),
          } : null,
        })),
        spotPrice: c.spotPrice,
        expiries: c.expiry ? [{ date: c.expiry, label: c.expiry, daysToExpiry: 0 }] : [],
        selectedExpiry: c.expiry,
        expiry: c.expiry,
        summary: { spotPrice: c.spotPrice },
      };
      source =
        winnerProvider === 'bse-api'
          ? 'bse-api'
          : winnerProvider === 'nse-api'
            ? 'nse-api'
            : winnerProvider;
      console.log(
        `[API] Engine race winner ${winnerProvider} for ${symbol} (${c.strikes.length} strikes, ${Date.now() - raceStart}ms)`
      );
    }

    // If the race returned nothing, fall back to the data-layer canonical chain
    // (includes the bhavcopy EOD safety net + expiry protection).
    if (!chainData) {
      const { getOptionChain: canonicalChain } = await import("@/lib/data-layer/chains/option-chain");
      const canon = await canonicalChain(symbol, requestedExpiryIso ?? undefined);
      if (canon?.data) {
        const strikes = canon.data.strikes.map((s: any) => ({
          strike: Number(s.strike),
          ce: s.ce ? {
            ltp: numOrNull(s.ce.ltp),
            oi: numOrNull(s.ce.oi),
            oiChg: numOrNull(s.ce.oiChg),
            volume: numOrNull(s.ce.volume),
            iv: numOrNull(s.ce.iv),
            delta: numOrNull(s.ce.delta),
            gamma: numOrNull(s.ce.gamma),
            theta: numOrNull(s.ce.theta),
            vega: numOrNull(s.ce.vega),
            bid: numOrNull(s.ce.bid),
            ask: numOrNull(s.ce.ask),
          } : null,
          pe: s.pe ? {
            ltp: numOrNull(s.pe.ltp),
            oi: numOrNull(s.pe.oi),
            oiChg: numOrNull(s.pe.oiChg),
            volume: numOrNull(s.pe.volume),
            iv: numOrNull(s.pe.iv),
            delta: numOrNull(s.pe.delta),
            gamma: numOrNull(s.pe.gamma),
            theta: numOrNull(s.pe.theta),
            vega: numOrNull(s.pe.vega),
            bid: numOrNull(s.pe.bid),
            ask: numOrNull(s.pe.ask),
          } : null,
        }));
        chainData = {
          data: strikes,
          spotPrice: Number(canon.data.spot) || 0,
          expiries: [],
          selectedExpiry: canon.data.expiry,
          expiry: canon.data.expiry,
          summary: { spotPrice: Number(canon.data.spot) || 0 },
        };
        source =
          canon.data.source === 'BSE'
            ? 'bse-api'
            : canon.data.source === 'NSE'
              ? 'nse-api'
              : 'data-layer';
        providerTs = canon.data.providerTimestamp
          ? new Date(canon.data.providerTimestamp)
          : null;
        dataTimestamp = providerTs ?? new Date();
        effectiveExpiry = canon.data.expiry || null;
        chainAsOf = canon.data.asOf ?? canon.data.fetchedAt;
        chainIsEod = canon.data.isEod === true;
        chainExpirySelection = canon.data.expirySelection || null;
        if (canon.data.fallbackReason)
          console.warn(`[API] ${symbol} chain from fallback: ${canon.data.fallbackReason}`);
      } else if (isExpiryUnavailableReason(canon.fallbackReason)) {
        expiryError = canon.fallbackReason!;
        console.warn('[API]', expiryError);
      }
    }

    if (!chainData) {
      chainData = {};
      source = 'NO_DATA';
    }

    // ── EXPIRY RESOLUTION (in the route) ────────────────────────────
    // The exchange lists the just-expired contract FIRST, so the chain's own
    // list can name a dead contract. The contract this response is FOR is:
    //   • the requested one (when the chain carries it)
    //   • otherwise the NEAREST contract that is still trading
    //   • never an expired one, and never a silent substitution.
    const chainExpiryList: string[] = Array.isArray(chainData.expiries)
      ? chainData.expiries
          .map((e: any) => (typeof e === 'string' ? e : e?.date))
          .filter((e: any): e is string => typeof e === 'string' && e.trim().length > 0)
      : [];
    const resolved = resolveChainExpiry({
      symbol,
      requestedRaw: rawExpiry,
      requestedIso: requestedExpiryIso,
      providerExpiry: effectiveExpiry,
      available: chainExpiryList,
    });
    if (resolved.error && !expiryError) expiryError = resolved.error;
    if (resolved.expiry) {
      effectiveExpiry = resolved.expiry;
      chainData.expiry = resolved.expiry;
      chainData.selectedExpiry = resolved.expiry;
    }
    // Safety net: a provider that served a chain without an expiry label
    // (or an empty expiries list) still needs a contract for greeks — resolve
    // the nearest live expiry from the provider's own list. Never invent one.
    if (!effectiveExpiry && !requestedExpiryIso) {
      try {
        const exps = await getOptionChainExpiries(symbol);
        const nearest = selectNearestLiveExpiry(exps);
        if (nearest) {
          effectiveExpiry = nearest;
          chainData.expiry = nearest;
          chainData.selectedExpiry = nearest;
          if (!Array.isArray(chainData.expiries) || !chainData.expiries.length) {
            chainData.expiries = [{ date: nearest, label: nearest, daysToExpiry: 0 }];
          }
          console.log(`[API] Expiry safety-net: ${symbol} → ${nearest}`);
        }
      } catch { /* leave null — greeks stay uncomputed, never faked */ }
    }

    // The contract we were ASKED for must be the contract we GOT. A mismatch
    // is an honest failure — never a silent substitution.
    if (requestedExpiryIso) {
      if (effectiveExpiry && isSameExpiry(effectiveExpiry, requestedExpiryIso)) {
        expiryError = null; // the requested contract was served after all
      } else if (!expiryError) {
        expiryError =
          `${EXPIRY_UNAVAILABLE}: expiry "${rawExpiry}" is not available for ${symbol}` +
          (effectiveExpiry ? ` (the chain served ${effectiveExpiry})` : '');
      }
    }
    if (expiryError) {
      console.warn('[API]', expiryError);
      return NextResponse.json(
        {
          success: false,
          error: expiryError,
          symbol,
          requestedExpiry: rawExpiry ?? null,
          source,
        },
        { status: 400 }
      );
    }

    // No other provider is allowed into this path per the FINAL PROVIDER TREE.
    // If Breeze/Motilal/NSE/BSE all fail, return an empty chain with the spot
    // price from the VIX/prevClose context (or an explicit 503).

    if (!chainData || (!chainData.data?.length && !chainData.calls?.length && !chainData.puts?.length)) {
      const spotPrice = chainData?.spotPrice || chainData?.summary?.spotPrice || 0;
      if (spotPrice > 0) {
        // Return spot price with empty chain — frontend can show spot + "no data" message
        chainData = chainData || {};
        chainData.data = [];
        chainData.spotPrice = spotPrice;
        chainData.summary = chainData.summary || { spotPrice, indiaVIX: liveVix, prevClose: livePrevClose, vixLive: liveVix != null, prevCloseLive: livePrevClose != null };
        chainData.summary.spotPrice = spotPrice;
      } else {
        return NextResponse.json({
          success: false,
          error: `No option chain data available for ${symbol}. NSE, BSE, MOAPI and Breeze all failed or returned no contract.`,
        }, { status: 503 });
      }
    }
    
    // ── The chain in its HONEST shape ──────────────────────────────
    // A field the exchange did not send (or published as 0 for an IV that
    // does not exist) stays null — the canonical leg schema allows null and
    // "₹0 premium" / "0 open interest" are claims the exchange never made.
    let chainStrikes: any[] = [];

    if (chainData.data) {
      chainStrikes = chainData.data.map((row: any) => ({
        strike: row.strike,
        ce: row.ce ? { ...row.ce, iv: numOrNull(row.ce.iv) || null } : null,
        pe: row.pe ? { ...row.pe, iv: numOrNull(row.pe.iv) || null } : null,
      }));
    } else if (chainData.calls && chainData.puts) {
      // Breeze format: calls and puts arrays
      const callMap = new Map<number, any>();
      const putMap = new Map<number, any>();
      for (const c of chainData.calls) callMap.set(c.strikePrice, c);
      for (const p of chainData.puts) putMap.set(p.strikePrice, p);

      const allStrikes = [...new Set([...callMap.keys(), ...putMap.keys()])].sort((a, b) => a - b);
      const breezeLeg = (raw: any) => ({
        ltp: numOrNull(raw?.ltp),
        oi: numOrNull(raw?.openInterest),
        oiChg: numOrNull(raw?.oiChange),
        volume: numOrNull(raw?.volume),
        iv: numOrNull(raw?.iv) || null,
        delta: numOrNull(raw?.delta),
        gamma: numOrNull(raw?.gamma),
        theta: numOrNull(raw?.theta),
        vega: numOrNull(raw?.vega),
        bid: numOrNull(raw?.bid),
        ask: numOrNull(raw?.ask),
      });
      chainStrikes = allStrikes.map(strike => ({
        strike,
        ce: callMap.has(strike) ? breezeLeg(callMap.get(strike)) : null,
        pe: putMap.has(strike) ? breezeLeg(putMap.get(strike)) : null,
      }));
    }

    // ── IV enrich (same contract only) ───────────────────────────────
    // The race never merges legs (prices/OI stay single-provider), but IV
    // belongs to the contract. Breeze/MO ship no IV; NSE publishes
    // impliedVolatility (NSE indices), BSE DerivOptionChain_IV (BSE indices —
    // SENSEX/BANKEX are not on NSE). When the winner's near-the-money legs
    // lack IV, copy the exchange's own IV by strike so applyGreeks can compute
    // delta/gamma. Never an estimate — a leg still without IV stays null.
    if (chainStrikes.length && source !== 'nse-api' && source !== 'bse-api') {
      const spotForIv = chainData.spotPrice || chainData.summary?.spotPrice || 0;
      if (needsIvEnrichment(chainStrikes, spotForIv)) {
        try {
          const bseSym = isBSEIndex(symbol);
          let ivRows: any[] | null = null;
          let ivExp: string | null = null;
          const ivLabel = bseSym ? 'BSE' : 'NSE';

          if (bseSym) {
            // BSE's own expiry list — pick the winner's contract when it is
            // listed, else nearest live. Never invent a date.
            const bseExps = await getBSEExpiryDates(symbol).catch(() => [] as string[]);
            let exp =
              (effectiveExpiry && bseExps.find((e) => isSameExpiry(e, effectiveExpiry!))) ||
              selectNearestLiveExpiry(bseExps) ||
              bseExps[0] ||
              effectiveExpiry ||
              null;
            if (exp) {
              const bseChain = await Promise.race([
                getBSEOptionChain(symbol, exp),
                new Promise<null>((_, rej) => setTimeout(() => rej(new Error('IV enrich timeout')), 6000)),
              ]).catch(() => null);
              ivRows = (bseChain as any)?.data ?? null;
              ivExp = exp;
            }
          } else {
            const nseChain = await Promise.race([
              getNSEOptionChain(symbol, effectiveExpiry ?? undefined),
              new Promise<null>((_, rej) => setTimeout(() => rej(new Error('IV enrich timeout')), 6000)),
            ]).catch(() => null);
            ivRows = (nseChain as any)?.records?.data ?? null;
            ivExp = (nseChain as any)?.records?.selectedExpiry ?? null;
          }

          // Only the SAME contract — IVs are expiry-specific.
          const sameExpiry = !effectiveExpiry || !ivExp || isSameExpiry(ivExp, effectiveExpiry);
          if (sameExpiry && Array.isArray(ivRows) && ivRows.length) {
            const { strikes: merged, filled, nseIvCount } = mergeNseIv(chainStrikes, ivRows);
            if (filled > 0) {
              chainStrikes = merged;
              console.log(`[API] IV enrich from ${ivLabel} for ${symbol}: ${filled} legs filled (${ivLabel} had ${nseIvCount} IVs)`);
            }
          } else if (!sameExpiry) {
            console.warn(`[API] IV enrich skipped: ${ivLabel} contract ${ivExp} ≠ winner ${effectiveExpiry}`);
          }
        } catch (e: any) {
          console.warn(`[API] IV enrich failed for ${symbol}:`, e?.message || e);
        }
      }
    }

    // The legacy NUMERIC shape the SDM engine consumes. A missing field reads
    // as 0 INSIDE the analysis only — the payload keeps the nulls.
    const optionChainStrikes: OptionChainStrike[] = chainStrikes.map((row: any) => ({
      strike: row.strike,
      ce: row.ce ? {
        ltp: numOrZero(row.ce.ltp),
        oi: numOrZero(row.ce.oi),
        oiChg: numOrZero(row.ce.oiChg),
        volume: numOrZero(row.ce.volume),
        iv: numOrZero(row.ce.iv),
        delta: numOrZero(row.ce.delta),
        gamma: numOrZero(row.ce.gamma),
        theta: numOrZero(row.ce.theta),
        vega: numOrZero(row.ce.vega),
        bid: numOrZero(row.ce.bid),
        ask: numOrZero(row.ce.ask),
      } : null,
      pe: row.pe ? {
        ltp: numOrZero(row.pe.ltp),
        oi: numOrZero(row.pe.oi),
        oiChg: numOrZero(row.pe.oiChg),
        volume: numOrZero(row.pe.volume),
        iv: numOrZero(row.pe.iv),
        delta: numOrZero(row.pe.delta),
        gamma: numOrZero(row.pe.gamma),
        theta: numOrZero(row.pe.theta),
        vega: numOrZero(row.pe.vega),
        bid: numOrZero(row.pe.bid),
        ask: numOrZero(row.pe.ask),
      } : null,
    }));
    
    const spotPrice = chainData.spotPrice || chainData.summary?.spotPrice || 0;
    
    // Validate and sanitize the data
    if (optionChainStrikes.length > 0) {
      const validation = validateAndSanitize(optionChainStrikes, spotPrice, source);
      if (!validation.valid) {
        console.warn('[API] Data validation failed:', validation.errors);
        return NextResponse.json({
          success: false,
          error: "Option chain data validation failed. Real data may be incomplete.",
        }, { status: 503 });
      }
      if (validation.warnings.length > 0) {
        console.warn('[API] Data warnings:', validation.warnings);
      }
    }

    // Calculate Greeks if missing (the exchanges ship no greeks)
    // The contract the chain is FOR — resolved above (never a list entry that
    // happens to be first: the exchange lists the just-expired contract first).
    const selectedExpiry = effectiveExpiry || chainData.selectedExpiry || chainData.expiry || '';
    const now = new Date();
    // Breeze/NSE format ("03-Nov-2026") — never new Date() alone.
    // Unparseable/empty expiry → NO greeks (calculateGreeks would return
    // zeros for NaN tte, which reads as a real flat market).
    const parsedExpiry = selectedExpiry ? parseExpiryDateLoose(selectedExpiry, now) : null;
    const expiryDate = parsedExpiry ?? (selectedExpiry ? new Date(selectedExpiry) : null);
    const expiryOk = !!expiryDate && Number.isFinite(expiryDate.getTime());
    const daysToExpiry = expiryOk
      ? Math.max(1, Math.ceil((expiryDate!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
      : 0;
    const tte = expiryOk ? daysToExpiry / 365 : 0; // time to expiry in years

    for (const strike of optionChainStrikes) {
      // The greeks come from Black-Scholes on the EXCHANGE's own IV.
      // A leg the exchange published no IV for gets NO greeks — the old code
      // invented an IV from the moneyness (baseIV = 0.15 + moneyness×2) and
      // published it as if the exchange had sent it.
      const applyGreeks = (leg: any, isCall: boolean) => {
        if (!leg || !expiryOk || tte <= 0) return null;
        const ivPct = numOrNull(leg.iv);
        if (ivPct === null || ivPct <= 0) return null;
        const g = calculateGreeks(spotPrice, strike.strike, tte, ivPct / 100, isCall);
        leg.delta = g.delta;
        leg.gamma = g.gamma;
        leg.theta = g.theta;
        leg.vega = g.vega;
        return g;
      };
      const ceGreeks = applyGreeks(strike.ce, true);
      const peGreeks = applyGreeks(strike.pe, false);

      // Mirror the computed greeks onto the honest (nullable) chain.
      const honest = chainStrikes.find((r: any) => r.strike === strike.strike);
      if (honest) {
        if (honest.ce && ceGreeks) {
          honest.ce.delta = ceGreeks.delta;
          honest.ce.gamma = ceGreeks.gamma;
          honest.ce.theta = ceGreeks.theta;
          honest.ce.vega = ceGreeks.vega;
        }
        if (honest.pe && peGreeks) {
          honest.pe.delta = peGreeks.delta;
          honest.pe.gamma = peGreeks.gamma;
          honest.pe.theta = peGreeks.theta;
          honest.pe.vega = peGreeks.vega;
        }
      }
    }

    // Build summary for frontend compatibility
    if (!chainData.summary) {
      // Compute from strikes data
      const totalCallOI = optionChainStrikes.reduce((sum, s) => sum + (s.ce?.oi || 0), 0);
      const totalPutOI = optionChainStrikes.reduce((sum, s) => sum + (s.pe?.oi || 0), 0);
      // PCR: null when OI unavailable — NEVER default to 1 (creates fake neutral)
      const pcr = totalCallOI > 0 && totalPutOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : null;
      // Max Pain: strike where total payout to option holders is MINIMUM
      // (NOT maximum total OI — that was wrong)
      let maxPain: number | null = null;
      if (optionChainStrikes.length > 0 && (totalCallOI > 0 || totalPutOI > 0)) {
        const strikes = optionChainStrikes.map(s => s.strike).sort((a, b) => a - b);
        const minStrike = strikes[0];
        const maxStrike = strikes[strikes.length - 1];
        let bestStrike = minStrike;
        let minPayout = Infinity;
        for (let price = minStrike; price <= maxStrike; price++) {
          let totalPayout = 0;
          for (const s of optionChainStrikes) {
            if (price > s.strike) totalPayout += (price - s.strike) * (s.ce?.oi || 0);
            if (price < s.strike) totalPayout += (s.strike - price) * (s.pe?.oi || 0);
          }
          if (totalPayout < minPayout) { minPayout = totalPayout; bestStrike = price; }
        }
        maxPain = bestStrike;
      }

      chainData.summary = {
        spotPrice,
        spotChange: livePrevClose ? Math.round((spotPrice - livePrevClose) * 100) / 100 : 0,
        spotChangePct: livePrevClose ? Math.round(((spotPrice - livePrevClose) / livePrevClose) * 10000) / 100 : 0,
        indiaVIX: liveVix,
        prevClose: livePrevClose,
        vixLive: liveVix != null,
        prevCloseLive: livePrevClose != null,
        pcr,
        maxPain,
        totalCallOI,
        totalPutOI,
        atmStrike: chainData.atmStrike || 0,
        selectedExpiry,
      };
    }
    
    // Generate candles — Breeze 5-min intraday first (bounded), then the
    // exchange's own intraday index chart (free NSE). The SMC engine and the
    // PE falling-market confirmation need real structure data.
    // (Moved ABOVE the SDM alert gate so the PE falling-market technical
    // confirmation can use them — isFallingMarket needs candles + spot.)
    // Skip Breeze when its circuit is open (AUTH dead) — otherwise the
    // 3×4s attempts eat the remaining endpoint budget after a successful chain.
    let candles5m: any[] = [];
    if (providerHealth.shouldSkip("breeze")) {
      console.log('[API] Skipping Breeze candles — circuit open, falling back to the NSE index chart');
    }
    try {
      const { getIntradayCandles } = await import('@/lib/breeze-historical');
      const seen = new Set<string>();
      const seenDay = new Set<string>();
      const d = new Date();
      // Limit to 3 days max, with 4s timeout per call
      for (let attempt = 0; attempt < 3 && candles5m.length < 40 && !providerHealth.shouldSkip("breeze"); attempt++) {
        const dateStr = d.toISOString().split('T')[0];
        if (!seenDay.has(dateStr)) {
          seenDay.add(dateStr);
          try {
            const cr = await Promise.race([
              getIntradayCandles(symbol, dateStr, '5minute'),
              new Promise<{candles: any[]}>((_, reject) => setTimeout(() => reject(new Error('CANDLE_TIMEOUT')), 4000))
            ]);
            for (const c of cr.candles || []) {
              const key = c.time || `${c.open}-${c.close}-${c.volume}`;
              if (!seen.has(key)) { seen.add(key); candles5m.push(c); }
            }
          } catch (candleErr) {
            console.warn(`[API] Candle fetch for ${dateStr} failed:`, String(candleErr).substring(0, 80));
          }
        }
        d.setDate(d.getDate() - 1);
      }
      candles5m.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    } catch {
      candles5m = [];
    }

    // NO candle fallback beyond Breeze.
    //
    // The old fallback fetched Yahoo DAILY candles and pushed them into the
    // 5-minute array — a timeframe substitution: the SMC engine and the PE
    // falling-market confirmation then computed a "5-minute VWAP" from daily
    // bars. Yahoo is banned anyway, and the exchange's own index chart
    // (chart-databyindex) serves the CURRENT session only (and is empty
    // outside it), so it is not a substitute for an intraday series.
    //
    // With no real intraday candles the series is EMPTY and every consumer
    // that needs structure data (the PE confirmation) fails closed.

    // Run full SDM analysis
    const analysis = runFullAnalysis(optionChainStrikes, spotPrice, selectedExpiry, String(symbol || "NIFTY").toUpperCase());

    // Send Telegram alert if SDM analysis has a strong trade signal (real data only)
    // Throttled: only sends once per trade signature per day
    if (analysis?.recommendation && source !== "simulation") {
      const rec = analysis.recommendation;
      const isTradeAction = rec.action && !["HOLD", "NEUTRAL", "WAIT"].includes(rec.action);
      const isPut = !!(rec.action?.includes("PUT") || rec.optionType === "PE");
      // PE historically 0 wins on this book — demand a higher confidence floor.
      const confFloor = isPut ? 70 : 60;
      const conf = Number(rec.confidence || rec.sdmScore || 0);
      const hasConfidence = conf >= confFloor;
      // Quality gates — Final Validator rules (MIN_PREMIUM=5, no zero levels).
      // option-chain-api historically wrote ₹0.05 PE stubs that always lost.
      const entryPx = Number(rec.entryPrice || 0);
      const slPx = Number(rec.stopLoss || 0);
      const tp1Px = Number(rec.tp1 || 0);
      const entryOk = entryPx >= 5;
      // BUY options: SL must sit below entry for both CE and PE.
      const levelsOk = slPx > 0 && tp1Px > 0 && entryPx > slPx && tp1Px > entryPx;
      // Session gate — POST_CLOSE auto-entries historically won 0/17 (-4299).
      // market-session.ts allowedActions is the single source of truth.
      const { isTradeAllowed } = await import("@/lib/market-session");
      const sessGate = isTradeAllowed(isPut || rec.optionType === "PE" ? "PUT" : "CALL");
      // PE technical confirmation — price must be DEMONSTRABLY falling
      // (spot < VWAP + DOWN structure + sustained momentum, ≥2 of 3 layers).
      // OI flow alone is positioning, not price action. TDD: falling-market.test.ts
      const { isFallingMarket } = await import("@/lib/technical-analysis");
      const peFallingOk = !isPut || isFallingMarket(candles5m, spotPrice).falling;
      if (!readOnly && isTradeAction && hasConfidence && entryOk && levelsOk && sessGate.allowed && peFallingOk) {
        const { getMonitoredTrades, addTrade } = await import('@/lib/activeTradeTracker');
        // ONE position per underlying (matches the trade lock). Strike-based
        // dedup let ATM drift re-fire and — because addTrade used to run even
        // when sendTradeAlert was RISK-BLOCKED — pile phantom ACTIVE rows that
        // permanently tripped the open-deployment budget.
        const alreadyActive = getMonitoredTrades().some(t => t.symbol === symbol);
        if (!alreadyActive) {
          const sent = await sendTradeAlert({
            symbol,
            action: rec.action,
            strike: rec.strike || analysis.atmStrike || spotPrice,
            type: rec.optionType || rec.direction || "OPTION",
            confidence: rec.confidence || rec.sdmScore || 0,
            entry: rec.entryPrice,
            stopLoss: rec.stopLoss,
            target1: rec.tp1,
            target2: rec.tp2,
            source: `📊 SDM Analysis (${source})`,
            instrument: rec.optionType === 'PE' ? 'PUT' : 'CALL',
            expiry: selectedExpiry || undefined,
            spot: spotPrice || undefined,
          });
          // Only register a position the alert funnel actually accepted.
          // sendTradeAlert resolves false on VETO/RISK/dedup/window — never
          // treat a blocked candidate as an open trade.
          if (sent) {
            // Persist the REAL journal fields — confidence/risk/size/spot were
            // omitted before, so every Trade row from this path stored 0/0/0
            // and calibration + open-exposure estimates were blind.
            const { positionSize } = await import("@/lib/agent-brain-gate");
            const { getLotSizeStrict } = await import("@/lib/symbol-config");
            const lotSize = getLotSizeStrict(symbol) ?? 0;
            const ps = lotSize > 0 && entryPx > 0 && slPx > 0
              ? positionSize({ entry: entryPx, sl: slPx, lotSize })
              : null;
            const conf = rec.confidence || rec.sdmScore || 0;
            await addTrade({
              id: `api-${Date.now()}`,
              symbol,
              side: 'BUY' as const, // option-chain route is options-only
              instrument: `${symbol} ${rec.strike || ''} ${rec.optionType || ''}`.trim(),
              strike: rec.strike || analysis.atmStrike || spotPrice || 0,
              optionType: rec.optionType || '',
              entry: entryPx,
              sl: slPx,
              tp1: tp1Px,
              tp2: rec.tp2 || 0,
              status: 'ACTIVE',
              sentAt: new Date().toISOString(),
              source: `option-chain-api`,
              expiry: selectedExpiry || undefined,
              confidence: conf,
              spotPrice: spotPrice || undefined,
              positionSize: ps?.lots ?? 0,
              riskPerTrade: ps?.maxLoss ?? 0,
            }, true); // skipAlert=true — sendTradeAlert already sent above
          }
        }
      } else if (isTradeAction && hasConfidence) {
        console.log(`[option-chain] Signal skipped: entryOk=${entryOk} levelsOk=${levelsOk} session=${sessGate.allowed ? "ok" : sessGate.reason} conf=${rec.confidence || rec.sdmScore}`);
      }
    }

    // Transform expiry strings into objects the frontend expects
    const rawExpiries = chainData.expiries || [];
    const expiries = rawExpiries.map((e: any) => {
      const dateStr = typeof e === 'string' ? e : e?.date || '';
      const dateObj = parseBreezeDate(dateStr);
      const now = new Date();
      const diffMs = dateObj.getTime() - now.getTime();
      const daysToExpiry = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      // The exchange keeps the just-expired contract in the list — flag it so
      // a consumer never offers a dead contract as tradable.
      const expired = isExpiryExpired(dateStr, now);
      // W/M badge: 'weekly' | 'monthly' — without this the OI panel's
      // `e.type === "weekly"` check saw undefined and every badge read "M".
      const type = classifyExpiryType(symbol, dateStr) ?? undefined;
      return { date: dateStr, label: dateStr, daysToExpiry, expired, type };
    });


    // Attach live India VIX + previous close to the response summary (and the
    // SDM analysis) for every source path. We never fabricate these — when the
    // live feed was unavailable they stay null and the UI shows "—". Also copy
    // the real computed PCR / OI / ATM / maxPain so any component reading
    // data.summary directly (instead of analysis) sees complete live values.
    chainData.summary = chainData.summary || {};
    chainData.summary.indiaVIX = liveVix;
    chainData.summary.prevClose = livePrevClose;
    chainData.summary.vixLive = liveVix != null;
    chainData.summary.prevCloseLive = livePrevClose != null;
    chainData.summary.pcr = analysis?.pcr ?? chainData.summary.pcr ?? null;
    chainData.summary.maxPain = analysis?.maxPain ?? chainData.summary.maxPain ?? null;
    chainData.summary.totalCallOI = analysis?.totalCallOI ?? chainData.summary.totalCallOI ?? 0;
    chainData.summary.totalPutOI = analysis?.totalPutOI ?? chainData.summary.totalPutOI ?? 0;
    chainData.summary.atmStrike = analysis?.atmStrike ?? chainData.summary.atmStrike ?? 0;
    chainData.summary.spotPrice = spotPrice;

    // Compute aggregated OI changes from per-strike data (needed by GapAnalysis)
    if (optionChainStrikes.length > 0) {
      chainData.summary.callOiChange = optionChainStrikes.reduce((sum, s) => sum + (s.ce?.oiChg || 0), 0);
      chainData.summary.putOiChange = optionChainStrikes.reduce((sum, s) => sum + (s.pe?.oiChg || 0), 0);
    }
    // NIFTY futures proxy — free NSE index spot (the exchange is the source).
    // Bound with a short timeout so NSE slowness can never blow the endpoint
    // budget — futuresPrice is a nice-to-have, never blocks the response.
    try {
      const { getNSEIndices } = await import('@/lib/nse-api');
      const nseIdx = await Promise.race([
        getNSEIndices(),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('INDICES_TIMEOUT')), 3000)),
      ]);
      const nifty = nseIdx?.find((i: any) => String(i.key).toUpperCase() === 'NIFTY');
      if (nifty?.ltp) {
        chainData.summary.futuresPrice = nifty.ltp;
      }
    } catch {}

    if (analysis?.greeks && typeof analysis.greeks === 'object') {
      analysis.greeks.vix = liveVix != null ? liveVix : analysis.greeks.vix;
    }

    // Fix spot change (sdm-engine hardcodes 0, we have real prevClose)
    if (analysis?.spot && livePrevClose) {
      const spotChg = spotPrice - livePrevClose;
      analysis.spot.change = Math.round(spotChg * 100) / 100;
      analysis.spot.changePct = livePrevClose > 0 ? Math.round((spotChg / livePrevClose) * 10000) / 100 : 0;
    }
    
    // NSE and BSE are the DESIGNATED PRIMARY providers for their own
    // exchanges (NSE for NIFTY/BANKNIFiny/MIDCPNIFTY + equities, BSE for
    // SENSEX/BANKEX). Serving from them is NOT a fallback. Breeze/MO only
    // enter when explicitly opted in. Report a fallback only when something
    // other than the designated primary had to stand in.
    const isDesignatedPrimary =
      source === 'nse-api' || source === 'bse-api' ||
      source === 'icici-breeze' || source === 'motilal-api';
    // Prefer the exchange's own publication timestamp. BSE ships none, so an
    // absent timestamp means we can only prove we just collected the payload,
    // not that it is current — cap that at FRESH, never LIVE.
    // LIVE is only truthful while the exchange is open and printing. A fetch
    // on a weekend / holiday / pre-open / after-hours returns the last known
    // state — never let it claim LIVE.
    const freshness = withSessionAwareFreshness(
      buildFreshnessMeta({
        provider: source,
        dataTimestamp: providerTs ?? new Date(),
        dataType: "optionChain",
        fallbackUsed: !isDesignatedPrimary && source !== 'NO_DATA',
        fallbackReason: source === 'NO_DATA' ? "All providers unavailable" : undefined,
      }),
      getTradingSession(),
    );
    if (!providerTs && freshness.freshness === 'LIVE') {
      freshness.freshness = 'FRESH';
      freshness.delayed = false;
    }

    // Build canonical OptionChain from the HONEST strikes (the canonical leg
    // schema allows null — a field the exchange did not send stays null, it
    // is never flattened to 0 here).
    let canonical: any = null;
    try {
      const { buildOptionChain, assessChainQuality } = await import('@/lib/option-chain-normalizer');
      const canonicalLeg = (leg: any) => {
        if (!leg) return null;
        const bid = numOrNull(leg.bid);
        const ask = numOrNull(leg.ask);
        const ltp = numOrNull(leg.ltp);
        const oi = numOrNull(leg.oi);
        return {
          ltp,
          bid,
          ask,
          spread: bid != null && ask != null ? ask - bid : null,
          quoteQuality: (bid != null && ask != null) ? 'COMPLETE' as const : 'PARTIAL' as const,
          oi,
          oiChange: numOrNull(leg.oiChg),
          volume: numOrNull(leg.volume),
          iv: numOrNull(leg.iv),
          delta: numOrNull(leg.delta),
          gamma: numOrNull(leg.gamma),
          theta: numOrNull(leg.theta),
          vega: numOrNull(leg.vega),
          hasData: (ltp ?? 0) > 0 || (oi ?? 0) > 0,
        };
      };
      const normalizedStrikes = chainStrikes.map((s: any) => ({
        strike: s.strike,
        ce: canonicalLeg(s.ce),
        pe: canonicalLeg(s.pe),
      }));
      canonical = buildOptionChain(
        normalizedStrikes as any,
        spotPrice,
        symbol,
        source,
        chainData?.selectedExpiry,
        // The legs carry the PROVIDER's stamp (the same one the top level uses).
        // Without it a stale chain used to look REALTIME on every leg.
        {
          timestamp: dataTimestamp.toISOString(),
          freshness: freshness.freshness as any,
        },
      );
      if (canonical) {
        const quality = assessChainQuality(canonical);
        (canonical as any)._quality = quality;
      }
    } catch (e) {
      console.warn('[API] Canonical chain build failed:', e);
    }

    // Provenance of THIS chain: which contract, when it was priced, and
    // whether it is end-of-day data. Callers (scanner, agent, UI) read
    // `chain.source` / `chain.asOf` — they need the contract too.
    const chainStamp = {
      source,
      asOf: chainAsOf ?? dataTimestamp.toISOString(),
      expiry: selectedExpiry || null,
      expiryIso: toIsoDate(selectedExpiry) || null,
      expiryRequested: rawExpiry ?? null,
      expirySelection: chainExpirySelection || (rawExpiry ? 'requested' : 'nearest-live'),
      // true → the contract's session is over (only reachable when a caller
      // explicitly asked for an expired contract — the automatic selection
      // NEVER picks one).
      expiryExpired: selectedExpiry ? isExpiryExpired(selectedExpiry) : false,
      isEod: chainIsEod,
      freshness: freshness.freshness,
    };

    return NextResponse.json({
      success: true,
      source,
      lastUpdate: dataTimestamp.toISOString(),
      freshness,
      // The assumptions behind every Greek in this payload (the risk-free
      // rate is configurable — the reader must see WHICH rate was used).
      assumptions: getGreeksAssumptions(),
      provenance: {
        source,
        retrievedAt: dataTimestamp.toISOString(),
        freshness: freshness.freshness, // LIVE | FRESH | DELAYED | STALE | UNAVAILABLE
        isLive: freshness.freshness === 'LIVE',
        ageSeconds: Math.round(freshness.ageMs / 1000),
        status: optionChainStrikes.length > 0 ? 'AVAILABLE' : 'PARTIAL',
      },
      chain: chainStamp,
      data: {
        ...chainData,
        // The HONEST chain: a field the exchange did not send stays null.
        data: chainStrikes,
        strikes: chainStrikes,
        // The legacy numeric shape (0 for a missing field) — kept for the
        // consumers that need numbers; the payload above never fakes a 0.
        optionChainStrikes,
        expiries,
        dataSource: source,
        candles: candles5m,
        // The contract + as-of stamps, also inside `data` for consumers that
        // only read the data block.
        expiry: selectedExpiry || null,
        expiryIso: toIsoDate(selectedExpiry) || null,
        selectedExpiry: selectedExpiry || '',
        asOf: chainStamp.asOf,
        isEod: chainIsEod,
      },
      canonical,
      analysis,
    });
  };
  // Run mainLogic with overall endpoint timeout
  try {
    return await Promise.race([
      mainLogic(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('ENDPOINT_TIMEOUT')));
      }),
    ]);
  } catch (error: any) {
    clearTimeout(timeoutId);
    // Handle abort as graceful timeout
    if (error.name === 'AbortError' || error.message?.includes('Abort') || error.message?.includes('ENDPOINT_TIMEOUT')) {
      console.warn('[API] Option chain endpoint timeout (24s)');
      return NextResponse.json(
        { success: false, error: 'Option chain endpoint timeout' },
        { status: 504 }
      );
    }
    console.error('[API] Option chain error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to fetch option chain' },
      { status: 500 }
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
