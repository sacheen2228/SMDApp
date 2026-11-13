// signal-veto.ts
// HYBRID overlay: the OLD brain (SMART_MONEY / scanners / Zero Hero / btst / SDM-engine)
// keeps generating trade candidates. This module is ONLY a veto — it can BLOCK
// or WARN (half size) a candidate before it reaches Telegram. It never creates
// signals, so it cannot reproduce the old gate's "zero TRADE verdicts" problem.
//
// HARD SAFETY (never shadowed, never loosened): stop on the wrong side of entry,
// R:R below GATE_CONFIG.minOptionRR, expiry-day index option, |delta| below
// GATE_CONFIG.minAbsDelta, OTM beyond GATE_CONFIG.maxOtmSteps, a deployment that
// does not fit the per-trade budget (or 0 lots), the DAY-LOSS / LOSS-STREAK
// caps and the CONCURRENT-EXPOSURE cap, missing critical fields (fail
// closed), and the BTST path is left untouched.
//
// THE DAY-LOSS CAP IS AN ACCOUNT RULE, NOT A STRATEGY RULE (2026-10-20).
// Until now only the agent path (evaluate_trade_gate) was day-loss limited —
// the scanner / Zero-Hero / SDMBot / master-bot Telegram paths were not, so a
// blown day kept producing alerts. The realised P&L, the loss streak and the
// open-book exposure are read from the trade journal + the in-memory tracker
// (risk-management.ts) and are enforced HERE, in the funnel every producer
// passes through. FAIL CLOSED: when the risk state cannot be read the signal
// is blocked ("cannot verify today's loss") — an unverifiable limit is not a
// passed limit. The rules stay local (SQLite + memory): no network calls, so
// the veto stays safe in the hot path.
//
// THE SIDE COMES FROM THE LEVEL GEOMETRY, NEVER FROM THE ACTION STRING.
// A bought PE is not automatically a short. Since remediation R1 (2026-10-31,
// option-plan.ts) EVERY plan builder — stock scanner, SDM engine, morning
// scan, hermes — produces the LONG-option geometry for both letters (stop
// BELOW the entry, targets ABOVE: a bought option loses when the premium
// falls). A SHORT-side plan can still arrive here — a LEGACY trade recorded
// under the old mirrored convention (stop above the entry, targets below) or
// a cash SELL — so the side must still be read from the LEVELS. The old veto
// assumed the long shape for every BUY and the short shape for every SELL, so
// it hard-blocked every legitimate bearish option plan ("stop 49.25 not above
// entry 41.05") and measured the R:R on the wrong side. The rule is the
// GEOMETRY the live monitors read (activeTradeTracker.planSide /
// paper-worker.detectPaperHit — both stop-first): the stop is the risk side,
// so the R:R is measured against the very level the monitor would fill at and
// a stop-out is always a loss. An INCOHERENT plan (stop and target on the
// same side) has a negative R:R here and is blocked outright.
//
// SHADOW MODE (BRAIN_FLAGS.shadowVeto): the verdict is always computed and always
// logged (would_block) — a QUALITY block does not suppress the alert, but every hard
// safety block still does. Shadowing never loosens a hard gate.
//
// Every rule below uses fields already present at sendTradeAlert time — no
// candle/bhavcopy network calls, so it is fast and safe in the hot path.
import { GATE_CONFIG, otmSteps, calibrateConfidence } from "./agent-brain-gate";
import { parseExpiryToYears, impliedVolFromPremium, calculateGreeks, isExpiryToday } from "./greeks";
import { BRAIN_FLAGS } from "./brain-flags";
import { getLotSizeStrict } from "./symbol-config";
import {
  evaluateSignalRiskLimits,
  modelTradeExposure,
  RISK_LIMITS,
  type RiskStateSnapshot,
} from "./risk-management";

const INDEX_SYMBOLS = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"]);

export type VetoVerdict = "PASS" | "WARN" | "BLOCK";
export type VetoTier = "A" | "B" | "C" | "NONE";

export interface VetoInput {
  symbol: string;
  action: string;       // e.g. "BUY CE" / "SELL PE" / "BUY"
  optionType?: "CE" | "PE";
  strike?: number;
  entry?: number;
  stopLoss?: number;
  tp1?: number;
  confidence?: number;
  expiry?: string;      // YYYY-MM-DD
  spot?: number;        // underlying level (optional — delta/OTM checks only)
  source?: string;      // brain + scanner name (BTST is exempt)
  requireExpiry?: boolean; // caller has the field available → its absence fails closed
  requireSpot?: boolean;   // caller has the field available → its absence fails closed
  /** Clock for the session cutoff (replay passes the SIGNAL time, not "now"). */
  nowMs?: number;
  /** Cached technical read (O(1) from tech-cache). Missing/stale → WARNING only. */
  tech?: { structure?: "agree" | "against" | "neutral" | "unknown"; trigger?: "agree" | "against" | "neutral" | "unknown"; stale?: boolean };
  /** Realised win-rate of the stated-confidence band (from resolved history).
   *  When absent, the default haircut (stated × 0.9) applies — the floor is never
   *  lowered to make the old brain pass. */
  calibrationBand?: { realizedHitPct?: number; n?: number };
  /** Lots being taken. 0 = NOT tradable → hard block. */
  lots?: number;
  /** Contract lot size. When absent it is resolved from the LOCAL symbol master
   *  (getLotSizeStrict) — never from the network. */
  lotSize?: number;
  /** ₹ committed to this trade. Over the per-trade budget → hard block. */
  deployedAmount?: number;
  /** ₹ at risk on this trade (when the caller knows it). */
  riskAmount?: number;
  /**
   * The realised-P&L + open-exposure snapshot (risk-management.ts). When it
   * is present the DAY-LOSS cap, the LOSS-STREAK rule and the CONCURRENT
   * EXPOSURE cap are enforced as hard fails.
   */
  riskState?: RiskStateSnapshot;
  /**
   * The risk state could NOT be read → the veto fails closed
   * ("cannot verify today's loss"). An unverifiable limit is not a passed limit.
   */
  riskUnavailable?: boolean;
}

export interface VetoResult {
  verdict: VetoVerdict;
  reasons: string[];      // hard fails + warnings (human readable)
  fails: string[];        // hard safety fails only
  warnings: string[];     // quality warnings only
  sizeFactor: number;     // 1.0 PASS / 0.5 WARN (halve size) / 0.0 BLOCK
  wouldBlock: boolean;    // the rules say block (logged even in shadow mode)
  suppress: boolean;      // the alert must NOT be sent (hard blocks always, quality only when not shadowed)
  tier: VetoTier;
  hardFail: boolean;
  statedConfidence: number;
  calibratedConfidence: number;
}

/** A = zero warnings, B = exactly 1 warning, C = ≥2 warnings, NONE = any hard fail. */
export function tierFromWarnings(warnings: string[], hardFail: boolean): VetoTier {
  if (hardFail) return "NONE";
  if (warnings.length === 0) return "A";
  if (warnings.length === 1) return "B";
  return "C";
}

export type PlanSide = "LONG" | "SHORT";

/**
 * The side a plan pays out on — read from the LEVEL GEOMETRY, never from the
 * action string:
 *
 *   stop BELOW the entry → a LONG plan (its targets sit above the entry)
 *   stop ABOVE the entry → a MIRRORED/SHORT plan (its targets sit below)
 *
 * This is the GEOMETRY the live monitors read (activeTradeTracker.planSide,
 * hermes/paper-worker.detectPaperHit — both stop-first). The option letter
 * lies: every plan builder has produced long-geometry for BOTH letters since
 * R1, while a LEGACY mirrored plan or a cash SELL still arrives as SHORT —
 * so only the levels can tell the two apart.
 *
 * The STOP decides here, matching the monitors: the stop is the risk side,
 * so the R:R is measured against the very level the monitor would fill at,
 * and a stop-out is always a loss. A plan whose stop and target disagree is
 * incoherent: the R:R comes out negative and the veto blocks it.
 *
 * Returns null when the geometry cannot decide (missing or degenerate stop) —
 * the caller then fails closed.
 */
export function vetoPlanSide(entry: number, stopLoss: number): PlanSide | null {
  if (!Number.isFinite(entry) || !Number.isFinite(stopLoss)) return null;
  if (stopLoss === entry) return null;
  return stopLoss < entry ? "LONG" : "SHORT";
}

export function evaluateSignalVeto(input: VetoInput): VetoResult {
  const reasons: string[] = [];
  const fails: string[] = [];
  const warnings: string[] = [];
  let hardFail = false;
  let qualityFail = false;
  const isOption = input.optionType === "CE" || input.optionType === "PE";
  const dir = isOption ? (input.optionType === "CE" ? "call" : "put") : undefined;
  const entry = input.entry != null ? Number(input.entry) : NaN;
  const sl = input.stopLoss != null ? Number(input.stopLoss) : NaN;
  const tp1 = input.tp1 != null ? Number(input.tp1) : NaN;
  const conf = Number(input.confidence) || 0;
  const action = String(input.action || "").toUpperCase();
  // The action only tells us whether the INTENT is known — the plan's side is
  // read from the levels (vetoPlanSide), never from BUY/SELL.
  const directionKnown = action.includes("BUY") || action.includes("SELL");
  const hard = (msg: string) => { hardFail = true; fails.push(msg); reasons.push(msg); };
  const soft = (msg: string) => { qualityFail = true; warnings.push(msg); reasons.push(msg); };

  // 0. DAY-LOSS CAP + LOSS STREAK + CONCURRENT EXPOSURE — hard safety.
  //    This is an ACCOUNT rule, so it applies to EVERY path (BTST included —
  //    a blown day must not produce another trade from any brain). It runs
  //    BEFORE the BTST exemption because the BTST exemption only covers the
  //    option-specific gates (expiry / spot / delta / OTM).
  //
  //    The numbers come from ONE place (GATE_CONFIG, via RISK_LIMITS):
  //      daily loss  ≤ ₹8,000 (2 stops) · weekly ≤ ₹16,000 · monthly ≤ ₹25,000
  //      2 consecutive losses end the session (the binding rule)
  //      Σ deployed of the OPEN trades ≤ ₹20,000 · Σ risk ≤ ₹8,000
  //    FAIL CLOSED: an unreadable risk state blocks the signal.
  if (input.riskUnavailable) {
    hard("cannot verify today's loss — the risk state is unavailable (fail closed)");
  } else if (input.riskState) {
    const lotSize = Number(input.lotSize) > 0
      ? Number(input.lotSize)
      : (getLotSizeStrict(String(input.symbol || "")) ?? null);
    // Size against REMAINING headroom — an open book must not permanent-block
    // every new alert by forcing the candidate to the full ₹20k budget.
    const openDeployed = Math.max(0, Number(input.riskState.openDeployed) || 0);
    const remainingHeadroom = Math.max(
      0,
      Math.min(RISK_LIMITS.maxOpenDeployed, RISK_LIMITS.capital) - openDeployed,
    );
    if (remainingHeadroom <= 0) {
      hard(`no deployment headroom — open deployed ₹${Math.round(openDeployed)} already at the ₹${RISK_LIMITS.maxOpenDeployed} cap`);
    } else {
      const modelled = modelTradeExposure({
        entry: Number.isFinite(entry) ? entry : null,
        stopLoss: Number.isFinite(sl) ? sl : null,
        lotSize,
        lots: input.lots ?? null,
        remainingHeadroom,
      });
      const statedDeployed = Number(input.deployedAmount);
      const statedRisk = Number(input.riskAmount);
      const newDeployed = Number.isFinite(statedDeployed) && statedDeployed > 0 ? statedDeployed : modelled.deployed;
      const newRisk = Number.isFinite(statedRisk) && statedRisk > 0 ? statedRisk : modelled.risk;
      const riskVerdict = evaluateSignalRiskLimits({
        state: input.riskState,
        newDeployed,
        newRisk,
      });
      for (const reason of riskVerdict.reasons) hard(reason);
    }
  }

  // 0b. BTST path stays untouched (own risk model, no option expiry/spot)
  //     — but the ACCOUNT-level day-loss rule above still applies to it.
  if (/BTST/i.test(String(input.source || ""))) {
    if (hardFail) {
      return {
        verdict: "BLOCK", reasons, fails, warnings: [],
        sizeFactor: 0, wouldBlock: true, suppress: true, tier: "NONE", hardFail: true,
        statedConfidence: conf, calibratedConfidence: conf,
      };
    }
    return {
      verdict: "PASS", reasons: ["btst path untouched"], fails: [], warnings: [],
      sizeFactor: 1, wouldBlock: false, suppress: false, tier: "A", hardFail: false,
      statedConfidence: conf, calibratedConfidence: conf,
    };
  }

  // 1. Fail closed on missing critical fields — a signal without a stop / a computable
  //    R:R is not a trade. (Only enforced when the caller can supply the field.)
  if (!Number.isFinite(entry)) hard("missing entry");
  if (!Number.isFinite(sl)) hard("missing stop");
  if (!Number.isFinite(tp1)) hard("missing target (R:R not computable)");
  if (isOption && input.requireExpiry && !input.expiry) hard("missing expiry");
  if (isOption && input.requireSpot && !(Number(input.spot) > 0)) hard("missing underlying spot");

  // 2. Stop side + R:R — hard safety, measured on the PLAN GEOMETRY.
  //    The side comes from the levels (a stop below the entry = long plan, a
  //    stop above it = mirrored/short plan), so a legitimate bearish option
  //    plan is no longer blocked for "not being long-side" and its R:R is
  //    measured on the side it actually pays out on.
  const side = vetoPlanSide(entry, sl);
  if (side && Number.isFinite(tp1)) {
    const risk = side === "LONG" ? entry - sl : sl - entry; // > 0 by construction
    const reward = side === "LONG" ? tp1 - entry : entry - tp1;
    const rr = reward / risk;
    if (isOption && !Number.isFinite(rr) || isOption && rr < GATE_CONFIG.minOptionRR - 0.01) {
      hard(`option R:R ${Number.isFinite(rr) ? rr.toFixed(2) : "bad"} < ${GATE_CONFIG.minOptionRR}`);
    }
  } else if (Number.isFinite(entry) && Number.isFinite(sl)) {
    // A stop that is not on ONE side of the entry is not a plan → fail closed.
    hard(`stop ${sl} is not on one side of entry ${entry}`);
  }
  if (!directionKnown) {
    soft("direction unknown — R:R/stop side unverified");
  }

  // 2b. Session cutoff — no NEW option premium buys after 13:00 IST.
  // Ledger: option entries 13:00-14:59 went 0 wins / 34 trades.
  if (isOption && BRAIN_FLAGS.noOptionBuysAfter13) {
    const istHour = new Date((input.nowMs ?? Date.now()) + 5.5 * 3600_000).getUTCHours();
    if (istHour >= 13) {
      hard(`after 13:00 IST — no new option premium buys (0 wins / 34 ledger trades in this window)`);
    }
  }

  // 3. Expiry-day index option — hard safety
  //    Parse Breeze/DD-MMM-YYYY AND ISO (isExpiryToday) and compare IST days.
  //    The old `slice(0,10) === todayISO` never matched "03-Nov-2026".
  if (isOption && input.expiry && INDEX_SYMBOLS.has(input.symbol)) {
    const nowForGate = new Date(input.nowMs ?? Date.now());
    if (isExpiryToday(input.expiry, nowForGate) && !GATE_CONFIG.allowExpiryDay) {
      hard("expiry-day gamma lottery — blocked");
    }
  }

  // 4. OTM strike distance — hard safety when spot is known
  if (isOption && input.strike && input.spot) {
    const steps = otmSteps(dir!, input.strike, input.spot, input.symbol);
    if (steps > GATE_CONFIG.maxOtmSteps) {
      hard(`${steps} steps OTM (max ${GATE_CONFIG.maxOtmSteps})`);
    }
  }

  // 5. Delta lottery ticket — hard safety when it is computable from real spot+expiry
  if (isOption && input.spot && input.strike && input.entry && input.expiry) {
    const tYears = parseExpiryToYears(input.expiry, new Date());
    if (tYears != null && tYears > 0) {
      const iv = impliedVolFromPremium(Number(input.entry), input.spot, Number(input.strike), tYears, dir === "call");
      if (iv != null) {
        const delta = Math.abs(calculateGreeks(input.spot, Number(input.strike), tYears, iv, dir === "call").delta);
        if (delta < GATE_CONFIG.minAbsDelta) {
          hard(`|delta| ${delta.toFixed(2)} lottery ticket`);
        }
      }
    }
  }

  // 5b. Cached technical read — a contradicting structure/trigger is a WARNING (tier C
  //     → paper), never a block. A cold/stale cache is a WARNING too, never a block.
  if (input.tech) {
    if (input.tech.stale) soft("technical snapshot stale/cold — structure unverified");
    if (input.tech.structure === "against") soft("structure against the signal");
    if (input.tech.trigger === "against") soft("trigger against the signal");
  }

  // 6. DEPLOYMENT / LOT — hard safety (fail closed).
  //    The ₹ committed to ONE trade may never exceed the per-trade budget
  //    (GATE_CONFIG.tradeBudget) and a trade needs at least ONE lot. The lot
  //    size comes from the caller or from the LOCAL symbol master
  //    (getLotSizeStrict) — no network, so it is safe in the hot path.
  //    Without this an over-sized plan (RELIANCE CE ₹90 × lot 500 = ₹45,000, or
  //    SBIN CE ₹300 × lot 750 = ₹2,25,000) passed every other gate and reached
  //    Telegram as a "trade" worth 11× the account.
  if (isOption) {
    const budget = GATE_CONFIG.tradeBudget;
    const lotSize = Number(input.lotSize) > 0
      ? Number(input.lotSize)
      : (getLotSizeStrict(String(input.symbol || "")) ?? 0);
    const statedLots = input.lots != null && Number.isFinite(Number(input.lots))
      ? Math.floor(Number(input.lots))
      : undefined;

    if (statedLots != null && statedLots < 1) {
      hard(`0 lots — the contract does not fit the ₹${budget.toLocaleString("en-IN")} per-trade budget (no trade)`);
    }
    const statedDeployed = Number(input.deployedAmount);
    if (Number.isFinite(statedDeployed) && statedDeployed > budget) {
      hard(`₹${Math.round(statedDeployed).toLocaleString("en-IN")} deployed > the ₹${budget.toLocaleString("en-IN")} per-trade budget`);
    }
    if (lotSize > 0 && Number.isFinite(entry) && entry > 0) {
      const n = statedLots != null && statedLots >= 1 ? statedLots : 1;
      const deployment = entry * lotSize * n;
      if (deployment > budget) {
        hard(
          `${n} lot × ${lotSize} × ₹${entry} = ₹${Math.round(deployment).toLocaleString("en-IN")} deployed > the ₹${budget.toLocaleString("en-IN")} per-trade budget`
        );
      }
    }
  }

  // 7. Confidence floor on the CALIBRATED number (quality signal — warning, never a
  //    hard block). The floor stays at GATE_CONFIG.minConfidence.
  const calibrated = calibrateConfidence(conf, input.calibrationBand);
  if (calibrated < GATE_CONFIG.minConfidence) {
    soft(`calibrated confidence ${calibrated}% (stated ${conf}%) < ${GATE_CONFIG.minConfidence}% — halve size`);
  }

  const tier = tierFromWarnings(warnings, hardFail);
  const wouldBlock = hardFail || qualityFail || (BRAIN_FLAGS.tiering && tier === "C");
  // Tier C (≥2 warnings) is PAPER ONLY when tiering is enabled: logged, never sent.
  const suppress = hardFail || (qualityFail && !BRAIN_FLAGS.shadowVeto) || (BRAIN_FLAGS.tiering && tier === "C");
  // Effective verdict for THIS send: a hard fail is never sent; a quality fail is
  // sent as WARN while shadow mode is on (it is only logged as would_block).
  const verdict: VetoVerdict = hardFail
    ? "BLOCK"
    : (qualityFail || (BRAIN_FLAGS.tiering && tier === "C"))
      ? (BRAIN_FLAGS.shadowVeto ? "WARN" : "BLOCK")
      : "PASS";

  return {
    verdict,
    reasons,
    fails,
    warnings,
    sizeFactor: hardFail ? 0 : warnings.length ? 0.5 : 1,
    wouldBlock,
    suppress,
    tier,
    hardFail,
    statedConfidence: conf,
    calibratedConfidence: calibrated,
  };
}

/**
 * THE FUNNEL ENTRY POINT — the veto WITH the account-level risk rules.
 *
 * `evaluateSignalVeto` is pure and offline (no state, no I/O). This wrapper
 * adds the ONE thing a pure function cannot do: read today's realised P&L,
 * the loss streak and the open-book exposure, and hand them to the veto.
 *
 *   • the state comes from risk-management.ts — the trade journal (SQLite) +
 *     the in-memory tracker. Local, no network, cached for a few seconds.
 *   • FAIL CLOSED: if the state cannot be read the verdict is BLOCK with
 *     "cannot verify today's loss" — an unverifiable limit is not a passed
 *     limit, and unlimited trades are exactly what that would allow.
 *
 * `loader` is REQUIRED — the DB reader lives in risk-state.server.ts, which pulls
 * Prisma + the whole tracker/telegram/voice chain. A dynamic import here (the old
 * default) was still chased by the bundler and broke the CLIENT build the moment
 * a client component (OIFlowView) imported this module for its verdict display.
 * Server callers wire checkSignalRiskLimits themselves; client callers never
 * have the DB — they call evaluateSignalVeto directly (account caps stay
 * enforced in the sendTradeAlert funnel).
 */
export async function evaluateSignalVetoWithRisk(
  input: VetoInput,
  loader: () => Promise<
    { ok: true; state: RiskStateSnapshot } | { ok: false; reason: string }
  >,
): Promise<VetoResult> {
  let state: RiskStateSnapshot | undefined;
  let unavailable = false;
  try {
    const loaded = await loader();
    if (loaded?.ok) state = loaded.state;
    else unavailable = true;
  } catch (err: any) {
    unavailable = true;
  }
  return evaluateSignalVeto({
    ...input,
    riskState: state,
    riskUnavailable: unavailable,
  });
}
