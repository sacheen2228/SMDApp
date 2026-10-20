// ── THE MOTILAL PRICE CHAIN ──────────────────────────────────────────────────
// THE FALLBACK ORDER (explicit, documented, and enforced by runQuoteChain):
//
//     1. THE MOAPI SERVICE   (src/lib/motilal/service.ts — the local
//                            Motilal OpenAPI service, official SDK, live
//                            feed + the authoritative instrument master)
//     2. THE DIRECT MOTILAL REST CLIENT (src/lib/motilal/market.ts and the
//                            option chain built on it)
//     3. THE NSE PATH        (the exchange's own chain — no token, no
//                            session, but the primary source in the app)
//     4. UNAVAILABLE         (an explicit "no price" result — NEVER a
//                            fabricated, interpolated or guessed value)
//
// NO STEP MAY FABRICATE A VALUE. A step either produces a real price or it
// fails; the chain then moves to the next rung. The last rung is an explicit
// "unavailable" result (ltp 0) — the caller decides what to do with it.
//
// THE MOAPI SERVICE IS OPTIONAL. When MOAPI_SERVICE_URL is unset the first
// rung is inert (it returns immediately, without a network call) and the
// chain behaves exactly as it did before the service existed.
//
// THE PLAUSIBILITY GUARD (rungs 1 and 2 only): a Motilal premium is only
// used when it is provably the premium of the trade's contract:
//   • the premium is a positive price,
//   • the contract that was priced is the trade's contract (strike, option
//     type AND expiry must match),
//   • the premium is strictly below the underlying price.
// A price that fails the guard is REJECTED — never used, never displayed.

import {
  fetchServiceInstruments,
  fetchServiceLTP,
  isServiceConfigured,
  type ServiceInstrument,
  type ServiceLTP,
} from "./service";
// The auth module touches node-only APIs (fs/path) — it must be loaded lazily so
// this file stays safe inside the client bundle.

// ── Types ───────────────────────────────────────────────────────────────────
export type QuoteSource = "moapi-service" | "motilal-rest" | "nse" | "unavailable";

/** The contract a price is wanted for. */
export interface OptionRef {
  /** The UNDERLYING symbol ("NIFTY", "SBIN", …). */
  symbol: string;
  strike: number;
  /** "CE" | "PE". */
  optionType: string;
  /** The trade's expiry — YYYY-MM-DD, "29-Oct-2026" or "20261029". */
  expiry?: string;
}

export interface PlausibilityInput {
  premium: number;
  /** The live underlying price (0/undefined → the check fails closed). */
  underlyingPrice?: number | null;
  expectedStrike?: number | null;
  expectedOptionType?: string | null;
  expectedExpiry?: string | null;
  actualStrike?: number | null;
  actualOptionType?: string | null;
  actualExpiry?: string | null;
}

export interface PlausibilityResult {
  ok: boolean;
  reason: string;
}

export interface QuoteStepOutcome {
  ok: boolean;
  ltp?: number;
  reason?: string;
  tradingsymbol?: string;
  expiry?: string;
  underlying?: number;
}

export interface QuoteContext {
  ref: OptionRef;
  deps: QuoteDeps;
}

export interface QuoteStep {
  name: QuoteSource;
  run: (ctx: QuoteContext) => Promise<QuoteStepOutcome>;
}

/** A price produced by one of the rungs. */
export interface RungLTP {
  ltp: number;
  expiry?: string;
  underlying?: number;
  tradingsymbol?: string;
}

export interface QuoteDeps {
  /** The service's instrument master (cached 30 minutes). */
  serviceInstruments?: () => Promise<ServiceInstrument[] | null>;
  /** The service's live price for a tradingsymbol. */
  serviceLTP?: (tradingsymbol: string) => Promise<ServiceLTP | null>;
  /** The direct Motilal REST client. */
  restLTP?: (ref: OptionRef) => Promise<RungLTP | null>;
  /** The NSE chain. */
  nseLTP?: (ref: OptionRef) => Promise<RungLTP | null>;
  /** The live underlying price (the guard's reference). */
  underlying?: (symbol: string) => Promise<number>;
}

export interface LTPResolution {
  /** 0 = unavailable (no rung produced a price). */
  ltp: number;
  /** Which rung produced the price ("unavailable" when none did). */
  source: QuoteSource;
  tradingsymbol?: string;
  expiry?: string;
  underlying?: number;
  /** Why the last rung failed (the honest "no price" explanation). */
  reason?: string;
  /** The full ladder — every rung and what it did. */
  steps: Array<{ source: QuoteSource; ok: boolean; reason?: string }>;
}

// ── Expiry helpers ──────────────────────────────────────────────────────────
const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/**
 * Normalise an expiry to "YYYY-MM-DD". Accepts "2026-10-29", "29-Oct-2026",
 * "29 OCT 2026" and "20261029". null when it cannot be parsed — and an
 * unparseable expiry can never be VERIFIED, so the guard fails closed.
 */
export function normalizeExpiry(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}`;

  m = /^(\d{1,2})[-\s/]([A-Za-z]{3})[-\s/](\d{4})/.exec(raw);
  if (m) {
    const mon = MONTHS[m[2].toUpperCase()];
    if (!mon) return null;
    return `${m[3]}-${String(mon).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
  }

  m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  return null;
}

function normalizeOptionType(value: string | null | undefined): string {
  const raw = String(value || "").trim().toUpperCase();
  if (raw === "CE" || raw === "CALL") return "CE";
  if (raw === "PE" || raw === "PUT") return "PE";
  return raw;
}

// ── THE PLAUSIBILITY GUARD ──────────────────────────────────────────────────
/**
 * Is this premium a believable price for the trade's contract?
 *
 * A Motilal premium is only usable when we can PROVE it is the premium of
 * the contract the trade is in:
 *   1. it is a positive price (a 0 or a negative is not a price),
 *   2. the contract that was priced IS the trade's contract — same strike,
 *      same option type, same expiry (an option premium is contract
 *      specific: a premium from another expiry would fire a false TP/SL),
 *   3. it is strictly below the underlying price (an option can never be
 *      worth more than what it settles into).
 *
 * Every check fails CLOSED: a missing strike/type/expiry or an unknown
 * underlying REJECTS the price. The guard never approves on a guess.
 */
export function isPlausibleOptionPrice(input: PlausibilityInput): PlausibilityResult {
  const premium = Number(input?.premium);
  if (!Number.isFinite(premium) || premium <= 0) {
    return { ok: false, reason: "the premium is not a positive price" };
  }

  const expectedStrike = Number(input?.expectedStrike);
  const actualStrike = Number(input?.actualStrike);
  if (!Number.isFinite(expectedStrike) || expectedStrike <= 0) {
    return { ok: false, reason: "the trade strike is unknown — the contract cannot be verified" };
  }
  if (!Number.isFinite(actualStrike) || actualStrike <= 0) {
    return { ok: false, reason: "the priced contract has no strike" };
  }
  if (expectedStrike !== actualStrike) {
    return {
      ok: false,
      reason: `strike mismatch (trade ${expectedStrike} vs contract ${actualStrike})`,
    };
  }

  const expectedType = normalizeOptionType(input?.expectedOptionType);
  const actualType = normalizeOptionType(input?.actualOptionType);
  if (!expectedType || !actualType) {
    return { ok: false, reason: "the option type is unknown — the contract cannot be verified" };
  }
  if (expectedType !== actualType) {
    return {
      ok: false,
      reason: `option type mismatch (trade ${expectedType} vs contract ${actualType})`,
    };
  }

  const expectedExpiry = normalizeExpiry(input?.expectedExpiry);
  if (!expectedExpiry) {
    return { ok: false, reason: "the trade expiry is unknown — the contract cannot be verified" };
  }
  const actualExpiry = normalizeExpiry(input?.actualExpiry);
  if (!actualExpiry) {
    return { ok: false, reason: "the priced contract has no expiry" };
  }
  if (expectedExpiry !== actualExpiry) {
    return {
      ok: false,
      reason: `expiry mismatch (trade ${expectedExpiry} vs contract ${actualExpiry})`,
    };
  }

  const underlying = Number(input?.underlyingPrice);
  if (!Number.isFinite(underlying) || underlying <= 0) {
    return {
      ok: false,
      reason: "the underlying price is unknown — the premium cannot be verified",
    };
  }
  if (premium >= underlying) {
    return {
      ok: false,
      reason: `the premium (${premium}) is not below the underlying (${underlying})`,
    };
  }

  return { ok: true, reason: "ok" };
}

// ── The underlying price (the guard's reference) ────────────────────────────
const UNDERLYING_TTL_MS = 5_000;
const underlyingCache = new Map<string, { price: number; ts: number }>();

/** Drop the cached underlying prices (test seam). */
export function resetUnderlyingCache(): void {
  underlyingCache.clear();
}

/**
 * TEST SEAM: replace the underlying resolver (the NSE call) with a local
 * function. Pass null to restore the real one. It exists so the offline
 * tests can exercise the real chain without a network call — it never
 * changes what a price is allowed to do, only where the reference comes from.
 */
let underlyingResolverOverride: ((symbol: string) => Promise<number>) | null = null;

export function __setUnderlyingResolverForTests(
  fn: ((symbol: string) => Promise<number>) | null
): void {
  underlyingResolverOverride = fn;
  resetUnderlyingCache();
}

/**
 * The live underlying price, used ONLY as the plausibility reference. It is
 * a real price from the exchange (NSE) — never an estimate. 0 when it cannot
 * be resolved (the guard then fails closed).
 */
export async function resolveUnderlyingPrice(
  symbol: string,
  explicit?: number | null
): Promise<number> {
  if (explicit !== null && explicit !== undefined && Number(explicit) > 0) {
    return Number(explicit);
  }
  if (underlyingResolverOverride) {
    return Number((await underlyingResolverOverride(String(symbol || ""))) || 0);
  }
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return 0;

  const cached = underlyingCache.get(sym);
  if (cached && Date.now() - cached.ts < UNDERLYING_TTL_MS) return cached.price;

  let price = 0;
  try {
    const { isIndexSymbol, getNSEIndexQuote } = await import("@/lib/nse-api");
    if (isIndexSymbol(sym)) {
      const quote = await getNSEIndexQuote(sym);
      price = Number(quote?.regularMarketPrice || 0);
    } else {
      const { fetchStockQuotes } = await import("@/lib/nse-stock-data");
      const quotes = await fetchStockQuotes([sym]);
      price = Number(quotes?.[sym]?.ltp || quotes?.[sym.toUpperCase()]?.ltp || 0);
    }
  } catch {
    price = 0;
  }

  if (price > 0) underlyingCache.set(sym, { price, ts: Date.now() });
  return price;
}

// ── The service's instrument master ─────────────────────────────────────────
/**
 * The index over the service's instrument master: "SYMBOL|STRIKE|TYPE" → the
 * contracts. The master has ~126k rows, so the 5-second TP/SL poll cannot
 * scan it every time — the index is built once per master (the master is
 * cached for 30 minutes).
 */
let contractIndex = { source: null as ServiceInstrument[] | null, map: new Map<string, ServiceInstrument[]>() };

function buildContractIndex(instruments: ServiceInstrument[]): Map<string, ServiceInstrument[]> {
  const map = new Map<string, ServiceInstrument[]>();
  for (const row of instruments) {
    const key = `${row.symbol}|${Number(row.strike)}|${normalizeOptionType(row.optionType)}`;
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
  }
  return map;
}

/**
 * The service contract for a trade's option: same symbol, same strike, same
 * option type and — when the trade's expiry is known — the SAME expiry.
 * null when the master does not carry it.
 */
export function findServiceContract(
  instruments: ServiceInstrument[] | null,
  ref: OptionRef
): ServiceInstrument | null {
  if (!instruments || !instruments.length) return null;

  const symbol = String(ref.symbol || "").trim().toUpperCase();
  const strike = Number(ref.strike);
  const optionType = normalizeOptionType(ref.optionType);
  const expiry = normalizeExpiry(ref.expiry);

  if (contractIndex.source !== instruments) {
    contractIndex = { source: instruments, map: buildContractIndex(instruments) };
  }

  const matches = contractIndex.map.get(`${symbol}|${strike}|${optionType}`);
  if (!matches || !matches.length) return null;

  if (expiry) {
    const exact = matches.filter((row) => normalizeExpiry(row.expiry) === expiry);
    if (!exact.length) return null;
    // The nearest expiry when the trade's expiry is known but several rows
    // carry it (the master can hold the same strike on two exchanges).
    exact.sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)));
    return exact[0] || null;
  }

  // The nearest expiry when the trade's expiry is unknown (the guard then
  // rejects it — an unverifiable contract is never priced).
  const sorted = [...matches].sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)));
  return sorted[0] || null;
}

// ── Rung 1: the MOAPI service ──────────────────────────────────────────────
export const serviceStep: QuoteStep = {
  name: "moapi-service",
  async run(ctx: QuoteContext): Promise<QuoteStepOutcome> {
    const { ref, deps } = ctx;
    if (!isServiceConfigured()) {
      return { ok: false, reason: "MOAPI_SERVICE_URL is not set" };
    }

    const instruments = await deps.serviceInstruments!();
    if (!instruments || !instruments.length) {
      return { ok: false, reason: "the service instrument master is unavailable" };
    }

    const contract = findServiceContract(instruments, ref);
    if (!contract) {
      return {
        ok: false,
        reason: `no ${ref.optionType} ${ref.strike} contract for ${ref.symbol} in the service master`,
      };
    }
    if (!contract.tradingsymbol) {
      return { ok: false, reason: "the service contract has no tradingsymbol" };
    }

    const quote = await deps.serviceLTP!(contract.tradingsymbol);
    if (!quote) {
      return { ok: false, reason: "the service has no price for the contract" };
    }

    const underlying = await deps.underlying!(ref.symbol);
    const check = isPlausibleOptionPrice({
      premium: quote.ltp,
      underlyingPrice: underlying,
      expectedStrike: ref.strike,
      expectedOptionType: ref.optionType,
      expectedExpiry: ref.expiry,
      actualStrike: contract.strike,
      actualOptionType: contract.optionType,
      actualExpiry: contract.expiry,
    });
    if (!check.ok) {
      return { ok: false, reason: `implausible premium: ${check.reason}` };
    }

    return {
      ok: true,
      ltp: quote.ltp,
      tradingsymbol: contract.tradingsymbol,
      expiry: contract.expiry,
      underlying,
    };
  },
};

// ── Rung 2: the direct Motilal REST client ─────────────────────────────────
/** The default REST rung: the Motilal option chain (LTP only). */
async function defaultRestLTP(ref: OptionRef): Promise<RungLTP | null> {
  // No valid session → this rung cannot answer. We never trigger a LOGIN
  // from the 5-second poll loop (a login is a human-scale operation).
  // the auth module is node-only → load it lazily (this file ships to the client)
  const { isSessionValid } = await import("./auth");
  if (!isSessionValid()) return null;

  const expiry = normalizeExpiry(ref.expiry);
  const { getMotilalOptionChain } = await import("../motilal-option-chain");
  const chain = await getMotilalOptionChain(ref.symbol, expiry || undefined);
  if (!chain) return null;

  const strike = chain.data.find((row) => Number(row.strike) === Number(ref.strike));
  if (!strike) return null;

  const leg = normalizeOptionType(ref.optionType) === "CE" ? strike.ce : strike.pe;
  if (!leg || !(leg.ltp > 0)) return null;

  return {
    ltp: leg.ltp,
    expiry: chain.selectedExpiry,
    underlying: chain.spotPrice,
  };
}

export const restStep: QuoteStep = {
  name: "motilal-rest",
  async run(ctx: QuoteContext): Promise<QuoteStepOutcome> {
    const { ref, deps } = ctx;

    const quote = await deps.restLTP!(ref);
    if (!quote || !(quote.ltp > 0)) {
      return { ok: false, reason: "the Motilal REST client has no premium for the contract" };
    }

    const underlying = (await deps.underlying!(ref.symbol)) || quote.underlying || 0;
    const check = isPlausibleOptionPrice({
      premium: quote.ltp,
      underlyingPrice: underlying,
      expectedStrike: ref.strike,
      expectedOptionType: ref.optionType,
      expectedExpiry: ref.expiry,
      actualStrike: ref.strike,
      actualOptionType: ref.optionType,
      actualExpiry: quote.expiry,
    });
    if (!check.ok) {
      return { ok: false, reason: `implausible premium: ${check.reason}` };
    }

    return { ok: true, ltp: quote.ltp, expiry: quote.expiry, underlying };
  },
};

// ── Rung 3: the NSE path ────────────────────────────────────────────────────
/** The default NSE rung: the exchange's own option chain. */
async function defaultNSELTP(ref: OptionRef): Promise<RungLTP | null> {
  const { getNSEOptionChain, getNSEEquityOptionChain, isIndexSymbol } = await import("@/lib/nse-api");
  const symbol = String(ref.symbol || "").trim().toUpperCase();
  const strike = Number(ref.strike);
  const wantCall = normalizeOptionType(ref.optionType) === "CE";

  if (isIndexSymbol(symbol)) {
    const data: any = await getNSEOptionChain(symbol);
    const rows = data?.records?.data;
    if (!Array.isArray(rows)) return null;
    const row = rows.find((r: any) => Number(r?.strikePrice) === strike);
    if (!row) return null;
    const leg = wantCall ? row.CE : row.PE;
    const ltp = Number(leg?.lastPrice || 0);
    if (!(ltp > 0)) return null;
    return { ltp, expiry: row.expiryDates, underlying: Number(data?.records?.underlyingValue || 0) };
  }

  const chain = await getNSEEquityOptionChain(symbol);
  if (!chain) return null;
  const row = chain.rows.find((r) => Number(r.strike) === strike);
  if (!row) return null;
  const ltp = Number(wantCall ? row.ceLtp : row.peLtp || 0);
  if (!(ltp > 0)) return null;
  return { ltp, expiry: chain.expiry, underlying: Number(chain.spot || 0) };
}

export const nseStep: QuoteStep = {
  name: "nse",
  async run(ctx: QuoteContext): Promise<QuoteStepOutcome> {
    const quote = await ctx.deps.nseLTP!(ctx.ref);
    if (!quote || !(quote.ltp > 0)) {
      return { ok: false, reason: "the NSE chain has no premium for the contract" };
    }
    return { ok: true, ltp: quote.ltp, expiry: quote.expiry, underlying: quote.underlying };
  },
};

// ── The chain ───────────────────────────────────────────────────────────────
/** The default dependencies (the real implementations). */
export function defaultQuoteDeps(): Required<QuoteDeps> {
  return {
    serviceInstruments: () => fetchServiceInstruments(),
    serviceLTP: (tradingsymbol: string) => fetchServiceLTP(tradingsymbol),
    restLTP: (ref: OptionRef) => defaultRestLTP(ref),
    nseLTP: (ref: OptionRef) => defaultNSELTP(ref),
    underlying: (symbol: string) => resolveUnderlyingPrice(symbol),
  };
}

/**
 * Run a ladder of rungs, first price wins. The ladder is EXPLICIT — the
 * order is the caller's, and every rung's outcome is recorded.
 */
export async function runQuoteChain(
  steps: QuoteStep[],
  ref: OptionRef,
  deps: Partial<QuoteDeps> = {}
): Promise<LTPResolution> {
  const resolved: Required<QuoteDeps> = { ...defaultQuoteDeps(), ...deps };
  const ctx: QuoteContext = { ref, deps: resolved };
  const trail: Array<{ source: QuoteSource; ok: boolean; reason?: string }> = [];

  for (const step of steps) {
    let outcome: QuoteStepOutcome;
    try {
      outcome = await step.run(ctx);
    } catch (err: any) {
      outcome = { ok: false, reason: `threw: ${err?.message || err}` };
    }
    trail.push({ source: step.name, ok: !!outcome?.ok, reason: outcome?.reason });
    const ltp = Number(outcome?.ltp || 0);
    if (outcome?.ok && ltp > 0) {
      return {
        ltp,
        source: step.name,
        tradingsymbol: outcome.tradingsymbol,
        expiry: outcome.expiry,
        underlying: outcome.underlying,
        steps: trail,
      };
    }
  }

  // 4. The explicit "unavailable" rung — no price was produced.
  const last = trail[trail.length - 1];
  return {
    ltp: 0,
    source: "unavailable",
    reason: last?.reason || "no source produced a price",
    steps: trail,
  };
}

/**
 * THE MO PATH: the service, then the direct Motilal REST client. Used by the
 * TP/SL monitor (see src/lib/tiger-monitor.ts) — a premium that fails the
 * plausibility guard is NOT returned (the caller falls through to its own
 * rungs).
 */
export async function resolveMOOptionLTP(
  ref: OptionRef,
  deps: Partial<QuoteDeps> = {}
): Promise<LTPResolution> {
  return runQuoteChain([serviceStep, restStep], ref, deps);
}

/**
 * THE FULL MOTILAL CHAIN: service → direct REST → NSE → unavailable.
 */
export async function resolveOptionLTP(
  ref: OptionRef,
  deps: Partial<QuoteDeps> = {}
): Promise<LTPResolution> {
  return runQuoteChain([serviceStep, restStep, nseStep], ref, deps);
}
