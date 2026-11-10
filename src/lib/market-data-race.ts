// Option-chain provider race — SHADOW MODE ONLY.
//
// Runs eligible providers concurrently with bounded timeouts. The first
// provider returning a valid, complete, sufficiently fresh chain wins; the
// complete chain always comes from ONE provider — CE and PE legs are never
// mixed across providers.
//
// Provider order (tie-break when responses are effectively simultaneous):
//   1. icici-breeze  (max 6 s)
//   2. motilal-api   (max 8 s)
//   3. nse-api       (max 8 s, via the shared NseGate)
//   4. bse-api       (max 8 s, BSE instruments such as SENSEX/BANKEX)
//
// Moneycontrol is supplementary only — never an authoritative live source.
//
// Losing requests are aborted when the SDK supports it; otherwise they are
// allowed bounded completion. No provider is retried within one request.

import type {
  MarketDataEnvelope,
  ProviderName,
} from "./market-data-types";
import {
  ensureProvidersRegistered,
  getProvider,
  toProviderHealthType,
} from "./market-data-service";
import { providerHealth } from "./provider-health";
import { isBSEIndex } from "@/lib/bse-api";
import { getCurrentSession } from "@/lib/market-session";
import { isSameExpiry, toIsoDate } from "@/lib/data-layer/chains/option-chain";

// ── Canonical shape every provider is normalised to ────────────────────────

export interface ChainLeg {
  ltp: number;
  oi: number;
  oiChg: number;
  volume: number;
  iv: number;
  bid?: number | null;
  ask?: number | null;
}

export interface CanonicalStrike {
  strike: number;
  ce: ChainLeg | null;
  pe: ChainLeg | null;
}

export interface CanonicalChain {
  symbol: string;
  exchange: string;
  strikes: CanonicalStrike[];
  spotPrice: number;
  expiry: string | null;          // normalised ISO (YYYY-MM-DD) or null
  providerTimestamp?: string | null;
  source: ProviderName;
  fetchedAt: string;
}

interface ProviderAttempt {
  name: ProviderName;
  status: "valid" | "invalid" | "no-data" | "error" | "circuit_open" | "not_registered";
  latencyMs: number;
  canonical: CanonicalChain | null;
  error: string | null;
}

export interface OptionChainRaceOpts {
  symbol: string;
  exchange?: string;          // "NSE" | "BSE" (derived from symbol when omitted)
  expiry?: string;            // requested expiry, ISO YYYY-MM-DD
  nowMs?: number;
  shadow?: boolean;           // true: wait for all providers (complete report)
  providers?: ProviderName[]; // override the default provider list (e.g. off-hours: no broker feeds)
}

export interface OptionChainRaceResult {
  winner: CanonicalChain | null;
  winnerProvider: ProviderName | null;
  firstValidMs: number | null;    // when the first valid answer arrived
  resolvedMs: number;             // when the race resolved
  attempts: ProviderAttempt[];
  source: ProviderName | "NO_DATA";
  fallbackUsed: boolean;
}

const OPTION_CHAIN_PROVIDERS: ProviderName[] = [
  "icici-breeze",
  "motilal-api",
  "nse-api",
  "bse-api",
];

const RACE_TIMEOUT_MS: Record<ProviderName, number> = {
  "icici-breeze": 6000,
  "motilal-api": 8000,
  "nse-api": 8000,
  "bse-api": 8000,
};

const MIN_STRIKES = 3;

function numOrNull(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function legFrom(l: any): ChainLeg {
  return {
    ltp: numOrNull(l?.ltp) ?? 0,
    oi: numOrNull(l?.oi) ?? 0,
    oiChg: numOrNull(l?.oiChg) ?? 0,
    volume: numOrNull(l?.volume) ?? 0,
    iv: numOrNull(l?.iv) ?? 0,
    bid: numOrNull(l?.bid),
    ask: numOrNull(l?.ask),
  };
}

/** Normalise one provider's envelope into the canonical chain shape. */
export function toCanonical(
  result: { data?: any; providerTimestamp?: string } | null,
  source: ProviderName,
): CanonicalChain | null {
  if (!result || !result.data) return null;
  const d: any = result.data;
  if (!Array.isArray(d.strikes) || !d.strikes.length) return null;
  const strikes: CanonicalStrike[] = d.strikes
    .map((s: any) => ({
      strike: Number(s.strike),
      ce: s.ce ? legFrom(s.ce) : null,
      pe: s.pe ? legFrom(s.pe) : null,
    }))
    .filter((s: any) => Number.isFinite(s.strike));
  if (!strikes.length) return null;
  return {
    symbol: "",              // filled in by the caller
    exchange: "",
    strikes,
    spotPrice: Number(d.spotPrice) || 0,
    expiry: d.selectedExpiry || d.expiry || null,
    providerTimestamp: result.providerTimestamp ?? null,
    source,
    fetchedAt: new Date().toISOString(),
  };
}

/** Strict validation: a chain is eligible only when it is complete and sane. */
export function validateCanonicalChain(
  c: CanonicalChain | null,
  opts: { symbol: string; exchange?: string; expiry?: string },
): CanonicalChain | null {
  if (!c) return null;
  const { strikes, spotPrice } = c;
  if (!strikes || strikes.length < MIN_STRIKES) return null;
  if (!(spotPrice > 0)) return null;
  // At least one strike must carry live quotes on BOTH legs — an all-call or
  // all-put chain is not a usable option chain.
  const bothLegs = strikes.filter(
    (s) => s.ce && s.pe && s.ce.ltp > 0 && s.pe.ltp > 0,
  );
  if (bothLegs.length === 0) return null;
  // Every present leg must be sane (never negative, never fabricated).
  for (const s of strikes) {
    for (const leg of [s.ce, s.pe]) {
      if (!leg) continue;
      if (leg.ltp < 0 || leg.oi < 0 || leg.volume < 0 || leg.iv < 0)
        return null;
    }
  }
  // Expiry must match the request when one was made.
  if (opts.expiry && c.expiry) {
    const cIso = toIsoDate(c.expiry);
    if (cIso && !isSameExpiry(cIso, opts.expiry)) return null;
  }
  return c;
}

// ── The race ───────────────────────────────────────────────────────────────

export async function runOptionChainRace(
  opts: OptionChainRaceOpts,
): Promise<OptionChainRaceResult> {
  await ensureProvidersRegistered();
  const nowMs = opts.nowMs ?? Date.now();
  const t0 = Date.now();
  const attempts = new Map<ProviderName, ProviderAttempt>();
  let winner: CanonicalChain | null = null;
  let winnerProvider: ProviderName | null = null;
  let firstValidMs: number | null = null;
  let resolved = false;
  let settledCount = 0;
  const effectiveProviders = (opts.providers ?? OPTION_CHAIN_PROVIDERS).filter((name) => {
    const p = getProvider(name);
    return Boolean(p && p.categories?.includes("option-chain"));
  });
  const total = effectiveProviders.length;

  const symbol = opts.symbol.toUpperCase();
  const exchange = opts.exchange || (isBSEIndexSymbol(symbol) ? "BSE" : "NSE");

  const expiryIso = opts.expiry ? toIsoDate(opts.expiry) : null;

  const resultOf = (): OptionChainRaceResult => ({
    winner,
    winnerProvider,
    firstValidMs,
    resolvedMs: Date.now() - t0,
    attempts: [...attempts.values()],
    source: winnerProvider ?? "NO_DATA",
    fallbackUsed: winnerProvider ? true : false,
  });

  let raceResolve!: (v: OptionChainRaceResult) => void;
  const racePromise = new Promise<OptionChainRaceResult>((res) => {
    raceResolve = res;
  });

  const onSettle = (name: ProviderName, attempt: ProviderAttempt) => {
    attempts.set(name, attempt);
    settledCount += 1;
    if (!winner && attempt.status === "valid" && attempt.canonical) {
      const c = attempt.canonical;
      c.symbol = symbol;
      c.exchange = exchange;
      c.fetchedAt = new Date(nowMs).toISOString();
      winner = c;
      winnerProvider = name;
      firstValidMs = Date.now() - t0;
    }
    const shouldResolve = opts.shadow ? settledCount >= total : Boolean(winner || settledCount >= total);
    if (shouldResolve) raceResolve(resultOf());
  };

  for (const name of effectiveProviders) {
    const provider = getProvider(name);
    if (
      !provider ||
      !provider.categories?.includes("option-chain")
    ) {
      attempts.set(name, {
        name,
        status: "not_registered",
        latencyMs: 0,
        canonical: null,
        error: null,
      });
      settledCount += 1;
      if (settledCount >= total && !winner) raceResolve(resultOf());
      continue;
    }

    // Circuit-breaker: skip unhealthy providers, record the reason.
    const phType = toProviderHealthType(name);
    if (providerHealth.shouldSkip(phType)) {
      attempts.set(name, {
        name,
        status: "circuit_open",
        latencyMs: 0,
        canonical: null,
        error: "circuit breaker open",
      });
      settledCount += 1;
      if (settledCount >= total && !winner) raceResolve(resultOf());
      continue;
    }

    (async () => {
      const ctrl = new AbortController();
      const start = Date.now();
      try {
        const env = await Promise.race([
          provider.fetch({
            symbol,
            category: "option-chain",
            exchange,
            instrument: undefined,
            expiry: expiryIso,
            nowMs,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("TIMEOUT")), RACE_TIMEOUT_MS[name]),
          ),
        ]);
        const latency = Date.now() - start;
        const canonical = toCanonical(env, name);
        const valid = Boolean(
          canonical && validateCanonicalChain(canonical, { symbol, exchange, expiry: expiryIso }),
        );
        onSettle(name, {
          name,
          status: valid ? "valid" : canonical ? "invalid" : "no-data",
          latencyMs: latency,
          canonical: valid ? canonical : null,
          error: null,
        });
        // Abort losing providers when supported (bounded completion otherwise).
        if (winner && winnerProvider !== name) {
          try {
            ctrl.abort();
          } catch {
            /* underlying SDK call may keep running — bounded by its own timeout */
          }
        }
      } catch (e) {
        onSettle(name, {
          name,
          status: "error",
          latencyMs: Date.now() - start,
          canonical: null,
          error: String(e?.message || e).slice(0, 200),
        });
      } finally {
        // noop
      }
    })();
  }

  return racePromise;
}

function isBSEIndexSymbol(symbol: string): boolean {
  const bse = ["SENSEX", "BANKEX", "BSESENSEX"];
  return bse.includes(symbol.toUpperCase());
}

// ── Shadow-mode comparison state ───────────────────────────────────────────

export interface ChainSummary {
  provider: string | null;
  strikes: number;
  spotPrice: number | null;
  expiry: string | null;
  providerTimestamp: string | null;
  bothLegStrikes: number;
}

export interface ShadowParity {
  sameProvider: boolean;
  sameStrikeCount: boolean;
  sameSpot: boolean;
  sameExpiry: boolean;
  strikeCountDiff: number;
  spotDiff: number | null;
  perStrikeDiffs: Array<{
    strike: number;
    ceLtpDiff: number | null;
    peLtpDiff: number | null;
    ceOiDiff: number | null;
    peOiDiff: number | null;
    ceVolDiff: number | null;
    peVolDiff: number | null;
  }>;
  timestampDiffMs: number | null;
  oldFreshness: string | null;
  newFreshness: string | null;
}

export interface ShadowComparison {
  key: string;
  symbol: string;
  exchange: string;
  expiry: string | null;
  requestedExpiry: string | null;
  old: ChainSummary | null;
  new: ChainSummary | null;
  parity: ShadowParity;
  rejected: Array<{ provider: string; reason: string }>;
  ts: string;
}

const shadowState = new Map<string, ShadowComparison>();

function chainSummary(c: CanonicalChain | null, provider: string | null): ChainSummary {
  if (!c) return { provider, strikes: 0, spotPrice: null, expiry: null, providerTimestamp: null, bothLegStrikes: 0 };
  const both = c.strikes.filter((s) => s.ce && s.pe && s.ce.ltp > 0 && s.pe.ltp > 0).length;
  return {
    provider,
    strikes: c.strikes.length,
    spotPrice: c.spotPrice || null,
    expiry: c.expiry,
    providerTimestamp: c.providerTimestamp ?? null,
    bothLegStrikes: both,
  };
}

export function compareChains(
  old: CanonicalChain | null,
  neu: CanonicalChain | null,
): ShadowParity {
  const os = chainSummary(old, old?.source ?? null);
  const ns = chainSummary(neu, neu?.source ?? null);
  const perStrike: ShadowParity["perStrikeDiffs"] = [];
  if (old && neu) {
    const oByStrike = new Map(old.strikes.map((s) => [s.strike, s]));
    const nByStrike = new Map(neu.strikes.map((s) => [s.strike, s]));
    const all = new Set([...oByStrike.keys(), ...nByStrike.keys()]);
    for (const strike of [...all].sort((a, b) => a - b)) {
      const o = oByStrike.get(strike);
      const n = nByStrike.get(strike);
      const diff = (a: ChainLeg | null, b: ChainLeg | null) => {
        if (!a && !b) return null;
        if (!a || !b) return null;
        return (b.ltp - a.ltp);
      };
      perStrike.push({
        strike,
        ceLtpDiff: diff(o?.ce ?? null, n?.ce ?? null),
        peLtpDiff: diff(o?.pe ?? null, n?.pe ?? null),
        ceOiDiff: (o?.ce && n?.ce) ? n.ce.oi - o.ce.oi : null,
        peOiDiff: (o?.pe && n?.pe) ? n.pe.oi - o.pe.oi : null,
        ceVolDiff: (o?.ce && n?.ce) ? n.ce.volume - o.ce.volume : null,
        peVolDiff: (o?.pe && n?.pe) ? n.pe.volume - o.pe.volume : null,
      });
    }
  }
  const oldTs = old?.providerTimestamp ? new Date(old.providerTimestamp).getTime() : null;
  const newTs = neu?.providerTimestamp ? new Date(neu.providerTimestamp).getTime() : null;
  return {
    sameProvider: Boolean(old && neu && old.source === neu.source),
    sameStrikeCount: os.strikes === ns.strikes,
    sameSpot: Boolean(os.spotPrice && ns.spotPrice && os.spotPrice === ns.spotPrice),
    sameExpiry: Boolean(os.expiry && ns.expiry && os.expiry === ns.expiry),
    strikeCountDiff: ns.strikes - os.strikes,
    spotDiff: os.spotPrice != null && ns.spotPrice != null ? ns.spotPrice - os.spotPrice : null,
    perStrikeDiffs: perStrike,
    timestampDiffMs: oldTs != null && newTs != null ? newTs - oldTs : null,
    oldFreshness: old ? (old.providerTimestamp ? "dated" : "undated") : null,
    newFreshness: neu ? (neu.providerTimestamp ? "dated" : "undated") : null,
  };
}

export async function runShadowComparison(
  opts: OptionChainRaceOpts,
  oldChain: CanonicalChain | null,
  rejected: Array<{ provider: string; reason: string }>,
): Promise<ShadowComparison> {
  const symbol = opts.symbol.toUpperCase();
  const exchange = opts.exchange || (isBSEIndexSymbol(symbol) ? "BSE" : "NSE");
  const expiryIso = opts.expiry ? toIsoDate(opts.expiry) : null;
  const key = `${symbol}|${exchange}|${expiryIso ?? "nearest"}`;

  // Shadow mode waits for ALL providers → complete comparison report.
  const race = await runOptionChainRace({ ...opts, shadow: true });

  const comparison: ShadowComparison = {
    key,
    symbol,
    exchange,
    expiry: expiryIso,
    requestedExpiry: opts.expiry ?? null,
    old: chainSummary(oldChain, oldChain?.source ?? null),
    new: chainSummary(race.winner, race.winnerProvider ?? null),
    parity: compareChains(oldChain, race.winner),
    rejected,
    ts: new Date(opts.nowMs ?? Date.now()).toISOString(),
  };
  shadowState.set(key, comparison);
  return comparison;
}

export function getShadowComparison(symbol: string, expiry?: string): ShadowComparison | null {
  const key = `${symbol.toUpperCase()}|${expiry ? toIsoDate(expiry) : "nearest"}`;
  return shadowState.get(key) ?? null;
}

export function getShadowComparisons(): ShadowComparison[] {
  return [...shadowState.values()];
}

export function clearShadowComparisons(): void {
  shadowState.clear();
}

const timeoutMs = (ms: number): Promise<never> =>
  new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), ms));

/** Replicate the production route's sequential provider tree (NSE → BSE → MO → Breeze → canonical)
 *  using the engine adapters, so the old path produces canonical chains comparable to the race.
 *  SHADOW ONLY — the production route is untouched.
 */
export async function runLegacyOptionChain(
  opts: OptionChainRaceOpts,
): Promise<{
  chain: CanonicalChain | null;
  rejected: Array<{ provider: string; reason: string; latencyMs: number }>;
}> {
  const rejected: Array<{ provider: string; reason: string; latencyMs: number }> = [];
  const symbol = opts.symbol.toUpperCase();
  const exchange = opts.exchange || (isBSEIndexSymbol(symbol) ? "BSE" : "NSE");
  const expiryIso = opts.expiry ? toIsoDate(opts.expiry) : null;
  const nowMs = opts.nowMs ?? Date.now();
  const offHours = !getCurrentSession("index").isMarketOpen;

  // Populate the provider registry (side-effect import of market-data-providers)
  // so the legacy tree can actually try NSE / MO / Breeze — mirroring what the
  // production route does on first request.
  await ensureProvidersRegistered();

  const tryProvider = async (
    name: ProviderName,
    timeout: number,
    gate: () => boolean,
  ): Promise<CanonicalChain | null> => {
    const t0 = Date.now();
    if (!gate()) {
      rejected.push({ provider: name, reason: "gated", latencyMs: 0 });
      return null;
    }
    const provider = getProvider(name);
    if (!provider || !provider.categories?.includes("option-chain")) {
      rejected.push({ provider: name, reason: "not_registered", latencyMs: 0 });
      return null;
    }
    const phType = toProviderHealthType(name);
    if (providerHealth.shouldSkip(phType)) {
      rejected.push({ provider: name, reason: "circuit_open", latencyMs: 0 });
      return null;
    }
    try {
      const env = await Promise.race([
        provider.fetch({
          symbol,
          category: "option-chain",
          exchange,
          instrument: undefined,
          expiry: expiryIso,
          nowMs,
        }),
        timeoutMs(timeout),
      ]);
      const latency = Date.now() - t0;
      const c = validateCanonicalChain(toCanonical(env, name), {
        symbol,
        exchange,
        expiry: expiryIso,
      });
      if (!c) rejected.push({ provider: name, reason: "invalid_chain", latencyMs: latency });
      return c ?? null;
    } catch (e) {
      rejected.push({
        provider: name,
        reason: `error:${String(e?.message || e).slice(0, 120)}`,
        latencyMs: Date.now() - t0,
      });
      return null;
    }
  };

  // 1. NSE primary — NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY + NSE equities
  let chain = await tryProvider("nse-api", 7000, () => true);
  if (chain) return { chain, rejected };

  // 2. BSE primary — SENSEX/BANKEX only
  if (exchange === "BSE") {
    chain = await tryProvider("bse-api", 5000, () => true);
    if (chain) return { chain, rejected };
  }

  // 3. MOAPI fallback — only when market is open and the MO circuit is closed
  chain = await tryProvider("motilal-api", 10000, () => !offHours && !providerHealth.shouldSkip("moapi"));
  if (chain) return { chain, rejected };

  // 4. Breeze opt-in last resort — bounded 7 s
  chain = await tryProvider("icici-breeze", 7000, () => !providerHealth.shouldSkip("breeze"));
  if (chain) return { chain, rejected };

  // 5. Canonical exchange-aware last resort (data-layer incl. bhavcopy EOD)
  try {
    const { getOptionChain: canonicalChain } = await import(
      "@/lib/data-layer/chains/option-chain"
    );
    const canon = await canonicalChain(symbol, expiryIso ?? undefined);
    if (canon?.data) {
      const strikes: CanonicalStrike[] = canon.data.strikes.map((s: any) => ({
        strike: Number(s.strike),
        ce: s.ce
          ? {
              ltp: numOrNull(s.ce.ltp) ?? 0,
              oi: numOrNull(s.ce.oi) ?? 0,
              oiChg: numOrNull(s.ce.oiChg) ?? 0,
              volume: numOrNull(s.ce.volume) ?? 0,
              iv: numOrNull(s.ce.iv) ?? 0,
              bid: numOrNull(s.ce.bid),
              ask: numOrNull(s.ce.ask),
            }
          : null,
        pe: s.pe
          ? {
              ltp: numOrNull(s.pe.ltp) ?? 0,
              oi: numOrNull(s.pe.oi) ?? 0,
              oiChg: numOrNull(s.pe.oiChg) ?? 0,
              volume: numOrNull(s.pe.volume) ?? 0,
              iv: numOrNull(s.pe.iv) ?? 0,
              bid: numOrNull(s.pe.bid),
              ask: numOrNull(s.pe.ask),
            }
          : null,
      }));
      const c: CanonicalChain = {
        symbol,
        exchange,
        strikes,
        spotPrice: Number(canon.data.spot) || 0,
        expiry: canon.data.expiry ?? null,
        providerTimestamp: canon.data.asOf ?? null,
        source: "data-layer",
        fetchedAt: new Date(nowMs).toISOString(),
      };
      const vc = validateCanonicalChain(c, { symbol, exchange, expiry: expiryIso });
      if (vc) return { chain: vc, rejected };
    }
  } catch {
    /* canonical last resort unavailable */
  }

  return { chain: null, rejected };
}
