// bhavcopy provider — EOD option chain from the exchange bhavcopy archives.
//
// WHY: the BSE live derivative-chain endpoint answers 403/302 for SENSEX/BANKEX,
// which left the SENSEX cards (option chain, atm-straddle) with NO_DATA even
// though the exchange publishes the full day's chain in the bhavcopy file.
//
// This provider is the LAST resort in the chain: it returns the day's CLOSE
// prices with real OI/volume and the underlying level, and it is always
// labelled `BHAVCOPY` (EOD) so no card can mistake it for a live chain.
//
// EXPIRY: the bhavcopy file lists the contract that just expired first, the
// same way the live contract list does. An EOD file must never hand back a
// DEAD contract as if it were tradable — the nearest contract that is still
// trading is selected, and an expired one is refused outright.
//
// Data: NSE/BSE bhavcopy (src/lib/option-bhavcopy.ts) — real exchange files.
import type { OptionChainData, OptionLeg, OptionStrike, ProviderResult } from "../types";
import { loadBhavcopyForTrade, type PremiumCandle } from "@/lib/option-bhavcopy";
import { toContracts } from "@/lib/oi-units";
import {
  EXPIRY_UNAVAILABLE,
  expiryUnavailableReason,
  isExpiryExpired,
  isSameExpiry,
  selectNearestLiveExpiry,
  toIsoDate,
  type CanonicalOptionChain,
} from "@/lib/data-layer/chains/option-chain";

/** Trading days to walk back when today's file is not published yet. */
const MAX_LOOKBACK_DAYS = 6;

function legFrom(row: PremiumCandle): OptionLeg {
  return {
    ltp: row.close > 0 ? row.close : null,
    volume: row.volume || null, // TtlTradgVol is already in CONTRACTS
    // OpnIntrst is in UNDERLYING UNITS (÷lot = participant OI) → CONTRACTS.
    oi: row.oi ? toContracts(row.oi, row.symbol) : null,
    oiChange: null,        // the bhavcopy is a single day — no day-over-day delta
    iv: null,               // not in the bhavcopy
    bid: null,
    ask: null,
    delta: null,
    gamma: null,
    theta: null,
    rho: null,
  };
}

/** Test seam: replace the bhavcopy loader (the real one hits the exchange). */
let loader = loadBhavcopyForTrade;
export function __setBhavcopyLoaderForTests(fn: typeof loadBhavcopyForTrade | null): void {
  loader = fn ?? loadBhavcopyForTrade;
}

export const bhavcopyProvider = {
  id: "bhavcopy",

  async getOptionChain(symbol: string, expiry?: string): Promise<ProviderResult<CanonicalOptionChain>> {
    const sym = String(symbol || "").toUpperCase();
    if (!sym) {
      return { data: null, fallbackUsed: true, source: "NO_DATA", fallbackReason: "no symbol" };
    }

    // Find the most recent published bhavcopy that has this symbol.
    let rows: PremiumCandle[] = [];
    let usedDate = "";
    for (let i = 0; i < MAX_LOOKBACK_DAYS && !rows.length; i++) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      try {
        const r = await loader(d, sym);
        if (r.length) { rows = r; usedDate = d; }
      } catch { /* keep walking back */ }
    }
    if (!rows.length) {
      return { data: null, fallbackUsed: true, source: "NO_DATA", fallbackReason: `no bhavcopy rows for ${sym}` };
    }

    // Every contract present in the file (canonical ISO — never slice(0,10)).
    const expiries = [...new Set(
      rows.map((r) => toIsoDate(String(r.expiry))).filter((e): e is string => !!e)
    )].sort();
    if (!expiries.length) {
      return { data: null, fallbackUsed: true, source: "NO_DATA", fallbackReason: "bhavcopy has no expiries" };
    }

    // Pick the expiry: the requested one when it is present AND still
    // trading, else the nearest contract in the file that is still trading.
    // An expired contract is NEVER selected — serving a dead contract from an
    // EOD file is exactly the masquerade this provider must avoid.
    let selected: string | null = null;
    if (expiry) {
      const wanted = toIsoDate(expiry);
      if (!wanted) {
        return {
          data: null, fallbackUsed: true, source: "NO_DATA",
          fallbackReason: `${EXPIRY_UNAVAILABLE}: "${expiry}" is not a valid expiry date`,
        };
      }
      const match = expiries.find((e) => isSameExpiry(e, wanted));
      if (!match) {
        return {
          data: null, fallbackUsed: true, source: "NO_DATA",
          fallbackReason: expiryUnavailableReason(sym, expiry, expiries),
        };
      }
      if (isExpiryExpired(match)) {
        return {
          data: null, fallbackUsed: true, source: "NO_DATA",
          fallbackReason: `${EXPIRY_UNAVAILABLE}: expiry "${expiry}" has expired — the bhavcopy EOD fallback never serves a dead contract`,
        };
      }
      selected = match;
    } else {
      selected = selectNearestLiveExpiry(expiries);
      if (!selected) {
        return {
          data: null, fallbackUsed: true, source: "NO_DATA",
          fallbackReason: `${EXPIRY_UNAVAILABLE}: the bhavcopy file for ${sym} (${usedDate}) holds no contract that is still trading`,
        };
      }
    }

    const legs = rows.filter((r) => isSameExpiry(String(r.expiry), selected));
    if (!legs.length) {
      return { data: null, fallbackUsed: true, source: "NO_DATA", fallbackReason: `no ${selected} rows for ${sym}` };
    }

    // Group by strike → CE/PE legs.
    const byStrike = new Map<number, { ce?: PremiumCandle; pe?: PremiumCandle }>();
    for (const r of legs) {
      const e = byStrike.get(r.strike) || {};
      if (String(r.optionType).toUpperCase() === "CE") e.ce = r;
      else e.pe = r;
      byStrike.set(r.strike, e);
    }
    const strikes: OptionStrike[] = [...byStrike.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([strike, v]) => ({ strike, ce: v.ce ? legFrom(v.ce) : null, pe: v.pe ? legFrom(v.pe) : null }));

    const spot = legs.find((r) => r.underlying && r.underlying > 0)?.underlying ?? null;

    // The file's own date is the as-of stamp: this is END-OF-DAY data, never
    // a live chain.
    const asOf = new Date(`${usedDate}T15:30:00+05:30`).toISOString();

    return {
      data: {
        underlying: sym,
        spot,
        expiry: selected,
        strikes,
        timestamp: new Date().toISOString(),
        source: "BHAVCOPY",
        fallbackUsed: true,
        freshness: "STALE",
        asOf,
        expiryRequested: expiry ?? null,
        expirySelection: expiry ? "requested" : "nearest-live",
        isEod: true,
      },
      fallbackUsed: true,
      source: "BHAVCOPY",
      fallbackReason: `EOD bhavcopy ${usedDate} (live ${sym} chain unavailable)`,
    };
  },
};

export default bhavcopyProvider;
