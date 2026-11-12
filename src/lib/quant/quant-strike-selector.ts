// quant-strike-selector.ts — deterministic option contract selection for the
// quant engine (BUY side only — never a SELL_CE/SELL_PE candidate).
//
// ISOLATION: reads the canonical option chain; resolves lot/tick via the
// fail-closed symbol master. No orders, no network beyond the chain passed in.
//
// Rules (all enforced; every failure produces a rejectionReason):
//   1. direction must be BUY_CE/BUY_PE
//   2. lot size via getLotSizeStrict — null → reject "unknown lot size"
//   3. chain.spot must be a valid positive number
//   4. expiry must parse and parseExpiryToYears > 0 (valid & not expired)
//   5. candidate strikes = ATM ± 2 (5 nearest to spot, distance-ordered)
//   6. per-leg gates: ltp ≥ minPremium; ltp ≤ maxPremiumPctOfSpot×spot;
//      bid+ask present else reject leg "no bid/ask";
//      spreadPct = (ask−bid)/mid ≤ maxSpreadPctOfPremium;
//      oi ≥ minChainLiquidityOi; |delta| within [0.30, 0.60] — leg delta
//      first, else calculateGreeks with leg IV (chain IV is PERCENT → /100),
//      else impliedVolFromPremium fallback; still unknown → reject
//      "greeks unavailable"
//   7. objective (maximize): deltaBandFit×40 + liquidityScore×30 +
//      spreadScore×30 where deltaBandFit = max(0, 1 − ||delta|−0.45|/0.15),
//      liquidityScore = min(1, oi/(minOi×5)), spreadScore = max(0, 1 −
//      spreadPct/maxSpreadPct). Ties break on nearest ATM, then lower strike.
//   8. tradingsymbol: provider's when present, else constructed
//      `${symbol}${DDMMMYY}${strike}${CE|PE}` (MO/NSE F&O style). Unparseable
//      expiry → tradingsymbol null (never guessed).

import {
  calculateGreeks,
  impliedVolFromPremium,
  parseExpiryToYears,
} from "@/lib/greeks";
import { getLotSizeStrict, getTickSize, roundToTick } from "@/lib/symbol-config";
import { parseExpiryParts, type CanonicalOptionChain } from "@/lib/data-layer/chains/option-chain";
import { QUANT_FLAGS } from "./quant-config";
import type { QuantContractSelection, QuantFeatures, QuantPlan } from "./quant-types";

const DELTA_BAND = { MIN: 0.3, MAX: 0.6, CENTER: 0.45 } as const;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function rejected(reason: string, more: string[]): QuantContractSelection {
  return {
    tradingsymbol: null, strike: null, optionType: null, expiry: null,
    lotSize: null, tickSize: null, premium: null, bid: null, ask: null,
    spreadPct: null, iv: null, delta: null, theta: null, oi: null,
    selectionReasons: [...more, reason],
    rejected: true,
    rejectionReason: more.length ? `${reason} (${more.join("; ")})` : reason,
  };
}

/** "27-Oct-2026" → "27OCT26"; null when unparseable. */
export function expiryCompact(expiry: string | null | undefined): string | null {
  const p = parseExpiryParts(expiry ?? null);
  if (!p) return null;
  return `${String(p.d).padStart(2, "0")}${MONTHS[p.m]}${String(p.y).slice(-2)}`;
}

/** NSE/MO F&O style tradingsymbol, e.g. NIFTY27OCT2625000CE. */
export function buildTradingsymbol(
  symbol: string,
  expiry: string | null | undefined,
  strike: number,
  optionType: "CE" | "PE",
): string | null {
  const compact = expiryCompact(expiry);
  if (!compact) return null;
  const strikeStr = Number.isInteger(strike) ? String(strike) : String(strike);
  return `${symbol.toUpperCase()}${compact}${strikeStr}${optionType}`;
}

export interface SelectContractInput {
  symbol: string;
  direction: "BUY_CE" | "BUY_PE" | "BUY" | "SELL";
  chain: CanonicalOptionChain | null;
  features?: QuantFeatures | null;
  plan?: QuantPlan | null; // reserved for premium-fit tiebreaks (Phase B) — not a filter
  expiry?: string | null;
  /** Engine clock — expiry validation must use it, never the real clock
   *  (tests pin NOW; a real-clock read made pinned fixtures "expired"). */
  nowMs?: number;
}

export function selectContract(input: SelectContractInput): QuantContractSelection {
  const { symbol, direction, chain } = input;
  if (direction !== "BUY_CE" && direction !== "BUY_PE") {
    return rejected(`direction ${direction} is not an option BUY — never selected`, []);
  }

  const lotSize = getLotSizeStrict(symbol);
  if (lotSize == null) return rejected("unknown lot size (fail closed)", []);
  const tickSize = getTickSize(symbol);

  if (!chain) return rejected("no option chain available", []);
  const spot = chain.spot;
  if (!finite(spot) || spot <= 0) return rejected("chain spot invalid or missing", []);

  const expiry = input.expiry ?? chain.expiry ?? null;
  const tYears = expiry ? parseExpiryToYears(expiry, new Date(input.nowMs ?? Date.now())) : null;
  if (expiry == null || tYears == null || tYears <= 0) {
    return rejected("expiry invalid or expired", []);
  }

  const strikes = (chain.strikes ?? []).filter((s) => finite(s.strike));
  if (strikes.length === 0) return rejected("chain has no strikes", []);

  const candidates = [...strikes]
    .sort((a, b) => {
      const da = Math.abs(a.strike - spot!);
      const db = Math.abs(b.strike - spot!);
      if (da !== db) return da - db;
      return a.strike - b.strike;
    })
    .slice(0, 5);

  const optionType: "CE" | "PE" = direction === "BUY_CE" ? "CE" : "PE";
  const isCall = optionType === "CE";
  const scanned: string[] = [`scanned ${candidates.length} strikes (ATM ± 2) around spot ${spot}`];
  const legRejections: string[] = [];
  let best: {
    strike: number; distance: number; premium: number; bid: number; ask: number;
    spreadPct: number; iv: number | null; delta: number; theta: number | null; oi: number;
    score: number; reasons: string[];
  } | null = null;

  for (const s of candidates) {
    const leg = isCall ? s.ce : s.pe;
    const distance = Math.abs(s.strike - spot!);
    if (!leg) {
      legRejections.push(`strike ${s.strike}: no ${optionType} leg`);
      continue;
    }
    const premium = leg.ltp;
    if (!finite(premium) || premium <= 0) {
      legRejections.push(`strike ${s.strike}: no ltp`);
      continue;
    }
    if (premium < QUANT_FLAGS.minPremium) {
      legRejections.push(`strike ${s.strike}: premium ${premium} below floor ${QUANT_FLAGS.minPremium}`);
      continue;
    }
    if (premium > QUANT_FLAGS.maxPremiumPctOfSpot * spot!) {
      legRejections.push(`strike ${s.strike}: premium ${premium} exceeds ${QUANT_FLAGS.maxPremiumPctOfSpot * 100}% of spot`);
      continue;
    }
    if (!finite(leg.bid) || !finite(leg.ask) || leg.bid <= 0 || leg.ask <= 0) {
      legRejections.push(`strike ${s.strike}: no bid/ask (ltp ${premium} only)`);
      continue;
    }
    const mid = (leg.bid + leg.ask) / 2;
    const spreadPct = mid > 0 ? (leg.ask - leg.bid) / mid : null;
    if (spreadPct == null || spreadPct < 0 || spreadPct > QUANT_FLAGS.maxSpreadPctOfPremium) {
      legRejections.push(`strike ${s.strike}: spread ${(spreadPct ?? 1) * 100}% beyond ${(QUANT_FLAGS.maxSpreadPctOfPremium * 100).toFixed(0)}% cap`);
      continue;
    }
    if (!finite(leg.oi) || leg.oi < QUANT_FLAGS.minChainLiquidityOi) {
      legRejections.push(`strike ${s.strike}: oi ${leg.oi ?? "n/a"} below ${QUANT_FLAGS.minChainLiquidityOi}`);
      continue;
    }

    // Delta: leg value first, else BS greeks from chain IV (percent), else IV from premium.
    let delta: number | null = finite(leg.delta) && leg.delta !== 0 ? Math.abs(leg.delta) : null;
    let iv: number | null = finite(leg.iv) && leg.iv > 0 ? leg.iv / 100 : null;
    let theta: number | null = finite(leg.theta) ? leg.theta : null;
    if (delta == null) {
      let greeksIv = iv;
      if (greeksIv == null && finite(premium)) {
        greeksIv = impliedVolFromPremium(premium, spot!, s.strike, tYears, isCall);
        if (greeksIv != null) iv = greeksIv;
      }
      if (greeksIv != null) {
        const g = calculateGreeks(spot!, s.strike, tYears, greeksIv, isCall);
        if (g.delta !== 0) {
          delta = Math.abs(g.delta);
          if (theta == null) theta = g.theta;
        }
      }
      if (delta == null) {
        legRejections.push(`strike ${s.strike}: greeks unavailable`);
        continue;
      }
    }
    if (delta < DELTA_BAND.MIN || delta > DELTA_BAND.MAX) {
      legRejections.push(`strike ${s.strike}: delta ${delta} outside [${DELTA_BAND.MIN}, ${DELTA_BAND.MAX}]`);
      continue;
    }

    const deltaBandFit = Math.max(0, 1 - Math.abs(delta - DELTA_BAND.CENTER) / 0.15);
    const liquidityScore = Math.min(1, leg.oi / (QUANT_FLAGS.minChainLiquidityOi * 5));
    const spreadScore = Math.max(0, 1 - spreadPct / QUANT_FLAGS.maxSpreadPctOfPremium);
    const score = deltaBandFit * 40 + liquidityScore * 30 + spreadScore * 30;

    const candidate = {
      strike: s.strike, distance, premium: roundToTick(premium, tickSize),
      bid: leg.bid, ask: leg.ask, spreadPct, iv, delta, theta, oi: leg.oi,
      score, reasons: [
        `strike ${s.strike} (distance ${distance}), premium ${roundToTick(premium, tickSize)}`,
        `delta ${delta} in band, oi ${leg.oi}, spreadPct ${(spreadPct * 100).toFixed(1)}%`,
        `score ${score.toFixed(1)} = deltaFit ${(deltaBandFit * 40).toFixed(1)} + liquidity ${(liquidityScore * 30).toFixed(1)} + spread ${(spreadScore * 30).toFixed(1)}`,
      ],
    };
    if (
      best == null ||
      candidate.score > best.score + 1e-9 ||
      (Math.abs(candidate.score - best.score) <= 1e-9 && candidate.distance < best.distance) ||
      (Math.abs(candidate.score - best.score) <= 1e-9 && candidate.distance === best.distance && candidate.strike < best.strike)
    ) {
      best = candidate;
    }
  }

  if (!best) {
    const unique = Array.from(new Set(legRejections));
    return rejected(
      `no candidate strike passed the entry gates (${unique.length} leg rejection${unique.length === 1 ? "" : "s"})`,
      [...scanned, ...unique.slice(0, 8)],
    );
  }

  return {
    tradingsymbol: buildTradingsymbol(symbol, expiry, best.strike, optionType),
    strike: best.strike,
    optionType,
    expiry,
    lotSize,
    tickSize,
    premium: best.premium,
    bid: best.bid,
    ask: best.ask,
    spreadPct: best.spreadPct,
    iv: ivPct(best.iv),
    delta: best.delta,
    theta: best.theta,
    oi: best.oi,
    selectionReasons: [...scanned, ...best.reasons],
  };
}

/** iv stored internally as decimal; reported in percent (null-safe). */
function ivPct(ivDecimal: number | null): number | null {
  return ivDecimal == null ? null : Math.round(ivDecimal * 10000) / 100;
}
