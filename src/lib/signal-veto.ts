// signal-veto.ts
// HYBRID overlay: the OLD brain (SMART_MONEY / scanners / Zero Hero / btst / SDM-engine)
// keeps generating trade candidates. This module is ONLY a veto — it can BLOCK
// or WARN (half size) a candidate before it reaches Telegram. It never creates
// signals, so it cannot reproduce the old gate's "zero TRADE verdicts" problem.
//
// HARD SAFETY (never shadowed, never loosened): stop on the wrong side of entry,
// R:R below GATE_CONFIG.minOptionRR, expiry-day index option, |delta| below
// GATE_CONFIG.minAbsDelta, OTM beyond GATE_CONFIG.maxOtmSteps, missing critical
// fields (fail closed), and the BTST path is left untouched.
//
// SHADOW MODE (BRAIN_FLAGS.shadowVeto): the verdict is always computed and always
// logged (would_block) — a QUALITY block does not suppress the alert, but every hard
// safety block still does. Shadowing never loosens a hard gate.
//
// Every rule below uses fields already present at sendTradeAlert time — no
// candle/bhavcopy network calls, so it is fast and safe in the hot path.
import { GATE_CONFIG, otmSteps, calibrateConfidence } from "./agent-brain-gate";
import { parseExpiryToYears, impliedVolFromPremium, calculateGreeks } from "./greeks";
import { BRAIN_FLAGS } from "./brain-flags";

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
  const buy = action.includes("BUY");
  const sell = action.includes("SELL");
  const directionKnown = buy || sell;
  const hard = (msg: string) => { hardFail = true; fails.push(msg); reasons.push(msg); };
  const soft = (msg: string) => { qualityFail = true; warnings.push(msg); reasons.push(msg); };

  // 0. BTST path stays untouched (own risk model, no option expiry/spot)
  if (/BTST/i.test(String(input.source || ""))) {
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

  // 2. Stop side + R:R — hard safety (only when the direction is known; an unknown
  //    direction is a warning, never a false block)
  if (directionKnown && Number.isFinite(entry) && Number.isFinite(sl) && Number.isFinite(tp1)) {
    const stopOk = buy ? sl < entry : sl > entry;
    if (!stopOk) {
      hard(`stop ${sl} not ${buy ? "below" : "above"} entry ${entry}`);
    } else {
      const rr = buy ? (tp1 - entry) / (entry - sl) : (entry - tp1) / (sl - entry);
      if (!Number.isFinite(rr) || rr < GATE_CONFIG.minOptionRR) {
        hard(`option R:R ${Number.isFinite(rr) ? rr.toFixed(2) : "bad"} < ${GATE_CONFIG.minOptionRR}`);
      }
    }
  } else if (!directionKnown) {
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
  if (isOption && input.expiry && INDEX_SYMBOLS.has(input.symbol)) {
    const today = new Date().toISOString().slice(0, 10);
    if (String(input.expiry).slice(0, 10) === today && !GATE_CONFIG.allowExpiryDay) {
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

  // 6. Confidence floor on the CALIBRATED number (quality signal — warning, never a
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
