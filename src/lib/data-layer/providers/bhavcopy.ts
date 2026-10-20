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
// Data: NSE/BSE bhavcopy (src/lib/option-bhavcopy.ts) — real exchange files.
import type { OptionChainData, OptionLeg, OptionStrike, ProviderResult } from "../types";
import { loadBhavcopyForTrade, type PremiumCandle } from "@/lib/option-bhavcopy";

/** Trading days to walk back when today's file is not published yet. */
const MAX_LOOKBACK_DAYS = 6;

function legFrom(row: PremiumCandle): OptionLeg {
  return {
    ltp: row.close > 0 ? row.close : null,
    volume: row.volume || null,
    oi: row.oi || null,
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

  async getOptionChain(symbol: string, expiry?: string): Promise<ProviderResult<OptionChainData>> {
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

    // Pick the expiry: the requested one if present, else the nearest in the file.
    const expiries = [...new Set(rows.map((r) => String(r.expiry).slice(0, 10)))].sort();
    if (!expiries.length) {
      return { data: null, fallbackUsed: true, source: "NO_DATA", fallbackReason: "bhavcopy has no expiries" };
    }
    const wanted = expiry ? String(expiry).slice(0, 10) : expiries[0];
    const selected = expiries.includes(wanted) ? wanted : expiries[0];
    const legs = rows.filter((r) => String(r.expiry).slice(0, 10) === selected);
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
      },
      fallbackUsed: true,
      source: "BHAVCOPY",
      fallbackReason: `EOD bhavcopy ${usedDate} (live ${sym} chain unavailable)`,
    };
  },
};

export default bhavcopyProvider;
