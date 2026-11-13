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

// Nothing here touches the network; the module is imported by client
// components (page.tsx, SimpleMode.tsx) as well as server paths.

import { GATE_CONFIG } from "./agent-brain-gate";

export type SignalDirection = "CALL" | "PUT" | "WAIT" | "NEUTRAL";

export interface ConfirmationCheck {
  name: string;
  pass: boolean;
  detail: string;
  /** false when the data is unavailable (not counted in pass/total ratio). */
  available: boolean;
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
  /** Instrument the state belongs to — a symbol change resets everything (D-6). */
  symbolKey: string;
}

const DEFAULT_SYMBOL = "DEFAULT";

function blankState(symbolKey: string = DEFAULT_SYMBOL): State {
  return {
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
    symbolKey,
  };
}

let state: State = blankState();

/** Reset in-memory state (used by tests). */
export function resetSignalState(): void {
  state = blankState();
}

/** Reset when the instrument changes so NIFTY's confirmed CALL never leaks onto BANKNIFTY. */
function ensureSymbol(symbol?: string): void {
  const key = symbol && symbol.trim() ? symbol.trim().toUpperCase() : DEFAULT_SYMBOL;
  if (state.symbolKey !== key) {
    state = blankState(key);
  }
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
  symbol?: string,
): ConfirmResult {
  ensureSymbol(symbol);
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

export const CONF_FLOOR_CALL = CONFIG.confFloorCall; // 65 (0-100 scale)
export const CONF_FLOOR_PUT = CONFIG.confFloorPut; // 65 (0-100 scale)

/** REAL trend read — mapped from the 15m TfRead (tech-read.ts analyzeTf). */
export interface TrendReadInput {
  /** SuperTrend direction on the last CLOSED bar: 1 up, -1 down, 0 n/a. */
  stDir: 1 | -1 | 0;
  /** Close vs EMA fast/slow relation. */
  emaRel: "ABOVE" | "BELOW" | "UNKNOWN";
  /** EMA chop flag — when true the EMA vote is suppressed (crossovers unreliable). */
  emaChop: boolean;
  /** Market structure trend (HH/HL vs LH/LL on closed candles). */
  structureTrend: "UP" | "DOWN" | "RANGE";
}

/** REAL trigger read — mapped from the 5m triggerLayer evidence. */
export interface TriggerReadInput {
  /** Trigger evidence in favour (e.g. "BOS_UP on a closed candle"). */
  hits: string[];
  /** Trigger evidence against the direction. */
  opposing: string[];
}

/** REAL ADX/DI read — mapped from the 15m TfRead (adx/pdi/mdi). */
export interface AdxReadInput {
  adx: number;
  pdi: number;
  mdi: number;
}

/** REAL greeks read — the recommended leg's live chain row (delta/theta/gamma/vega/iv). */
export interface GreeksReadInput {
  delta: number | null;
  theta: number | null;
  gamma: number | null;
  vega: number | null;
  /** IV in the provider's units (%). */
  iv: number | null;
  /** Current premium of the leg (for theta-as-%-of-premium). */
  premium: number;
}

/** Evaluate confirmation checks from REAL market reads.
 *
 * Every check is scored from real data only:
 *   • Trend    — SuperTrend + EMA (chop-suppressed) + structure (15m TfRead)
 *   • Trigger  — closed-bar trigger hits/opposing (5m triggerLayer)
 *   • Volume   — real last-bar RVOL vs the 20-bar average
 *   • OI / PCR — real PCR
 *   • VWAP     — real vsVwap ("NA" when the candles carry no volume)
 *
 * Missing data yields an UNAVAILABLE check that does NOT count toward the
 * pass/total ratio — unavailable data is never turned into a pass or a lie.
 */
export function evaluateConfirmations(input: {
  /** Direction the signal is calling ("CALL" | "PUT"). */
  direction: "CALL" | "PUT";
  /** Real 15m trend read, or null when the snapshot is missing/stale. */
  trendRead?: TrendReadInput | null;
  /** Real 5m trigger read, or null when the snapshot is missing/stale. */
  triggerRead?: TriggerReadInput | null;
  /** Real relative volume (last bar vs prior 20-bar avg), or null when no volume data. */
  rvol?: number | null;
  /** PCR: call/put OI ratio. >1 bullish-leaning, <0.9 bearish-leaning. */
  pcr?: number | null;
  /** Real price-vs-VWAP side from the 5m read; "NA" when no volume. */
  vsVwap?: "ABOVE" | "BELOW" | "NA" | null;
  /** Real ADX/DI read from the 15m snapshot, or null when unavailable. */
  adxRead?: AdxReadInput | null;
  /** Real greeks of the recommended leg (from the live chain row), or null. */
  greeksRead?: GreeksReadInput | null;
}): ConfirmationCheck[] {
  const dir = input.direction;
  const wantBullish = dir === "CALL";
  const checks: ConfirmationCheck[] = [];

  // ── 1. Trend / structure alignment (REAL: SuperTrend + EMA + structure) ──
  const tr = input.trendRead ?? null;
  if (tr) {
    const wantUp = wantBullish;
    const stAgrees = tr.stDir === (wantUp ? 1 : -1);
    const structureAgrees = tr.structureTrend === (wantUp ? "UP" : "DOWN");
    const emaAgrees = !tr.emaChop && tr.emaRel !== "UNKNOWN" && tr.emaRel === (wantUp ? "ABOVE" : "BELOW");
    // SuperTrend must agree AND at least one of (structure, EMA-not-chop) must agree.
    const pass = stAgrees && (structureAgrees || emaAgrees);
    const parts = [
      `SuperTrend ${tr.stDir === 1 ? "up" : tr.stDir === -1 ? "down" : "n/a"}`,
      tr.emaChop ? `EMA chop (suppressed)` : `EMA ${tr.emaRel.toLowerCase()}`,
      `structure ${tr.structureTrend}`,
    ];
    checks.push({
      name: "Trend",
      pass,
      detail: parts.join(", "),
      available: true,
    });
  } else {
    checks.push({
      name: "Trend",
      pass: false,
      detail: "trend read unavailable (no fresh 15m snapshot)",
      available: false,
    });
  }

  // ── 2. Trigger (REAL: closed-bar evidence from the 5m trigger layer) ──
  const tg = input.triggerRead ?? null;
  if (tg) {
    const pass = tg.hits.length > 0 && tg.opposing.length === 0;
    const detail =
      tg.hits.length && tg.opposing.length
        ? `trigger mixed: ${tg.hits.join("; ")} | against: ${tg.opposing.join("; ")}`
        : tg.hits.length
          ? tg.hits.join("; ")
          : tg.opposing.length
            ? `trigger against: ${tg.opposing.join("; ")}`
            : "no trigger on closed candles";
    checks.push({ name: "Trigger", pass, detail, available: true });
  } else {
    checks.push({
      name: "Trigger",
      pass: false,
      detail: "trigger read unavailable (no fresh 5m snapshot)",
      available: false,
    });
  }

  // ── 3. Volume confirmation (REAL RVOL; null = no volume data) ──
  const rvol = input.rvol;
  if (rvol != null && Number.isFinite(rvol) && rvol > 0) {
    checks.push({
      name: "Volume",
      pass: rvol >= 1.2,
      detail: `RVOL ${rvol.toFixed(1)}x`,
      available: true,
    });
  } else {
    checks.push({
      name: "Volume",
      pass: false,
      detail: "no volume data on these candles",
      available: false,
    });
  }

  // ── 4. OI / PCR alignment (REAL PCR) ──
  const pcr = input.pcr;
  if (pcr != null && Number.isFinite(pcr) && pcr > 0) {
    const pcrPass = wantBullish ? pcr > 1.0 : pcr < 0.9;
    checks.push({
      name: "OI / PCR",
      pass: pcrPass,
      detail: `PCR ${pcr.toFixed(2)}`,
      available: true,
    });
  } else {
    checks.push({
      name: "OI / PCR",
      pass: false,
      detail: "PCR data unavailable",
      available: false,
    });
  }

  // ── 5. VWAP side (REAL vsVwap; "NA" = no volume → unavailable) ──
  const vsVwap = input.vsVwap;
  if (vsVwap === "ABOVE" || vsVwap === "BELOW") {
    checks.push({
      name: "VWAP",
      pass: (wantBullish && vsVwap === "ABOVE") || (!wantBullish && vsVwap === "BELOW"),
      detail: `price ${vsVwap === "ABOVE" ? "above" : "below"} VWAP`,
      available: true,
    });
  } else {
    checks.push({
      name: "VWAP",
      pass: false,
      detail: vsVwap === "NA"
        ? "no VWAP (candles carry no volume)"
        : "VWAP data unavailable",
      available: false,
    });
  }

  // ── 6. ADX / DI (REAL: trend strength + directional DI from the 15m read) ──
  const ax = input.adxRead ?? null;
  if (ax && Number.isFinite(ax.adx) && Number.isFinite(ax.pdi) && Number.isFinite(ax.mdi)) {
    const diAgrees = wantBullish ? ax.pdi > ax.mdi : ax.mdi > ax.pdi;
    const weak = ax.adx < 20;
    checks.push({
      name: "ADX",
      pass: !weak && diAgrees,
      detail: weak
        ? `ADX ${ax.adx.toFixed(1)} — weak trend (< 20, chop/ranging)`
        : `ADX ${ax.adx.toFixed(1)}, +DI ${ax.pdi.toFixed(1)} / −DI ${ax.mdi.toFixed(1)}`,
      available: true,
    });
  } else {
    checks.push({
      name: "ADX",
      pass: false,
      detail: "ADX data unavailable",
      available: false,
    });
  }

  // ── 7. Delta (REAL: the leg's live |delta| vs the gate's minAbsDelta 0.35) ──
  const gr = input.greeksRead ?? null;
  const legDelta = gr && gr.delta != null && Number.isFinite(Number(gr.delta)) && Number(gr.delta) !== 0
    ? Number(gr.delta)
    : null;
  if (legDelta != null) {
    const absDelta = Math.abs(legDelta);
    checks.push({
      name: "Delta",
      pass: absDelta >= GATE_CONFIG.minAbsDelta,
      detail: absDelta >= GATE_CONFIG.minAbsDelta
        ? `|delta| ${absDelta.toFixed(2)}`
        : `|delta| ${absDelta.toFixed(2)} — lottery ticket (< ${GATE_CONFIG.minAbsDelta})`,
      available: true,
    });
  } else {
    checks.push({
      name: "Delta",
      pass: false,
      detail: "delta unavailable (provider did not publish greeks)",
      available: false,
    });
  }

  return checks;
}

/** The trade gate behind the card's BUY/WAIT verdict — the playbook rule:
 *  a real trigger fires AND (real trend agrees OR real VWAP side agrees).
 *  Unavailable checks never count as passes; with no trigger or no
 *  trend/VWAP agreement the gate stays closed (WAIT), never fabricated open.
 */
export function confirmTradeGate(checks: ConfirmationCheck[]): {
  tradeable: boolean;
  rule: string;
} {
  const get = (name: string) => checks.find((c) => c.name === name);
  const trigger = get("Trigger");
  const trend = get("Trend");
  const vwap = get("VWAP");

  const triggerPass = !!trigger?.available && trigger.pass;
  const trendPass = !!trend?.available && trend.pass;
  const vwapPass = !!vwap?.available && vwap.pass;
  const contextOk = trendPass || vwapPass;

  return {
    tradeable: triggerPass && contextOk,
    rule: triggerPass
      ? contextOk
        ? "trigger + context aligned"
        : "trigger fired but no trend/VWAP agreement"
      : trigger?.available
        ? "no trigger on closed candles"
        : "trigger unavailable",
  };
}

/** Count how many checks pass — only counts checks with available data. */
export function confirmSummary(checks: ConfirmationCheck[]): {
  pass: number;
  total: number;
  pct: number;
} {
  const available = checks.filter((c) => c.available);
  const pass = available.filter((c) => c.pass).length;
  const total = available.length;
  return { pass, total, pct: total > 0 ? Math.round((pass / total) * 100) : 0 };
}

export { CONFIG };
