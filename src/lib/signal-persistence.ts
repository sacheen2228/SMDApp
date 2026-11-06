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
  confFloorCall: 60,
  confFloorPut: 70,
  /** No fresh data within this ms invalidates the confirmed signal. */
  staleMs: 5 * 60 * 1000, // 5 minutes
};

interface State {
  confirmedDirection: SignalDirection;
  confirmedConfidence: number;
  pendingDirection: SignalDirection | null;
  pendingSince: number | null;
  pendingConfirmations: number;
  lastUpdate: number | null;
  lastConfirmedRec: SignalRec;
}

let state: State = {
  confirmedDirection: "WAIT",
  confirmedConfidence: 0,
  pendingDirection: null,
  pendingSince: null,
  pendingConfirmations: 0,
  lastUpdate: null,
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
  return { rec, confirmed, status, showDirection };
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
    };
    staled = true;
  }
  state.lastUpdate = nowMs;

  if (staled) {
    return buildResult(state.lastConfirmedRec, true, "stale");
  }

  const confirmedDir = state.confirmedDirection;
  const confirmedConf = state.confirmedConfidence;
  const isNewSignal = confirmedDir === "WAIT";

  // ── Same direction as confirmed → refresh levels, clear pending ────
  if (dir === confirmedDir) {
    state.confirmedConfidence = conf;
    state.lastConfirmedRec = { ...raw, direction: dir, confidence: conf };
    state.pendingDirection = null;
    state.pendingSince = null;
    state.pendingConfirmations = 0;
    return buildResult(
      state.lastConfirmedRec,
      true,
      isNewSignal ? "confirmed" : "confirmed",
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
      state.lastConfirmedRec = { ...raw, direction: dir, confidence: conf };
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

export { CONFIG };
