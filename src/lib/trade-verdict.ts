// trade-verdict — CONFIRM / WAIT / SKIP for scanner candidates.
//
// Pure and offline: composes the same floors the alert funnel already
// enforces (validateScannerStock R:R ≥2 cash / ≥1.5 option, confidence
// floors, evaluateEmaLiveVeto) into one badge-friendly verdict.
//
// SKIP  = hard safety failure (never take the trade as-is)
// WAIT  = soft shortfall (borderline confidence / missing confirmation)
// CONFIRM = no hard failure and no soft shortfall
//
// Missing optional fields fail-open (absence is never a block alone) —
// matches ema-live-gate.

import { evaluateEmaLiveVeto } from "./ema-live-gate";
import type { EmaStructure } from "./ema-structure";
import type { ConsistencyVerdict } from "./directional-consistency";
import type { OptionsConfirmationVerdict } from "./options-confirmation";

export type TradeVerdict = "CONFIRM" | "WAIT" | "SKIP";
export type TradeVerdictKind = "cash" | "option";

export interface TradeVerdictInput {
  /** cash = stock scanners (default); option = premium buys. */
  kind?: TradeVerdictKind;
  confidence: number;
  riskReward: number;
  direction?: "BULLISH" | "BEARISH" | "NEUTRAL" | null;
  unifiedDecision?: "TRADE" | "WAIT" | "NO_TRADE" | string | null;
  hardGatesPassed?: boolean | null;
  /** Run the EMA live veto (same rule as Telegram alerts). Default: when emaStructure present. */
  emaLive?: boolean;
  emaStructure?: EmaStructure | null;
  directionalCheck?: ConsistencyVerdict | null;
  optionsConfirmation?: OptionsConfirmationVerdict | null;
  /** Clock seam for tests; defaults to Date.now(). */
  nowMs?: number;
}

export interface TradeVerdictResult {
  verdict: TradeVerdict;
  /** Hard failures (only non-empty when verdict === "SKIP"). */
  reasons: string[];
  /** Soft shortfalls (WAIT contributors; may also be present with SKIP). */
  waits: string[];
}

/** Cash floors match scanner-stock-alerts.validateScannerStock (MIN_RR=2, conf≥50). */
const CASH_MIN_RR = 2;
const CASH_MIN_CONF = 50;
const CASH_CONFIRM_CONF = 65;
/** Option floors match the agent gate / hard rules. */
const OPTION_MIN_RR = 1.5;
const OPTION_MIN_CONF = 65;
const OPTION_CONFIRM_CONF = 70;

export function evaluateTradeVerdict(input: TradeVerdictInput): TradeVerdictResult {
  const kind: TradeVerdictKind = input.kind ?? "cash";
  const minRR = kind === "option" ? OPTION_MIN_RR : CASH_MIN_RR;
  const minConf = kind === "option" ? OPTION_MIN_CONF : CASH_MIN_CONF;
  const confirmConf = kind === "option" ? OPTION_CONFIRM_CONF : CASH_CONFIRM_CONF;
  const nowMs = input.nowMs ?? Date.now();

  const reasons: string[] = [];
  const waits: string[] = [];

  // ── Hard: R:R floor ──
  if (!(input.riskReward > 0) || input.riskReward < minRR) {
    reasons.push(`R:R ${Number(input.riskReward || 0).toFixed(2)} below ${minRR}`);
  }

  // ── Hard: confidence floor ──
  if (!(input.confidence >= minConf)) {
    reasons.push(`confidence ${input.confidence} below ${minConf}`);
  }

  // ── Hard: EMA live veto (same rule as alert path) ──
  const tradeDirection =
    input.direction === "BEARISH" ? "BEARISH" :
    input.direction === "BULLISH" ? "BULLISH" :
    // engine-less fallback: treat BULLISH as default leg for cash scanners
    "BULLISH";
  const emaLive = input.emaLive ?? input.emaStructure != null;
  if (emaLive) {
    const veto = evaluateEmaLiveVeto({
      live: true,
      tradeDirection,
      emaStructure: input.emaStructure,
      directionalCheck: input.directionalCheck,
      optionsConfirmation: input.optionsConfirmation,
      nowMs,
    });
    if (veto.block) reasons.push(veto.reason || "EMA live veto");
  }

  // ── Hard: directional conflict / options ADVERSE (also covered by veto
  //    when emaStructure is fresh; check directly so absence of ema never
  //    hides an explicit CONFLICT/ADVERSE verdict). ──
  if (input.directionalCheck === "CONFLICT") {
    const msg = "directional consistency CONFLICT";
    if (!reasons.some(r => r.includes("CONFLICT"))) reasons.push(msg);
  }
  if (input.optionsConfirmation === "ADVERSE") {
    const msg = "options confirmation ADVERSE";
    if (!reasons.some(r => r.includes("ADVERSE"))) reasons.push(msg);
  }

  // ── Hard: unified gate explicitly failed ──
  if (input.unifiedDecision === "NO_TRADE" || input.hardGatesPassed === false) {
    reasons.push(
      input.hardGatesPassed === false
        ? "hard gates failed"
        : "unified decision NO_TRADE",
    );
  }

  // ── Soft: confidence in wait band ──
  if (reasons.length === 0 && input.confidence < confirmConf) {
    waits.push(`confidence ${input.confidence} below confirm floor ${confirmConf}`);
  }

  // ── Soft: missing / weak confirmation ──
  if (input.directionalCheck === "INSUFFICIENT") {
    waits.push("directional consistency INSUFFICIENT");
  }
  if (input.optionsConfirmation === "INCONCLUSIVE") {
    waits.push("options confirmation INCONCLUSIVE");
  }
  if (input.direction === "NEUTRAL" || input.direction == null) {
    waits.push("direction not decisive");
  }
  if (input.unifiedDecision === "WAIT") {
    waits.push("unified decision WAIT");
  }

  if (reasons.length > 0) return { verdict: "SKIP", reasons, waits };
  if (waits.length > 0) return { verdict: "WAIT", reasons: [], waits };
  return { verdict: "CONFIRM", reasons: [], waits: [] };
}

/** Tailwind classes for the CONFIRM / WAIT / SKIP badge. */
export function verdictBadgeClass(v: TradeVerdict): string {
  if (v === "CONFIRM") return "bg-emerald-600 text-white";
  if (v === "WAIT") return "bg-amber-500 text-white";
  return "bg-red-600 text-white";
}
