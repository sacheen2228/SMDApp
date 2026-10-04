// ═══════════════════════════════════════════════════════════════════════════
// Challenge Engine — ₹15K → ₹1L Orchestrator
// FIXED: R:R variation, scanner counts, multi-factor scoring
// ═══════════════════════════════════════════════════════════════════════════

import { fetchNifty500Batch, getSectorStrength, type Nifty500Quote } from "./nifty500";
import {
  calculateEquityPosition,
  calculateFOPosition,
  fetchLiveLotSizes,
  getLotSize,
  type CapitalConfig,
  DEFAULT_CAPITAL_CONFIG,
} from "./capital-manager";
import {
  getChallenge,
  recordTrade,
} from "./challenge-tracker";
import { bsPrice, impliedVolFromPremium, parseExpiryDate, parseExpiryToYears, roundPremium, OPTION_STOP_PCT } from "@/lib/greeks";

// Back-compat re-exports — impls moved to the greeks leaf module (cycle-free);
// existing importers (auto-executor, tests) keep their import paths.
export { parseExpiryDate, parseExpiryToYears, OPTION_STOP_PCT } from "@/lib/greeks";
import { buildMarketIntelligenceContext, type MarketIntelligenceContext } from "@/lib/trade-intelligence/market-context";
import { analyzeEquitySwing } from "@/lib/trade-intelligence/equity-swing-mode";
import { analyzeStockFO } from "@/lib/trade-intelligence/stock-fo-mode";
import { analyzeIndexFO } from "@/lib/trade-intelligence/index-fo-mode";
import { roundToTick, getTickSize } from "@/lib/symbol-config";
import { getCurrentSession } from "@/lib/market-session";

// ── Types ──
export type TradeDecision = "TRADE" | "WATCH" | "NO_TRADE";
export type InstrumentType = "EQUITY" | "CALL" | "PUT" | "FUTURES" | "STRADDLE" | "STRANGLE" | "CAS" | "HERO_ZERO";

/**
 * Dedupe per (symbol, instrument-kind): an option setup is never erased by a
 * higher-scoring equity/futures setup on the same symbol, and CALL/PUT stay
 * distinct; only true duplicates (same symbol + same kind) collapse to the
 * higher score. Previously keyed by symbol alone → option setups silently
 * dropped from the Challenge tab.
 */
export function dedupeOpportunities(
  opps: ChallengeOpportunity[]
): ChallengeOpportunity[] {
  const OPTION_INSTRUMENTS = new Set<InstrumentType>([
    "CALL", "PUT", "STRADDLE", "STRANGLE", "CAS", "HERO_ZERO",
  ]);
  const map = new Map<string, ChallengeOpportunity>();
  for (const opp of opps) {
    const kind = OPTION_INSTRUMENTS.has(opp.instrument) ? opp.instrument : "BASE";
    const key = `${opp.symbol}|${kind}`;
    const existing = map.get(key);
    if (!existing || opp.score > existing.score) {
      map.set(key, opp);
    }
  }
  return Array.from(map.values());
}

// ── Option setups: spot space → PREMIUM space (playbook repricing) ──
export type PremiumConvertResult = { ok: true } | { ok: false; reason: string };

/**
 * Convert a CALL/PUT opportunity from spot-based levels to premium-based
 * levels: entry = live ATM premium, SL/TP = Black-Scholes re-price of the
 * spot SL/TP at the IV implied by that live premium (playbook: "repriced
 * stop premium, not a flat guess"). Spot levels are preserved on
 * spotEntry/spotStopLoss/spotTarget1/spotTarget2 for display and the
 * validator. Fails cleanly (never fabricates) when chain premium, strike or
 * expiry is missing.
 */
export function convertOptionToPremiumTerms(
  opp: ChallengeOpportunity,
  now: Date = new Date(),
): PremiumConvertResult {
  if (opp.instrument !== "CALL" && opp.instrument !== "PUT") {
    return { ok: false, reason: `Not an option instrument: ${opp.instrument}` };
  }
  const isCall = opp.instrument === "CALL";
  const spotEntry = opp.data?.ltp || opp.entry;
  const spotSL = opp.stopLoss;
  const spotT1 = opp.target1;
  const spotT2 = opp.target2;
  const premium = opp.premium ?? 0;
  const strike = opp.strike ?? 0;

  if (!(premium > 0)) {
    return { ok: false, reason: "No live option premium from chain — cannot size honestly" };
  }
  if (!(strike > 0)) {
    return { ok: false, reason: "No strike from chain — cannot size honestly" };
  }
  const tte = parseExpiryToYears(opp.expiry, now);
  if (tte === null) {
    return { ok: false, reason: `Missing/unparseable expiry: ${opp.expiry || "none"}` };
  }
  const iv = impliedVolFromPremium(premium, spotEntry, strike, tte, isCall);
  if (iv === null) {
    return { ok: false, reason: "IV inversion from live premium failed" };
  }

  const entryPremium = roundPremium(premium);
  const bsSl = roundPremium(bsPrice(spotSL, strike, tte, iv, isCall));
  // Tighten stops wider than 10% of premium (never widen a tighter engine stop)
  const minStopPremium = roundPremium(entryPremium * (1 - OPTION_STOP_PCT));
  const slPremium = Math.max(bsSl, minStopPremium);
  const t1Premium = roundPremium(bsPrice(spotT1, strike, tte, iv, isCall));
  const t2Premium = roundPremium(bsPrice(spotT2, strike, tte, iv, isCall));

  // Sanity: long option — stop must reprice BELOW entry, target ABOVE.
  if (!(slPremium < entryPremium)) {
    return { ok: false, reason: "Repriced stop not below entry — invalid option setup" };
  }
  if (!(t1Premium > entryPremium)) {
    return { ok: false, reason: "Repriced target not above entry — invalid option setup" };
  }

  opp.spotEntry = spotEntry;
  opp.spotStopLoss = spotSL;
  opp.spotTarget1 = spotT1;
  opp.spotTarget2 = spotT2;
  opp.entry = entryPremium;
  opp.stopLoss = slPremium;
  opp.target1 = t1Premium;
  opp.target2 = Math.max(t2Premium, t1Premium);
  const risk = opp.entry - opp.stopLoss;
  const reward = opp.target1 - opp.entry;
  opp.riskReward = risk > 0 ? Math.round((reward / risk) * 10) / 10 : 0;
  return { ok: true };
}

// ── Size EVERY setup (was: best trade only) ──
/**
 * Attach a real position (lots × live lot size × premium) to one opportunity.
 * Options sized in premium space with isOption=true; equity as before;
 * futures per lot. On failure: tradeable=false + honest reason appended —
 * never a fabricated quantity.
 */
export function sizeOpportunity(
  opp: ChallengeOpportunity,
  capital: number,
  config: CapitalConfig = DEFAULT_CAPITAL_CONFIG,
): void {
  const isOption = opp.instrument === "CALL" || opp.instrument === "PUT";
  const pos = opp.instrument === "EQUITY"
    ? calculateEquityPosition(capital, opp.entry, opp.stopLoss, config)
    : calculateFOPosition(capital, opp.entry, opp.stopLoss, opp.symbol, isOption, config);
  opp.position = pos;
  if (!pos.canTrade) {
    opp.tradeable = false;
    const reason = `Position sizing: ${pos.reason || "cannot size"}`;
    if (!opp.blockedReasons.includes(reason)) opp.blockedReasons.push(reason);
  }
}

// ── Options-first ranking for small challenge capital ──
const HOISTED_INSTRUMENTS = new Set<InstrumentType>(["CALL", "PUT"]);

/**
 * Below ₹50K the challenge compounds through option lots (leverage), not
 * equity swing qty — so CALL/PUT rank before equity/futures (score order
 * preserved within each group). At/above ₹50K: pure score order.
 */
export function rankOpportunitiesForCapital(
  opps: ChallengeOpportunity[],
  capital: number,
): ChallengeOpportunity[] {
  const byScore = (a: ChallengeOpportunity, b: ChallengeOpportunity) => b.score - a.score;
  if (capital >= 50000) return [...opps].sort(byScore);
  const options = opps.filter((o) => HOISTED_INSTRUMENTS.has(o.instrument)).sort(byScore);
  const rest = opps.filter((o) => !HOISTED_INSTRUMENTS.has(o.instrument)).sort(byScore);
  return [...options, ...rest];
}

// ── Options-only scan helpers (₹15K challenge: CE/PE BUY only) ──

/**
 * Default lot-cost prefilter cap: derived from ₹15K × 75% position cap /
 * (5% lot buffer × 1.5% ATM-premium-of-spot estimate) = 11250/0.01575 ≈ 7.15L.
 * Chain slots are scarce — don't fetch chains whose one-lot cost can never
 * fit the position limit. Exact fit is decided by sizing later.
 */
export const DEFAULT_AFFORDABLE_LOT_CAP = 715000;

/**
 * Directions that mean "BUY an option" — index signals CALL/PUT, stock
 * signals BUY_CE/BUY_PE. LONG/SHORT (futures) and NO_TRADE are excluded:
 * the challenge never sells option premium and does not trade futures.
 */
export function isBuyOptionDirection(dir: string): boolean {
  return dir === "CALL" || dir === "PUT" || dir === "BUY_CE" || dir === "BUY_PE";
}

/**
 * Pre-filter quotes for option-chain fetching: only F&O symbols with a known
 * lot (≥2) whose one-lot cost could plausibly fit the capital budget
 * (price × lot ≤ cap). Prefilter only — exact fit is decided by sizing later.
 */
export function affordableOptionCandidates<T extends { symbol: string; price: number }>(
  quotes: T[],
  cap = DEFAULT_AFFORDABLE_LOT_CAP,
): (T & { lot: number })[] {
  const out: (T & { lot: number })[] = [];
  for (const q of quotes) {
    if (!(q.price > 0)) continue;
    const lot = getLotSize(q.symbol);
    if (lot < 2) continue;
    if (q.price * lot > cap) continue;
    out.push({ ...q, lot });
  }
  return out;
}

/**
 * Select the challenge top list: only CALL/PUT setups that sized within
 * capital + risk (position.canTrade). Sized-out options are counted unfit
 * (surfaced in summary) — equity/futures setups never enter the list and
 * are not counted.
 */
export function selectFitOptionBuys(
  opps: ChallengeOpportunity[],
): { fit: ChallengeOpportunity[]; unfitCount: number } {
  const fit: ChallengeOpportunity[] = [];
  let unfitCount = 0;
  for (const o of opps) {
    if (o.instrument !== "CALL" && o.instrument !== "PUT") continue;
    if (o.position?.canTrade) fit.push(o);
    else unfitCount++;
  }
  return { fit, unfitCount };
}

/**
 * Order action for the auto-executor. Options are ALWAYS bought — selling
 * option premium is forbidden by the challenge rules regardless of the
 * signal's direction text (was: direction "PUT" → SELL).
 */
export function resolveOrderAction(opp: { instrument: string; direction: string }): "BUY" | "SELL" {
  if (opp.instrument === "CALL" || opp.instrument === "PUT") return "BUY";
  if (opp.instrument === "FUTURES") {
    return opp.direction === "LONG" || opp.direction.includes("BUY") ? "BUY" : "SELL";
  }
  return opp.direction.includes("BUY") || opp.direction === "LONG" || opp.direction === "CALL"
    ? "BUY"
    : "SELL";
}

/**
 * Index signals at ≥70 confidence come out futures-shaped (LONG/SHORT).
 * The challenge trades options only — map them to the equivalent ATM CE/PE
 * BUY using the live chain's strike/premium (chain missing → premium 0, which
 * conversion later rejects honestly instead of fabricating a price).
 */
export function mapIndexFuturesToOptionBuy(
  sig: { symbol?: string; direction: string; strike?: number; premium?: number; entry: number; recommendedInstrument?: string },
  chain: { atmStrike?: number; atmCePremium?: number; atmPePremium?: number } | null | undefined,
): void {
  if (sig.direction !== "LONG" && sig.direction !== "SHORT") return;
  const isCall = sig.direction === "LONG";
  sig.direction = isCall ? "CALL" : "PUT";
  sig.strike = (chain?.atmStrike || sig.strike || 0) || sig.entry;
  sig.premium = (isCall ? chain?.atmCePremium : chain?.atmPePremium) || 0;
  sig.recommendedInstrument = `${sig.symbol || ""} ${sig.strike} ${isCall ? "CE" : "PE"}`.trim();
}

/**
 * Stock option chain universe: merge live scanner quotes (richer: rvol/sector)
 * with NIFTY500 batch quotes (breadth), keep session-range prices and lots
 * whose one-lot cost could fit capital. Chain slots are bounded — split
 * between the CHEAPEST lot costs (fit-likely: always in budget) and the most
 * ACTIVE movers (fresh setups), deduped, capped at `limit`.
 */
export function buildStockOptionUniverse(
  scannerQuotes: any[],
  batchQuotes: any[],
  limit = 12,
  cap: number = DEFAULT_AFFORDABLE_LOT_CAP,
): any[] {
  const bySym = new Map<string, any>();
  const ok = (q: any) => q && typeof q.symbol === "string" && q.price >= 20 && q.price <= 10000;
  for (const q of batchQuotes) if (ok(q)) bySym.set(q.symbol, q);
  for (const q of scannerQuotes) if (ok(q)) bySym.set(q.symbol, q); // scanner entry wins
  const affordable = affordableOptionCandidates(Array.from(bySym.values()), cap);
  const lotCost = (q: any) => q.price * (q.lot || 1);
  const byCost = [...affordable].sort((a, b) => lotCost(a) - lotCost(b));
  const byActivity = [...affordable].sort(
    (a, b) => Math.abs(b.changePercent || 0) - Math.abs(a.changePercent || 0),
  );
  const out: any[] = [];
  const seen = new Set<string>();
  const push = (q: any) => {
    if (!seen.has(q.symbol)) {
      seen.add(q.symbol);
      out.push(q);
    }
  };
  const half = Math.ceil(limit / 2);
  for (const q of byCost) {
    if (out.length >= half) break;
    push(q);
  }
  for (const q of byActivity) {
    if (out.length >= limit) break;
    push(q);
  }
  return out;
}

export interface ChallengeOpportunity {
  rank: number;
  symbol: string;
  name: string;
  instrument: InstrumentType;
  strategy: string;
  score: number;
  confidence: number;
  direction: string;
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  volume: number;
  relativeVolume: number;
  sector: string;
  near52WHigh: boolean;
  near52WLow: boolean;
  reasoning: string[];
  factors: Record<string, number>;
  position: any;
  data: { ltp: number; changePct: number; weekHigh52: number; weekLow52: number };
  // Option trade detail (CALL/PUT only) — real ATM strike/premium/expiry from
  // the chain; undefined for equity/futures setups
  strike?: number;
  premium?: number;
  expiry?: string;
  // Spot-space reference levels kept after premium conversion (display +
  // validator spot). Set by convertOptionToPremiumTerms.
  spotEntry?: number;
  spotStopLoss?: number;
  spotTarget1?: number;
  spotTarget2?: number;
  // Gate fields — inherited from session/status gate, NOT from raw score
  tradeable: boolean;
  blockedReasons: string[];
  dataStamp: 'LIVE' | 'PREV_CLOSE';
}

export interface ChallengeScanResult {
  timestamp: string;
  decision: TradeDecision;
  topOpportunities: ChallengeOpportunity[];
  bestTrade?: ChallengeOpportunity;
  summary: {
    nifty500Scanned: number;
    nifty500Valid: number;
    nifty500Candidates: number;
    indexFOAvailable: number;
    indexFOCandidates: number;
    stockFOAvailable: number;
    stockFOCandidates: number;
    equitySwingCandidates: number;
    casSignals: number;
    heroZeroCandidates: number;
    totalSetups: number;
    /** Option setups excluded from the top list — lot cost / risk sizing failed */
    unfitOptions: number;
    dataSource: "LIVE" | "PARTIAL" | "OFFLINE";
  };
  marketContext: {
    regime: string;
    vix: number;
    vixAvailable: boolean;
    breadth: string;
    sessionPhase: string;
  };
  capital: {
    current: number;
    available: number;
    riskBudget: number;
    drawdownPct: number;
  };
  noTradeReason?: string;
}

// ── Score a NIFTY 500 stock (FIXED: real R:R variation, multi-factor) ──
function scoreNifty500Stock(
  quote: Nifty500Quote,
  sectorStrength: Record<string, { avgChange: number; avgRelVol: number; count: number }>,
): ChallengeOpportunity | null {
  let score = 0;
  const reasoning: string[] = [];
  const factors: Record<string, number> = {};

  // 1. Momentum (0-20)
  const momScore = Math.min(20, Math.max(0, 10 + quote.changePct * 3));
  factors.momentum = Math.round(momScore);
  score += momScore;
  if (quote.changePct > 3) { reasoning.push(`Strong momentum +${quote.changePct.toFixed(1)}%`); }
  else if (quote.changePct > 1) { reasoning.push(`Positive momentum +${quote.changePct.toFixed(1)}%`); }
  else if (quote.changePct < -3) { reasoning.push(`Weak momentum ${quote.changePct.toFixed(1)}%`); }

  // 2. Volume (0-15)
  const volScore = Math.min(15, Math.max(0, (quote.relativeVolume - 0.5) * 4));
  factors.volume = Math.round(volScore);
  score += volScore;
  if (quote.relativeVolume > 3) { reasoning.push(`Volume surge ${quote.relativeVolume.toFixed(1)}x avg`); }
  else if (quote.relativeVolume > 2) { reasoning.push(`High volume ${quote.relativeVolume.toFixed(1)}x`); }

  // 3. 52-week proximity (0-15)
  let w52Score = 0;
  if (quote.near52WHigh) { w52Score = 15; reasoning.push("Near 52-week high breakout"); }
  else if (quote.near52WLow) { w52Score = 12; reasoning.push("Near 52-week low reversal zone"); }
  else if (quote.weekHigh52 > 0) {
    const range = quote.weekHigh52 - quote.weekLow52;
    const pos = range > 0 ? (quote.ltp - quote.weekLow52) / range : 0.5;
    w52Score = Math.round(pos * 10);
  }
  factors.week52 = w52Score;
  score += w52Score;

  // 4. Sector strength (0-10)
  const sector = sectorStrength[quote.sector];
  let sectorScore = 5;
  if (sector) {
    if (sector.avgChange > 1.5) sectorScore = 10;
    else if (sector.avgChange > 0.5) sectorScore = 8;
    else if (sector.avgChange > 0) sectorScore = 6;
    else if (sector.avgChange > -0.5) sectorScore = 4;
    else if (sector.avgChange > -1.5) sectorScore = 3;
    else sectorScore = 1;
    if (sector.avgChange > 1) reasoning.push(`Strong sector ${quote.sector} +${sector.avgChange.toFixed(1)}%`);
  }
  factors.sector = sectorScore;
  score += sectorScore;

  // 5. Risk/Reward (0-15) — FIXED: real variation based on price position
  const range = quote.weekHigh52 - quote.weekLow52;
  const atrProxy = range > 0 ? range * 0.015 : quote.ltp * 0.015;
  // R:R varies based on where price is in the range
  const rangePos = range > 0 ? (quote.ltp - quote.weekLow52) / range : 0.5;
  // Near bottom of range = better R:R (more upside), near top = worse
  const rrBase = 1 + (1 - rangePos) * 3; // 1.0 to 4.0
  const slDist = atrProxy * 2;
  const tpDist = atrProxy * 2 * rrBase;
  const rr = slDist > 0 ? tpDist / slDist : 1;
  const rrScore = Math.min(15, Math.round(rr * 3));
  factors.riskReward = rrScore;
  score += rrScore;
  if (rr >= 2.5) reasoning.push(`Excellent R:R 1:${rr.toFixed(1)}`);
  else if (rr >= 1.5) reasoning.push(`Good R:R 1:${rr.toFixed(1)}`);

  // 6. Price action (0-15) — FIXED: more variation
  const paScore = Math.min(15, Math.max(0,
    quote.changePct > 3 ? 15 :
    quote.changePct > 2 ? 13 :
    quote.changePct > 1 ? 11 :
    quote.changePct > 0 ? 9 :
    quote.changePct > -1 ? 7 :
    quote.changePct > -2 ? 5 :
    quote.changePct > -3 ? 3 : 1
  ));
  factors.priceAction = paScore;
  score += paScore;

  // 7. Liquidity (0-10)
  const liqScore = quote.volume > 5000000 ? 10 : quote.volume > 1000000 ? 8 : quote.volume > 500000 ? 6 : quote.volume > 100000 ? 4 : 2;
  factors.liquidity = liqScore;
  score += liqScore;

  // Build entry/SL/TP with real R:R — tick-rounded
  const tick = getTickSize(quote.symbol);
  const entry = roundToTick(quote.ltp, tick);
  const stopLoss = roundToTick(entry - slDist, tick);
  const target1 = roundToTick(entry + tpDist, tick);
  const target2 = roundToTick(entry + tpDist * 1.5, tick);

  const finalScore = Math.min(100, Math.round(score));

  return {
    rank: 0,
    symbol: quote.symbol,
    name: quote.symbol,
    instrument: "EQUITY",
    strategy: quote.near52WHigh ? "52W_BREAKOUT" : quote.near52WLow ? "52W_REVERSAL" : quote.relativeVolume > 2.5 ? "VOLUME_BREAKOUT" : quote.changePct > 2 ? "MOMENTUM" : "TECHNICAL",
    score: finalScore,
    confidence: Math.min(100, Math.round(finalScore * 0.9)),
    direction: quote.changePct > 0 ? "BUY" : "SELL",
    entry,
    stopLoss,
    target1,
    target2,
    riskReward: rr,
    volume: quote.volume,
    relativeVolume: quote.relativeVolume,
    sector: quote.sector,
    near52WHigh: quote.near52WHigh,
    near52WLow: quote.near52WLow,
    reasoning,
    factors,
    position: { quantity: 0, lotSize: 1, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false },
    data: { ltp: entry, changePct: quote.changePct, weekHigh52: quote.weekHigh52, weekLow52: quote.weekLow52 },
    // Gate fields — set by scan orchestrator after session check
    tradeable: false,
    blockedReasons: [],
    dataStamp: 'LIVE',
  };
}

// ── Main scan function (FIXED: proper counts, data source tracking) ──
export async function runChallengeScan(
  config: CapitalConfig = DEFAULT_CAPITAL_CONFIG,
): Promise<ChallengeScanResult> {
  const ch = getChallenge();
  const allOpportunities: ChallengeOpportunity[] = [];

  // 0. Live lot sizes (NSE fo_mktlots.csv, 2h TTL) — SEBI revises often;
  // the static snapshot in capital-manager is only a fallback.
  await fetchLiveLotSizes();

  // 1. Fetch NIFTY 500 data
  const nifty500Quotes = await fetchNifty500Batch();
  const sectorStrength = getSectorStrength(nifty500Quotes);
  const nifty500Valid = nifty500Quotes.size;
  let nifty500Candidates = 0;

  // 2. Score NIFTY 500 stocks
  for (const quote of nifty500Quotes.values()) {
    const opp = scoreNifty500Stock(quote, sectorStrength);
    if (opp && opp.score >= 50) {
      allOpportunities.push(opp);
      nifty500Candidates++;
    }
  }

  // 3. Build market context
  let ctx: MarketIntelligenceContext | null = null;
  let dataSource: "LIVE" | "PARTIAL" | "OFFLINE" = "OFFLINE";
  try {
    ctx = await buildMarketIntelligenceContext();
    dataSource = ctx.dataQuality || "PARTIAL";
  } catch (e: any) {
    console.warn("[Challenge] market context failed:", String(e?.message || e).substring(0, 200));
  }

  // 4. Index F&O (NIFTY + SENSEX)
  let indexFOAvailable = 0;
  let indexFOCandidates = 0;
  if (ctx) {
    try {
      const indexSignals = await analyzeIndexFO(ctx);
      indexFOAvailable = indexSignals.length;
      console.log(`[Challenge] index dirs: ${indexSignals.map((s) => `${s.symbol}:${s.direction}(${s.confidence})`).join(" ")}`);
      for (const sig of indexSignals) {
        if (sig.direction === "NO_TRADE") continue;
        // Futures-shaped signals (LONG/SHORT, the ≥70-confidence ones) become
        // the equivalent ATM CE/PE BUY — challenge never trades futures
        const chain = sig.symbol === "NIFTY" ? ctx.nifty
          : sig.symbol === "BANKNIFTY" ? ctx.banknifty
          : ctx.sensex;
        mapIndexFuturesToOptionBuy(sig, chain as any);
        if (!isBuyOptionDirection(sig.direction)) continue;
        indexFOCandidates++;
        console.log(`[Challenge] index buy signal: ${sig.symbol} ${sig.direction} score=${sig.confidence} strike=${sig.strike} prem=${sig.premium}`);
        allOpportunities.push({
          rank: 0,
          symbol: sig.symbol,
          name: sig.symbol,
          instrument: sig.direction.includes("CALL") ? "CALL" : "PUT",
          strategy: `INDEX_${sig.direction}`,
          score: sig.confidence,
          confidence: sig.confidence,
          direction: sig.direction,
          entry: sig.entry,
          stopLoss: sig.stopLoss,
          target1: sig.target1,
          target2: sig.target2,
          riskReward: sig.riskReward,
          volume: 0,
          relativeVolume: 1,
          sector: "Index",
          near52WHigh: false,
          near52WLow: false,
          reasoning: sig.reasoning,
          factors: sig.factors,
          position: { quantity: 0, lotSize: 25, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false },
          data: { ltp: sig.entry, changePct: 0, weekHigh52: 0, weekLow52: 0 },
          strike: sig.strike,
          premium: sig.premium,
          expiry: sig.expiry,
        });
      }
    } catch (e: any) {
      console.warn("[Challenge] index F&O failed:", String(e?.message || e).substring(0, 200));
    }
  }

  // 5. Stock F&O — broad option universe: scanner quotes merged with NIFTY500
  // batch quotes (breadth), affordable F&O lots only, most active first;
  // chains wave-batched for up to 12 (vs 5 before).
  let stockFOAvailable = 0;
  let stockFOCandidates = 0;
  if (ctx) {
    try {
      const batchQuotes = Array.from(nifty500Quotes.values()).map((q) => ({
        symbol: q.symbol,
        price: q.ltp,
        changePercent: q.changePct,
        relativeVolume: q.relativeVolume,
        sector: q.sector,
        volume: q.volume,
        weekHigh52: q.weekHigh52,
        weekLow52: q.weekLow52,
        name: q.symbol,
      }));
      // Chain prefilter follows rule-set-C economics (75% cap, 1.5% spot prem)
      const lotCap = Math.ceil(
        (ch.currentCapital * config.maxPositionPct / 100) / (1.05 * 0.015),
      );
      const universe = buildStockOptionUniverse(ctx.stockQuotes, batchQuotes, 12, lotCap);
      console.log(`[Challenge] stock universe: ${universe.length} (scanner=${ctx.stockQuotes.length} batch=${batchQuotes.length} cap=${lotCap})`);
      const stockOpts = universe.length > 0
        ? { quotes: universe, maxChains: universe.length }
        : undefined;
      const stockSignals = await analyzeStockFO(ctx, 20, stockOpts);
      stockFOAvailable = stockSignals.length;
      for (const sig of stockSignals) {
        if (sig.direction === "NO_TRADE") continue;
        // CE/PE BUY only — stock signals are BUY_CE/BUY_PE; anything else
        // (LONG/SHORT futures shape) never enters the challenge scan
        if (!isBuyOptionDirection(sig.direction)) continue;
        stockFOCandidates++;
        allOpportunities.push({
          rank: 0,
          symbol: sig.symbol,
          name: sig.symbol,
          instrument: sig.direction.includes("CE") ? "CALL" : "PUT",
          strategy: `STOCK_${sig.direction}`,
          score: sig.confidence,
          confidence: sig.confidence,
          direction: sig.direction,
          entry: sig.entry,
          stopLoss: sig.stopLoss,
          target1: sig.target1,
          target2: sig.target2,
          riskReward: sig.riskReward,
          volume: 0,
          relativeVolume: 1,
          sector: "F&O",
          near52WHigh: false,
          near52WLow: false,
          reasoning: sig.reasoning,
          factors: sig.factors,
          position: { quantity: 0, lotSize: 1, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false },
          data: { ltp: sig.entry, changePct: 0, weekHigh52: 0, weekLow52: 0 },
          strike: sig.strike,
          premium: sig.premium,
          expiry: sig.expiry,
        });
      }
    } catch (e: any) {
      console.warn("[Challenge] stock F&O failed:", String(e?.message || e).substring(0, 200));
    }
  }

  // 6. Equity Swing
  let equitySwingCandidates = 0;
  if (ctx) {
    try {
      const swingSignals = await analyzeEquitySwing(ctx, 20);
      for (const sig of swingSignals) {
        if (sig.direction === "NO_TRADE") continue;
        equitySwingCandidates++;
        allOpportunities.push({
          rank: 0,
          symbol: sig.symbol,
          name: sig.symbol,
          instrument: "EQUITY",
          strategy: `SWING_${sig.setup?.type || "SETUP"}`,
          score: sig.confidence,
          confidence: sig.confidence,
          direction: sig.direction,
          entry: sig.entry,
          stopLoss: sig.stopLoss,
          target1: sig.target1,
          target2: sig.target2,
          riskReward: sig.riskReward,
          volume: 0,
          relativeVolume: 1,
          sector: "Swing",
          near52WHigh: false,
          near52WLow: false,
          reasoning: sig.reasoning,
          factors: sig.factors,
          position: { quantity: 0, lotSize: 1, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false },
          data: { ltp: sig.entry, changePct: 0, weekHigh52: 0, weekLow52: 0 },
        });
      }
    } catch (e: any) {
      console.warn("[Challenge] equity swing failed:", String(e?.message || e).substring(0, 200));
    }
  }

  // 7. Session gate — determine tradeability and dataStamp
  const session = getCurrentSession();
  const isMarketOpen = session.isMarketOpen;
  const sessionPhase = session.session;
  const blockedReasons: string[] = [];
  if (!isMarketOpen) {
    blockedReasons.push(`Session ${sessionPhase} — market not open`);
  }

  // 8. Capital gate — no FUTURES below ₹2L
  const capitalBelow2L = ch.currentCapital < 200000;

  // 9. Apply tick rounding to F&O setups + add gate fields to ALL
  for (const opp of allOpportunities) {
    const tick = getTickSize(opp.symbol);
    if (opp.instrument !== "EQUITY") {
      opp.entry = roundToTick(opp.entry, tick);
      opp.stopLoss = roundToTick(opp.stopLoss, tick);
      opp.target1 = roundToTick(opp.target1, tick);
      opp.target2 = roundToTick(opp.target2, tick);
      opp.data.ltp = opp.entry;
    }
    // Set gate fields on every setup
    const setupBlocked = [...blockedReasons];
    if (capitalBelow2L && opp.instrument === "FUTURES") {
      setupBlocked.push(`Capital ₹${ch.currentCapital.toFixed(0)} < ₹2L — FUTURES not tradeable`);
    }
    opp.tradeable = setupBlocked.length === 0;
    opp.blockedReasons = setupBlocked;
    opp.dataStamp = isMarketOpen ? 'LIVE' : 'PREV_CLOSE';
  }

  // 9b. Option setups → PREMIUM space (BS re-price of spot SL/TP at the IV
  // implied by the live ATM premium). Failures get an honest blocked reason.
  for (const opp of allOpportunities) {
    if (opp.instrument === "CALL" || opp.instrument === "PUT") {
      const res = convertOptionToPremiumTerms(opp);
      if (!res.ok) {
        opp.tradeable = false;
        opp.blockedReasons.push(res.reason);
        opp.position = {
          quantity: 0, lotSize: getLotSize(opp.symbol), lots: 0, totalCost: 0,
          maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false,
          reason: res.reason, instrument: "OPTION",
        };
      }
    }
  }

  // 10. Dedupe per (symbol, instrument-kind) — keep highest score per kind
  const deduped = dedupeOpportunities(allOpportunities);

  // 11. Rank — options-first below ₹50K (compounding via lots), else by score
  const ranked = rankOpportunitiesForCapital(deduped, ch.currentCapital);

  // 12. Score distribution log (diagnostic)
  if (ranked.length > 0) {
    const scores = ranked.map(o => o.score).sort((a, b) => a - b);
    const min = scores[0];
    const max = scores[scores.length - 1];
    const median = scores[Math.floor(scores.length / 2)];
    const above75 = scores.filter(s => s >= 75).length;
    console.log(`[Challenge] Score dist: count=${ranked.length} min=${min} median=${median} max=${max} above75=${above75}`);
  }

  // 13. Size EVERY option setup (needed before fit selection — sizing is
  // pure math, cheap for the full ranked list). Conversion failures keep
  // their honest position.reason (never re-sized with spot numbers).
  for (const opp of ranked) {
    if (opp.instrument !== "CALL" && opp.instrument !== "PUT") continue;
    if (opp.spotEntry === undefined && opp.position.reason) continue;
    sizeOpportunity(opp, ch.currentCapital, config);
    if (!opp.position.canTrade) {
      console.log(`[Challenge] unfit ${opp.symbol} ${opp.instrument}: entry=₹${opp.entry} sl=₹${opp.stopLoss} lot=${opp.position.lotSize} → ${opp.position.reason}`);
    }
  }

  // 13b. CE/PE BUY only, fitted to capital + risk — top list is options-only
  // (equity/futures setups never surface; sized-out options counted unfit).
  const { fit, unfitCount } = selectFitOptionBuys(ranked);

  // 13c. Take top 10 fit options and assign ranks
  const top10 = fit.slice(0, 10).map((opp, i) => ({ ...opp, rank: i + 1 }));

  // 14b. Best trade = highest-score among tradeable + sizeable setups
  const candidates = top10
    .filter((o) => o.tradeable && o.position.canTrade)
    .sort((a, b) => b.score - a.score);
  const bestTrade = candidates[0];

  // 15. Decision — gate verdict is source of truth
  let decision: TradeDecision = "NO_TRADE";
  let noTradeReason: string | undefined;

  if (ch.status === "FAILED") {
    noTradeReason = "Challenge failed — max drawdown reached";
  } else if (ch.status === "TARGET_REACHED") {
    noTradeReason = "Target reached!";
  } else if (top10.length === 0) {
    const unfitReasons = ranked
      .filter((o) => (o.instrument === "CALL" || o.instrument === "PUT") && !o.position?.canTrade)
      .slice(0, 2)
      .map((o) => `${o.symbol} ${o.instrument}: ${(o.position?.reason || "sized out").slice(0, 90)}`)
      .join(" | ");
    noTradeReason = unfitCount > 0
      ? `No CE/PE BUY fits ₹${ch.currentCapital.toFixed(0)} capital + risk — ${unfitCount} sized out. ${unfitReasons}`
      : "No CE/PE BUY setups found above threshold";
  } else if (!bestTrade) {
    noTradeReason = `Blocked: ${top10
      .slice(0, 3)
      .map((o) => `${o.symbol} ${o.instrument} — ${o.blockedReasons.join("; ") || "not tradeable"}`)
      .join(" | ")}`;
  } else if (bestTrade.score < 60) {
    noTradeReason = `Best score ${bestTrade.score}/100 below minimum (60)`;
  } else {
    decision = bestTrade.score >= 70 ? "TRADE" : "WATCH";
  }

  return {
    timestamp: new Date().toISOString(),
    decision,
    topOpportunities: top10,
    bestTrade: decision === "TRADE" ? bestTrade : undefined,
    summary: {
      nifty500Scanned: nifty500Quotes.size,
      nifty500Valid,
      nifty500Candidates,
      indexFOAvailable,
      indexFOCandidates,
      stockFOAvailable,
      stockFOCandidates,
      equitySwingCandidates,
      casSignals: 0,
      heroZeroCandidates: 0,
      totalSetups: allOpportunities.length,
      unfitOptions: unfitCount,
      dataSource,
    },
    marketContext: {
      regime: ctx?.regime?.regime || "UNKNOWN",
      vix: ctx?.indiaVix || 0,
      vixAvailable: (ctx?.indiaVix ?? 0) > 0,
      breadth: ctx?.breadth ? `${ctx.breadth.advances}/${ctx.breadth.declines}` : "N/A",
      sessionPhase: ctx?.sessionPhase || "UNKNOWN",
    },
    capital: {
      current: ch.currentCapital,
      available: Math.round(ch.currentCapital * config.maxPositionPct / 100),
      riskBudget: Math.round(ch.currentCapital * (config.maxRiskPerTradePct / 100)),
      drawdownPct: ch.currentDrawdown.totalDrawdownPct,
    },
    noTradeReason,
  };
}

// ── Execute a trade (paper) ──
export function executeChallengeTrade(opportunity: ChallengeOpportunity) {
  return recordTrade({
    symbol: opportunity.symbol,
    strategy: opportunity.strategy,
    direction: opportunity.direction,
    entry: opportunity.entry,
    quantity: opportunity.position.quantity,
    lotSize: opportunity.position.lotSize,
    score: opportunity.score,
    stopLoss: opportunity.stopLoss,
    target: opportunity.target1,
  });
}
