// Signal persistence / confirmation layer for the dashboard recommendation card.
//
// Problem: the legacy SDM card decides direction solely from live PCR
// (sdm-engine.ts runFullAnalysis) and page.tsx rebuilds + re-renders the
// recommendation on every option-chain refresh (5s-15s). As live CE/PE OI
// ticks, PCR drifts across 1.2 / 0.75 and the card flips BUY CE <-> BUY PE
// every few minutes.
//
// This module gates what the CARD displays. It does NOT touch execution,
// Telegram alerts, signal-veto, agent-brain-gate, or any production trading
// logic. It only stabilises the UI signal:
//
//   • A raw direction must persist across minConfirmations consecutive
//     refreshes AND survive minPersistenceMs before it becomes the confirmed
//     signal shown to the user.
//   • A reversal must clear a hysteresis margin (beat the current confirmed
//     confidence by hysteresisMargin points) — marginal noise can't flip it.
//   • A confidence floor (matching the Telegram alert floor) must be met
//     before any directional call is shown; below it the card reads NO TRADE.
//   • If no fresh data arrives within staleMs, the confirmed signal is
//     invalidated to WAIT (condition-based, not a blind delay).
//
// Genuine reversals are NOT blocked: once an opposing signal is confirmed
// (persistence + hysteresis), the card flips. Nothing is retained forever.

export type SignalDirection = "CALL" | "PUT" | "WAIT" | "NEUTRAL";

export interface ConfirmationCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface SignalRec {
  direction: SignalDirection;
  confidence: number; // 0-100
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  strike: number;
  tradeGrade: string;
  reason: string;
  riskReward: number;
  /** Confirmation checks evaluated alongside the signal. */
  confirmations?: ConfirmationCheck[];
  /** Overall confirmation pass count / total. */
  confirmPass?: number;
  confirmTotal?: number;
}

export interface ConfirmResult {
  /** The recommendation object the card should render. */
  rec: SignalRec;
  /** True when the displayed direction is locked in (not a pending flip). */
  confirmed: boolean;
  /** Human-readable status: confirmed | reversal pending | new signal pending | holding | stale. */
  status: string;
  /** Whether to render a directional call vs NO TRADE. */
  showDirection: boolean;
}

const CONFIG = {
  /** Consecutive refreshes supporting a pending direction before it can flip. */
  minConfirmations: 2,
  /** Minimum ms a pending direction must survive before flipping. */
  minPersistenceMs: 2 * 60 * 1000, // 2 minutes
  /** Reversal confidence must exceed current confirmed confidence by this much. */
  hysteresisMargin: 8,
  /** Confidence floor below which no directional card is shown (NO TRADE). */
  confFloorCall: 65,
  confFloorPut: 65,
  /** No fresh data within this ms invalidates the confirmed signal. */
  staleMs: 5 * 60 * 1000, // 5 minutes
  /** Levels (entry/SL/targets/strike) only refresh after this ms since last level update. */
  levelStaleMs: 5 * 60 * 1000, // 5 minutes
  /** Levels only refresh if premium moved beyond this fraction (e.g. 0.05 = 5%). */
  levelMovePct: 0.05,
};

interface State {
  confirmedDirection: SignalDirection;
  confirmedConfidence: number;
  pendingDirection: SignalDirection | null;
  pendingSince: number | null;
  pendingConfirmations: number;
  lastUpdate: number | null;
  /** Timestamp when entry/SL/targets/strike were last refreshed. */
  lastLevelUpdate: number | null;
  lastConfirmedRec: SignalRec;
}

let state: State = {
  confirmedDirection: "WAIT",
  confirmedConfidence: 0,
  pendingDirection: null,
  pendingSince: null,
  pendingConfirmations: 0,
  lastUpdate: null,
  lastLevelUpdate: null,
  lastConfirmedRec: {
    direction: "WAIT",
    confidence: 0,
    entry: 0,
    sl: 0,
    tp1: 0,
    tp2: 0,
    tp3: 0,
    strike: 0,
    tradeGrade: "—",
    reason: "no signal yet",
    riskReward: 0,
  },
};

/** Reset in-memory state (used by tests). */
export function resetSignalState(): void {
  state = {
    confirmedDirection: "WAIT",
    confirmedConfidence: 0,
    pendingDirection: null,
    pendingSince: null,
    pendingConfirmations: 0,
    lastUpdate: null,
    lastLevelUpdate: null,
    lastConfirmedRec: {
      direction: "WAIT",
      confidence: 0,
      entry: 0,
      sl: 0,
      tp1: 0,
      tp2: 0,
      tp3: 0,
      strike: 0,
      tradeGrade: "—",
      reason: "no signal yet",
      riskReward: 0,
    },
  };
}

function normalise(dir: SignalDirection): SignalDirection {
  return dir === "NEUTRAL" ? "WAIT" : dir;
}

function confFloor(dir: SignalDirection): number {
  return dir === "PUT" ? CONFIG.confFloorPut : CONFIG.confFloorCall;
}

function buildResult(rec: SignalRec, confirmed: boolean, status: string): ConfirmResult {
  const showDirection =
    confirmed && rec.direction !== "WAIT" && rec.confidence >= confFloor(rec.direction);
  return { rec: { ...rec }, confirmed, status, showDirection };
}

/**
 * Feed one raw recommendation (as mapped from the latest option-chain fetch).
 * Returns the recommendation object the card should render. Levels (entry /
 * SL / targets) always belong to the displayed direction — when a reversal is
 * still pending we keep rendering the last confirmed rec so the levels never
 * mismatch the direction.
 */
export function updateSignal(
  raw: SignalRec,
  nowMs: number = Date.now(),
  confirmations?: ConfirmationCheck[],
): ConfirmResult {
  const dir = normalise(raw.direction);
  const conf = Number.isFinite(raw.confidence) ? raw.confidence : 0;
  let staled = false;

  // ── Staleness invalidation ────────────────────────────────────────
  // No fresh data within staleMs → invalidate to WAIT (condition-based,
  // not a blind delay: a fresh confirmed signal can still flip it back).
  if (
    state.lastUpdate !== null &&
    nowMs - state.lastUpdate > CONFIG.staleMs &&
    state.lastConfirmedRec != null
  ) {
    state.confirmedDirection = "WAIT";
    state.confirmedConfidence = 0;
    state.pendingDirection = null;
    state.pendingSince = null;
    state.pendingConfirmations = 0;
    state.lastConfirmedRec = {
      ...state.lastConfirmedRec,
      direction: "WAIT",
      confidence: 0,
      confirmations: [],
    };
    state.lastLevelUpdate = null;
    staled = true;
  }
  state.lastUpdate = nowMs;

  if (staled) {
    return buildResult(state.lastConfirmedRec, true, "stale");
  }

  const confirmedDir = state.confirmedDirection;
  const confirmedConf = state.confirmedConfidence;
  const isNewSignal = confirmedDir === "WAIT";

  // ── No established signal yet → accept first directional signal immediately ──
  // Only flips require confirmation/hysteresis; the initial call/put must show
  // so the user isn't stuck on NO TRADE until a confirmation window elapses.
  if (isNewSignal && dir !== "WAIT") {
    state.confirmedDirection = dir;
    state.confirmedConfidence = conf;
    state.lastConfirmedRec = {
      ...raw,
      direction: dir,
      confidence: conf,
      confirmations,
    };
    state.lastLevelUpdate = nowMs;
    state.pendingDirection = null;
    state.pendingSince = null;
    state.pendingConfirmations = 0;
    return buildResult(state.lastConfirmedRec, true, "confirmed");
  }

  // ── Same direction as confirmed → keep levels sticky ──────────────
  if (dir === confirmedDir) {
    state.confirmedConfidence = conf;

    // Levels only refresh when premium moved materially OR the level
    // cache is stale. Otherwise we keep the same entry/SL/targets/strike
    // so the card stops flickering on every 15s option-chain refresh.
    const prevEntry = state.lastConfirmedRec.entry;
    const premiumMoved =
      prevEntry > 0 && raw.entry > 0
        ? Math.abs(raw.entry - prevEntry) / prevEntry >= CONFIG.levelMovePct
        : true;
    const levelStale =
      state.lastLevelUpdate == null ||
      nowMs - state.lastLevelUpdate >= CONFIG.levelStaleMs;

    if (premiumMoved || levelStale) {
      state.lastConfirmedRec = {
        ...raw,
        direction: dir,
        confidence: conf,
        confirmations,
      };
      state.lastLevelUpdate = nowMs;
    } else {
      // Same levels, just refresh confidence.
      state.lastConfirmedRec = {
        ...state.lastConfirmedRec,
        confidence: conf,
      };
    }

    state.pendingDirection = null;
    state.pendingSince = null;
    state.pendingConfirmations = 0;
    return buildResult(
      state.lastConfirmedRec,
      true,
      "confirmed",
    );
  }

  // ── Raw is WAIT → hold the confirmed direction, don't advance pending ─
  if (dir === "WAIT") {
    const hold =
      state.lastConfirmedRec ??
      { direction: "WAIT", confidence: 0, entry: 0, sl: 0, tp1: 0, tp2: 0, tp3: 0, strike: 0, tradeGrade: "—", reason: "holding", riskReward: 0 };
    return buildResult(hold, true, "holding (raw WAIT)");
  }

  // ── Raw is an opposing directional signal ───────────────────────────
  if (state.pendingDirection === dir) {
    // Same pending direction as before — accumulate confirmations.
    state.pendingConfirmations += 1;
    const elapsed = state.pendingSince ? nowMs - state.pendingSince : 0;
    const ready =
      state.pendingConfirmations >= CONFIG.minConfirmations &&
      elapsed >= CONFIG.minPersistenceMs;
    // Hysteresis: a reversal must beat current confirmed confidence by margin.
    const passesHysteresis = conf >= confirmedConf + CONFIG.hysteresisMargin;

    if (ready && passesHysteresis) {
      // Flip confirmed to the new direction.
      state.confirmedDirection = dir;
      state.confirmedConfidence = conf;
      state.lastConfirmedRec = {
        ...raw,
        direction: dir,
        confidence: conf,
        confirmations,
      };
      state.lastLevelUpdate = nowMs;
      state.pendingDirection = null;
      state.pendingSince = null;
      state.pendingConfirmations = 0;
      return buildResult(
        state.lastConfirmedRec,
        true,
        isNewSignal ? "confirmed" : "reversal confirmed",
      );
    }
    // Still pending — keep rendering the last confirmed rec.
    const hold = state.lastConfirmedRec ?? raw;
    return buildResult(
      hold,
      true,
      isNewSignal ? "new signal pending" : "reversal pending",
    );
  }

  // ── New opposing direction → start pending ──────────────────────────
  state.pendingDirection = dir;
  state.pendingSince = nowMs;
  state.pendingConfirmations = 1;
  const hold = state.lastConfirmedRec ?? raw;
  return buildResult(
    hold,
    true,
    isNewSignal ? "new signal pending" : "reversal pending",
  );
}

/** Read the current confirmed signal without feeding a new raw signal. */
export function getConfirmedSignal(): ConfirmResult {
  const hold =
    state.lastConfirmedRec ??
    {
      direction: "WAIT",
      confidence: 0,
      entry: 0,
      sl: 0,
      tp1: 0,
      tp2: 0,
      tp3: 0,
      strike: 0,
      tradeGrade: "—",
      reason: "no signal yet",
      riskReward: 0,
    };
  return buildResult(hold, true, "current");
}

export const CONF_FLOOR_CALL = CONFIG.confFloorCall; // 60 (0-100 scale)
export const CONF_FLOOR_PUT = CONFIG.confFloorPut; // 70 (0-100 scale)

/** Evaluate confirmation checks from available market context.
 *
 * Returns checks that the SimpleMode card can display so the user knows
 * *when* to take a trade — only when structure + trigger + volume + OI
 * all align in the same direction.
 *
 * Inputs are optional — missing data yields a "skip" check, never a fake pass.
 */
export function evaluateConfirmations(input: {
  /** Direction the signal is calling (1 = bullish/CALL, -1 = bearish/PUT). */
  direction: "CALL" | "PUT";
  /** EMA/SuperTrend alignment: "bullish" | "bearish" | "neutral" | null. */
  trend?: "bullish" | "bearish" | "neutral" | null;
  /** Trigger: fresh EMA cross + sweep reclaim in direction. "fresh" | "against" | "none" | null. */
  trigger?: "fresh" | "against" | "none" | null;
  /** Relative volume vs average: number or null. */
  rvol?: number | null;
  /** PCR: call/put OI ratio. >1 bullish-leaning, <0.9 bearish-leaning. */
  pcr?: number | null;
  /** Price vs VWAP: "above" | "below" | null. */
  vwap?: "above" | "below" | null;
}): ConfirmationCheck[] {
  const dir = input.direction;
  const wantBullish = dir === "CALL";
  const checks: ConfirmationCheck[] = [];

  // ── 1. Trend / structure alignment ──
  checks.push({
    name: "Trend",
    pass: (wantBullish && input.trend === "bullish") || (!wantBullish && input.trend === "bearish"),
    detail: input.trend
      ? `EMA/SuperTrend ${input.trend}`
      : "trend data unavailable",
  });

  // ── 2. Trigger (fresh cross / sweep reclaim in direction) ──
  checks.push({
    name: "Trigger",
    pass: input.trigger === "fresh",
    detail: input.trigger === "fresh"
      ? "fresh cross + sweep reclaim"
      : input.trigger === "against"
        ? "trigger against direction"
        : "no fresh trigger",
  });

  // ── 3. Volume confirmation ──
  const rvol = input.rvol ?? 0;
  checks.push({
    name: "Volume",
    pass: rvol >= 1.2,
    detail: rvol > 0 ? `RVOL ${rvol.toFixed(1)}x` : "volume data unavailable",
  });

  // ── 4. OI / PCR alignment ──
  const pcr = input.pcr ?? 0;
  const pcrPass = wantBullish ? pcr > 1.0 : pcr < 0.9;
  checks.push({
    name: "OI / PCR",
    pass: pcr > 0 && pcrPass,
    detail: pcr > 0 ? `PCR ${pcr.toFixed(2)}` : "PCR data unavailable",
  });

  // ── 5. VWAP side ──
  checks.push({
    name: "VWAP",
    pass: (wantBullish && input.vwap === "above") || (!wantBullish && input.vwap === "below"),
    detail: input.vwap
      ? `price ${input.vwap} VWAP`
      : "VWAP data unavailable",
  });

  return checks;
}

/** Count how many checks pass and total. */
export function confirmSummary(checks: ConfirmationCheck[]): {
  pass: number;
  total: number;
  pct: number;
} {
  const pass = checks.filter((c) => c.pass).length;
  const total = checks.length;
  return { pass, total, pct: total > 0 ? Math.round((pass / total) * 100) : 0 };
}

export { CONFIG };
