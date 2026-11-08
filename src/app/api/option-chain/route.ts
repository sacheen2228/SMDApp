// API Route - Option Chain with SDM Analysis
// Fetch option chain data and run SDM analysis

import { NextRequest, NextResponse } from 'next/server';
import { getOptionChain, getOptionChainExpiries } from '@/lib/icici-breeze/option-chain';
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
import { isBSEIndex } from '@/lib/bse-api';
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
    
    // FINAL PROVIDER TREE (see SOP.md §1) — exchange-aware:
    //   1. NSE primary  — NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY + NSE equities
    //   2. BSE primary  — SENSEX/BANKEX (NSE has no contract for these)
    //   3. MOAPI fallback
    //   4. Breeze opt-in last resort
    //   Yahoo must NEVER enter this path.
    // If all valid sources fail: OPTION_CHAIN=UNAVAILABLE → NO_TRADE
    
    // Off-hours fast path: MO/Breeze can only serve live sessions (MO times
    // out, Breeze needs auth) — the exchange itself carries the last
    // session's data.
    const offHours = !getCurrentSession('index').isMarketOpen;
    const bseIndex = isBSEIndex(symbol);

    // ── 1. NSE PRIMARY — NSE indices and equities ──────────────────
    let rawNse: any = null;
    const nseStart = Date.now();
    if (!chainData && !bseIndex) {
      // NSE path for NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY + equities
      try {
        // The contract is resolved by the provider: the requested one when it
        // exists, otherwise the NEAREST contract that is still trading. The
        // exchange lists the just-expired contract first — never take it.
        const nseData = await Promise.race([
          getNSEOptionChain(symbol, requestedExpiryIso ?? undefined),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error('NSE_TIMEOUT')), 7000))
        ]);
        rawNse = nseData;
        if (nseData?.records?.data) {
          // Which contract is this payload for? (the provider stamps it)
          const nseExpiries: string[] = Array.isArray(nseData.records.expiryDates) ? nseData.records.expiryDates : [];
          // The exchange's list is the authority on which contracts exist.
          // Cache it so every downstream consumer (expiry calculator, Zero
          // Hero, scanners) asks for a date the exchange actually serves.
          if (nseExpiries.length) setExchangeExpiries(symbol, nseExpiries);
          const nseEffective: string =
            nseData.records.selectedExpiry ||
            (nseData.records.data ?? []).find((r: any) => r?.expiryDates)?.expiryDates ||
            nseExpiries[0] ||
            '';
          effectiveExpiry = nseEffective || null;
          chainData = {
            data: nseData.records.data.map((row: any) => ({
              strike: row.strikePrice,
              ce: row.CE ? {
                ltp: numOrNull(row.CE.lastPrice),
                oi: numOrNull(row.CE.openInterest),
                oiChg: numOrNull(row.CE.changeinOpenInterest),
                volume: numOrNull(row.CE.totalTradedVolume),
                iv: numOrNull(row.CE.impliedVolatility),
                delta: numOrNull(row.CE.greeks?.delta),
                gamma: numOrNull(row.CE.greeks?.gamma),
                theta: numOrNull(row.CE.greeks?.theta),
                vega: numOrNull(row.CE.greeks?.vega),
                bid: numOrNull(row.CE.bid),
                ask: numOrNull(row.CE.ask),
              } : null,
              pe: row.PE ? {
                ltp: numOrNull(row.PE.lastPrice),
                oi: numOrNull(row.PE.openInterest),
                oiChg: numOrNull(row.PE.changeinOpenInterest),
                volume: numOrNull(row.PE.totalTradedVolume),
                iv: numOrNull(row.PE.impliedVolatility),
                delta: numOrNull(row.PE.greeks?.delta),
                gamma: numOrNull(row.PE.greeks?.gamma),
                theta: numOrNull(row.PE.greeks?.theta),
                vega: numOrNull(row.PE.greeks?.vega),
                bid: numOrNull(row.PE.bid),
                ask: numOrNull(row.PE.ask),
              } : null,
            })),
            spotPrice: (nseData as any).records?.underlyingValue || 0,
            expiries: nseExpiries.map((d: string) => ({ date: d, label: d, daysToExpiry: 0 })),
            selectedExpiry: nseEffective,
            expiry: nseEffective,
            summary: { spotPrice: (nseData as any).records?.underlyingValue || 0 },
          };
          source = 'nse-api';
          // Use the exchange's own timestamp when it ships one — collecting
          // "now" is collection time, not a quote time, and would fabricate LIVE.
          providerTs = providerTimestamp(nseData);
          dataTimestamp = providerTs ?? new Date();
          providerHealth.recordSuccess("nse", Date.now() - nseStart);
          console.log('[API] NSE API data fetched successfully for', symbol, nseEffective);
        }
      } catch (nseError: any) {
        // The exchange does not carry the requested contract — an honest
        // failure, never a silent swap for another expiry.
        const msg = String(nseError?.message || nseError);
        if (isExpiryUnavailableReason(msg) || msg.includes(EXPIRY_UNAVAILABLE)) {
          expiryError = msg;
          console.warn('[API] NSE expiry unavailable:', msg);
        } else {
          console.warn('[API] NSE API failed:', nseError);
          providerHealth.recordFailure("nse", "NETWORK", msg.substring(0, 200));
        }
      }
    }

    // ── 2. BSE PRIMARY — SENSEX/BANKEX only ────────────────────────
    // NSE has no contract for these, so BSE is not a "fallback" here.
    if (!chainData && bseIndex) {
      try {
        const { getBSEOptionChain, getBSEExpiryDates } = await import('@/lib/bse-api');
        const bseExpiries = await getBSEExpiryDates(symbol).catch(() => [] as string[]);
        // Same as NSE: the exchange list wins over any hardcoded weekday rule.
        if (bseExpiries.length) setExchangeExpiries(symbol, bseExpiries);
        // The requested contract when it exists, else the nearest contract
        // that is still trading (BSE's own list already drops past expiries,
        // but the expiry-day cut-off is applied here too).
        let selectedExpiry = '';
        if (requestedExpiryIso) {
          const match = bseExpiries.find((e) => isSameExpiry(e, requestedExpiryIso));
          if (!match) {
            expiryError = `${EXPIRY_UNAVAILABLE}: expiry "${rawExpiry}" is not available for ${symbol}. Available: ${bseExpiries.slice(0, 12).join(', ') || 'none'}`;
            console.warn('[API]', expiryError);
          } else {
            selectedExpiry = match;
          }
        } else {
          selectedExpiry = selectNearestLiveExpiry(bseExpiries) || '';
        }

        if (selectedExpiry && !expiryError) {
          const bseStart = Date.now();
          const bseChain = await Promise.race([
            getBSEOptionChain(symbol, selectedExpiry),
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error('BSE_TIMEOUT')), 5000))
          ]).catch(() => null);
          if (bseChain?.data?.length) {
            chainData = {
              data: bseChain.data.map((row) => ({
                strike: row.strike,
                ce: row.ce ? {
                  ltp: numOrNull(row.ce.ltp),
                  oi: numOrNull(row.ce.oi),
                  oiChg: numOrNull(row.ce.oiChg),
                  volume: numOrNull(row.ce.volume),
                  iv: numOrNull(row.ce.iv),
                  chg: numOrNull(row.ce.chg),
                  bid: numOrNull(row.ce.bid),
                  ask: numOrNull(row.ce.ask),
                } : null,
                pe: row.pe ? {
                  ltp: numOrNull(row.pe.ltp),
                  oi: numOrNull(row.pe.oi),
                  oiChg: numOrNull(row.pe.oiChg),
                  volume: numOrNull(row.pe.volume),
                  iv: numOrNull(row.pe.iv),
                  chg: numOrNull(row.pe.chg),
                  bid: numOrNull(row.pe.bid),
                  ask: numOrNull(row.pe.ask),
                } : null,
              })),
              spotPrice: bseChain.spotPrice,
              expiries: bseExpiries.map((e: string) => ({ date: e, label: e, daysToExpiry: 0 })),
              selectedExpiry,
              expiry: selectedExpiry,
              summary: { spotPrice: bseChain.spotPrice },
            };
            source = 'bse-api';
            effectiveExpiry = selectedExpiry || null;
            // BSE DeriOptionChain_IV ships no publication timestamp — leave
            // providerTs null so freshness cannot claim LIVE.
            providerTs = providerTimestamp(bseChain);
            dataTimestamp = providerTs ?? new Date();
            providerHealth.recordSuccess("nse", Date.now() - bseStart); // reuse nse slot for BSE
            console.log('[API] BSE option chain fetched for', symbol);
          }
        }
      } catch (bseError) {
        console.warn('[API] BSE API failed for', symbol, ':', String(bseError).substring(0, 200));
      }
    }

    // ── 3. MOAPI FALLBACK — only when the exchange's own API failed ──
    const moapiStart = Date.now();
    if (!chainData && !offHours && !providerHealth.shouldSkip("moapi")) {
    try {
      const { getMotilalOptionChain } = await import('@/lib/motilal-option-chain');
      const motilalChain = await Promise.race([
        getMotilalOptionChain(symbol, requestedExpiryIso ?? undefined),
        // Fallback rung only runs after NSE/BSE already failed — give the
        // local MOAPI service room for instruments + bulk LTP (~5s typical).
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('MOAPI_TIMEOUT')), 10000))
      ]);
      if (motilalChain?.data?.length) {
        chainData = {
          data: motilalChain.data.map((row: any) => ({
            strike: row.strike,
            ce: row.ce ? {
              ltp: numOrNull(row.ce.ltp),
              oi: numOrNull(row.ce.oi),
              oiChg: 0,
              volume: numOrNull(row.ce.volume),
              iv: numOrNull(row.ce.iv),
              delta: numOrNull(row.ce.delta),
              gamma: numOrNull(row.ce.gamma),
              theta: numOrNull(row.ce.theta),
              vega: numOrNull(row.ce.vega),
              bid: numOrNull(row.ce.bid),
              ask: numOrNull(row.ce.ask),
            } : null,
            pe: row.pe ? {
              ltp: numOrNull(row.pe.ltp),
              oi: numOrNull(row.pe.oi),
              oiChg: 0,
              volume: numOrNull(row.pe.volume),
              iv: numOrNull(row.pe.iv),
              delta: numOrNull(row.pe.delta),
              gamma: numOrNull(row.pe.gamma),
              theta: numOrNull(row.pe.theta),
              vega: numOrNull(row.pe.vega),
              bid: numOrNull(row.pe.bid),
              ask: numOrNull(row.pe.ask),
            } : null,
          })),
          spotPrice: motilalChain.spotPrice,
          expiries: motilalChain.expiries.map((e) => ({ date: e, label: e, daysToExpiry: 0 })),
          selectedExpiry: motilalChain.selectedExpiry,
          expiry: motilalChain.selectedExpiry,
          summary: motilalChain.summary,
        };
        source = 'motilal-api';
        effectiveExpiry = motilalChain.selectedExpiry || null;
        providerHealth.recordSuccess("moapi", Date.now() - moapiStart);
        console.log(`[API] MOAPI option chain fetched for ${symbol}`);
      }
    } catch (moapiError) {
      console.warn('[API] MOAPI failed:', moapiError);
      providerHealth.recordFailure("moapi", "SERVER", String(moapiError).substring(0, 200));
    }
    } else if (!chainData) {
      console.log('[API] Skipping MOAPI —', offHours ? 'market closed' : 'circuit open');
    }

    // ── 4. BREEZE OPT-IN LAST RESORT — bounded 7s + fast failover ──
    // AUTH_REQUIRED, TIMEOUT, ERROR → immediately give up (NO_DATA).
    // No offHours gate: a valid session serves frozen off-hours data fine,
    // and dead auth is already encoded in the circuit (shouldSkip).
    const breezeStart = Date.now();
    if (!chainData && !providerHealth.shouldSkip("breeze")) {
      try {
        const fetchBreezeChain = async () => {
          if (requestedExpiryIso) {
            // The requested contract, in the format the Breeze SDK wants.
            return await getOptionChain(symbol, toNseExpiry(requestedExpiryIso) || requestedExpiryIso);
          } else {
            // Front month only — a spot snapshot is always the nearest
            // contract, and walking every back month burns the whole budget.
            const expiries = await getOptionChainExpiries(symbol);
            for (const exp of expiries.slice(0, 2)) {
              const chain = await getOptionChain(symbol, exp);
              if (chain) return { ...chain, expiries };
            }
            return null;
          }
        };

        // Bounded timeout: 7 seconds max for Breeze
        const BREEZE_TIMEOUT_MS = 7000;
        const chain = await Promise.race([
          fetchBreezeChain(),
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error('BREEZE_TIMEOUT')), BREEZE_TIMEOUT_MS)
          ),
        ]);

        if (chain) {
          chainData = chain;
          source = 'icici-breeze';
          // Breeze was asked for one specific contract — that is the one it
          // returned. Without a request it is the front month.
          effectiveExpiry = requestedExpiryIso
            ? (toNseExpiry(requestedExpiryIso) || requestedExpiryIso)
            : (chain as any).selectedExpiry || (chain as any).expiry || null;
          providerHealth.recordSuccess("breeze", Date.now() - breezeStart);
          console.log(`[API] Breeze option chain fetched for ${symbol}`);
        }
      } catch (breezeError: any) {
        const errMsg = String(breezeError?.message || breezeError);
        // Fast failover for specific error types
        if (errMsg.includes('AUTH') || errMsg.includes('401') || errMsg.includes('403') ||
            errMsg.includes('Unauthorized') || errMsg.includes('BREEZE_TIMEOUT')) {
          providerHealth.recordFailure("breeze", errMsg.includes('TIMEOUT') ? "TIMEOUT" : "AUTH", errMsg.substring(0, 120));
          console.warn(`[API] Breeze ${errMsg.includes('TIMEOUT') ? 'timeout' : 'auth error'} — no data from last resort`);
        } else {
          providerHealth.recordFailure("breeze", "NETWORK", errMsg.substring(0, 120));
          console.warn('[API] Breeze error:', errMsg.substring(0, 120));
        }
      }
    } else if (!chainData) {
      console.log('[API] Skipping Breeze — circuit open or an earlier provider succeeded');
    }

    // Normalize option chain via central data layer (only when no chain was
    // already found by the provider tree — normalize is a structure adapter,
    // not a data source)
    // Map a canonical chain (NSE/BSE/MOAPI/BHAVCOPY) into the route's response shape.
    const mapCanonical = (normResult: any) => {
      chainData = {
        data: normResult.data.strikes.map((s: any) => ({
          strike: s.strike,
          ce: s.ce ? { ltp: numOrNull(s.ce.ltp), oi: numOrNull(s.ce.oi), oiChg: numOrNull(s.ce.oiChange), volume: numOrNull(s.ce.volume), iv: numOrNull(s.ce.iv), delta: numOrNull(s.ce.delta), gamma: numOrNull(s.ce.gamma), theta: numOrNull(s.ce.theta), vega: 0, bid: numOrNull(s.ce.bid), ask: numOrNull(s.ce.ask) } : null,
          pe: s.pe ? { ltp: numOrNull(s.pe.ltp), oi: numOrNull(s.pe.oi), oiChg: numOrNull(s.pe.oiChange), volume: numOrNull(s.pe.volume), iv: numOrNull(s.pe.iv), delta: numOrNull(s.pe.delta), gamma: numOrNull(s.pe.gamma), theta: numOrNull(s.pe.theta), vega: 0, bid: numOrNull(s.pe.bid), ask: numOrNull(s.pe.ask) } : null,
        })),
        spotPrice: normResult.data.spot || 0,
        expiry: normResult.data.expiry,
        selectedExpiry: normResult.data.expiry || '',
        summary: { spotPrice: normResult.data.spot },
      };
      source = normResult.source;
      providerTs = providerTimestamp(normResult.data);
      dataTimestamp = providerTs ?? new Date();
      effectiveExpiry = normResult.data.expiry || null;
      // Provenance stamps: WHICH contract, WHEN it was priced, and whether it
      // is end-of-day data (never a live chain).
      chainAsOf = normResult.data.asOf || null;
      chainIsEod = normResult.data.isEod === true;
      chainExpirySelection = normResult.data.expirySelection || null;
    };

    if (!chainData && rawNse) {
      const normResult = normalizeOptionChain(rawNse, requestedExpiryIso ?? undefined, symbol);
      if (normResult.data) mapCanonical(normResult);
      else if (isExpiryUnavailableReason(normResult.fallbackReason)) expiryError = normResult.fallbackReason!;
    }
    if (!chainData) {
      // Last resort: the canonical exchange-aware chain (NSE primary, BSE for
      // SENSEX/BANKEX, MOAPI, and the bhavcopy EOD fallback when the live BSE
      // endpoint is blocked). Keeps this route on ONE provider tree.
      const { getOptionChain: canonicalChain } = await import("@/lib/data-layer/chains/option-chain");
      const canon = await canonicalChain(symbol, requestedExpiryIso ?? undefined);
      if (canon.data) {
        mapCanonical(canon);
        if (canon.fallbackReason) console.warn(`[API] ${symbol} chain from fallback: ${canon.fallbackReason}`);
      } else if (isExpiryUnavailableReason(canon.fallbackReason)) {
        // The requested contract does not exist — an honest failure, never a
        // silent swap for another expiry.
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
    // Breeze/NSE format ("03-Nov-2026") — never new Date() alone
    const expiryDate = parseExpiryDateLoose(selectedExpiry, now) ?? new Date(selectedExpiry);
    const daysToExpiry = Math.max(1, Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    const tte = daysToExpiry / 365; // time to expiry in years

    for (const strike of optionChainStrikes) {
      // The greeks come from Black-Scholes on the EXCHANGE's own IV.
      // A leg the exchange published no IV for gets NO greeks — the old code
      // invented an IV from the moneyness (baseIV = 0.15 + moneyness×2) and
      // published it as if the exchange had sent it.
      const applyGreeks = (leg: any, isCall: boolean) => {
        if (!leg) return null;
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
      if (isTradeAction && hasConfidence && entryOk && levelsOk && sessGate.allowed && peFallingOk) {
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
    try {
      const { getNSEIndices } = await import('@/lib/nse-api');
      const nseIdx = await getNSEIndices();
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
