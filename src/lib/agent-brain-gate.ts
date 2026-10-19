// agent-brain-gate.ts
// Deterministic discipline layer for the SDM agent.
// Numbers and rules come from code; the LLM does judgment and narration.
// Self-contained: no imports (drop-in safe anywhere in src/lib).
// Educational framework, not financial advice.

// ─────────────────────────────────────────────────────────────
// Config — single source of truth. The prompt rules block is generated from this.
// ─────────────────────────────────────────────────────────────
export const GATE_CONFIG = {
  minConfidence: 65,
  minLayersAgree: 3,
  maxLayersAgainst: 1,
  minUnderlyingRR: 2,      // chart R:R ≥ 1:2
  minOptionRR: 1.5,        // option R:R after repricing ≥ 1.5
  defaultRiskPct: 1,
  maxRiskPct: 2,
  maxOtmSteps: 3,          // OTM ≤ 3 strikes from ATM
  minAbsDelta: 0.35,       // below = lottery ticket
  capital: 200_000,
  maxConsecutiveLosses: 3,
  maxDailyLossPct: 3,
  freshnessMaxMin: 10,
  allowExpiryDay: false,
  maxToolResultChars: 6_000,
  maxToolsPerRequest: 12,
};

export const STRIKE_STEP: Record<string, number> = {
  NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25, SENSEX: 100, BANKEX: 350,
};

// ─────────────────────────────────────────────────────────────
// Sanitisation + secrets
// ─────────────────────────────────────────────────────────────
export function safeSymbol(v: any, fallback = "NIFTY"): string {
  const raw = String(v ?? fallback ?? "").toUpperCase();
  const m = raw.match(/^[A-Z0-9]{1,20}/);
  const s = m ? m[0].replace(/[^A-Z]/g, "") : "";
  if (!s) return fallback;
  return s;
}

const SECRET_KEYS = /(token|secret|api_?key|session|otp|password|auth)/i;

export function redactArgs(args: any): any {
  if (args == null || typeof args !== "object") return args;
  const out: any = Array.isArray(args) ? [...args] : { ...args };
  for (const k of Object.keys(out)) {
    if (SECRET_KEYS.test(k)) out[k] = "***";
  }
  return out;
}

export function enc(s: string): string {
  return encodeURIComponent(String(s ?? ""));
}

// ─────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────
export interface JsonResult<T = any> {
  ok: boolean; status?: number; ms: number; data?: T; error?: string;
}

export async function getJSON<T = any>(
  url: string,
  opts: { timeoutMs?: number; retries?: number } = {}
): Promise<JsonResult<T>> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const retries = Math.max(0, opts.retries ?? 0);
  let lastErr = "unknown error";
  const t0 = Date.now();
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const ms = Date.now() - t0;
      if (!res.ok) return { ok: false, status: res.status, ms, error: `HTTP ${res.status}` };
      const data = (await res.json()) as T;
      return { ok: true, status: res.status, ms, data };
    } catch (e: any) {
      lastErr = String(e?.message || e).slice(0, 120);
      if (i < retries) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  return { ok: false, ms: Date.now() - t0, error: lastErr };
}

// ─────────────────────────────────────────────────────────────
// Session clock (IST = UTC+5:30, self-contained)
// ─────────────────────────────────────────────────────────────
export function istClock(nowMs: number = Date.now()) {
  const ist = new Date(nowMs + 5.5 * 3600_000);
  const hh = ist.getUTCHours();
  const mm = ist.getUTCMinutes();
  const dow = ist.getUTCDay();
  const mins = hh * 60 + mm;
  const hhmm = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  let phase = "CLOSED";
  if (dow === 0 || dow === 6) phase = "CLOSED";
  else if (mins >= 540 && mins < 555) phase = "PRE_OPEN";
  else if (mins >= 555 && mins < 750) phase = "CAS_MORNING";
  else if (mins >= 750 && mins < 810) phase = "MIDDAY";
  else if (mins >= 810 && mins < 915) phase = "CAS_AFTERNOON";
  else if (mins >= 915 && mins < 930) phase = "CLOSING";
  else if (mins >= 930 && mins < 1000) phase = "POST_CLOSE";
  return { hhmm, hh: hh, mm, phase, dow, mins, isWeekend: dow === 0 || dow === 6 };
}

function stampMs(s: any): number | null {
  if (s == null) return null;
  if (typeof s === "number") return s > 1e12 ? s : s * 1000;
  const t = Date.parse(String(s));
  return Number.isFinite(t) ? t : null;
}

export function checkFreshness(stamps: Array<any> | null | undefined, maxMin: number = GATE_CONFIG.freshnessMaxMin, asOfMs: number = Date.now()) {
  if (!stamps || !stamps.length) return { ok: false, oldestMin: Infinity, reason: "no feed timestamps" };
  const now = asOfMs;
  let oldest = Infinity;
  for (const s of stamps) {
    const ms = stampMs(s);
    if (ms == null) continue;
    oldest = Math.min(oldest, (now - ms) / 60_000);
  }
  if (!Number.isFinite(oldest)) return { ok: false, oldestMin: Infinity, reason: "timestamps unparseable" };
  if (oldest > maxMin) return { ok: false, oldestMin: Math.round(oldest), reason: `oldest feed ${Math.round(oldest)} min old (> ${maxMin})` };
  return { ok: true, oldestMin: Math.round(oldest), reason: "" };
}

// ─────────────────────────────────────────────────────────────
// Ledger stats (Wilson, break-even, buckets)
// ─────────────────────────────────────────────────────────────
export function wilson(wins: number, n: number, z = 1.96): { lo: number; hi: number; p: number } {
  if (n <= 0) return { lo: 0, hi: 1, p: 0 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return { lo: Math.max(0, (center - half) / denom), hi: Math.min(1, (center + half) / denom), p };
}

export interface BucketStats {
  n: number; wins: number; wr: number; breakevenWr: number; edge: number;
  avgWin: number; avgLoss: number; profitFactor: number; expectancy: number;
}

export function bucketStats(trades: Array<{ pnl: number }>): BucketStats {
  const pnls = trades.map((t) => Number(t.pnl) || 0);
  const n = pnls.length;
  const winsArr = pnls.filter((p) => p > 0);
  const lossArr = pnls.filter((p) => p < 0);
  const wins = winsArr.length;
  const wr = n ? wins / n : 0;
  const avgWin = winsArr.length ? winsArr.reduce((a, b) => a + b, 0) / winsArr.length : 0;
  const grossWin = winsArr.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(lossArr.reduce((a, b) => a + b, 0));
  const avgLoss = lossArr.length ? grossLoss / lossArr.length : 0;
  const breakevenWr = avgWin + avgLoss > 0 ? avgLoss / (avgWin + avgLoss) : 0.5;
  return {
    n, wins, wr, breakevenWr, edge: wr - breakevenWr,
    avgWin, avgLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancy: n ? pnls.reduce((a, b) => a + b, 0) / n : 0,
  };
}

export interface LedgerRow {
  pnl: number; direction?: string; regime?: string; window?: string;
  strikeDistance?: number; confidence?: number;
}

function bucketKey(t: LedgerRow): string {
  return `${t.regime ?? "?"}|${t.window ?? "?"}|sd${t.strikeDistance ?? "?"}`;
}

/** Vetoes buckets with ≥30 trades whose win-rate sits below the true break-even. */
export function ledgerBlocks(ledger: LedgerRow[], minN = 30): string[] {
  const by = new Map<string, LedgerRow[]>();
  for (const t of ledger) {
    const k = bucketKey(t);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(t);
  }
  const blocks: string[] = [];
  for (const [k, rows] of by) {
    if (rows.length < minN) continue;
    const s = bucketStats(rows);
    if (s.edge < 0) {
      blocks.push(`${k}: ${s.n} trades, WR ${(s.wr * 100).toFixed(1)}% < break-even ${(s.breakevenWr * 100).toFixed(1)}%`);
    }
  }
  return blocks;
}

export function ledgerReport(ledger: LedgerRow[]): string {
  if (!ledger.length) return "Ledger: no trades recorded yet.";
  const overall = bucketStats(ledger);
  const L: string[] = [];
  L.push(`LEDGER EDGE REPORT — ${overall.n} trades`);
  L.push(`Overall WR ${(overall.wr * 100).toFixed(1)}% vs break-even ${(overall.breakevenWr * 100).toFixed(1)}% → edge ${(overall.edge * 100).toFixed(1)} pts | PF ${Number.isFinite(overall.profitFactor) ? overall.profitFactor.toFixed(2) : "∞"} | expectancy ₹${overall.expectancy.toFixed(0)}/trade`);
  const dims = [
    { name: "regime", get: (t: LedgerRow) => t.regime },
    { name: "window", get: (t: LedgerRow) => t.window },
    { name: "strikeDistance", get: (t: LedgerRow) => (t.strikeDistance == null ? undefined : `sd${t.strikeDistance}`) },
  ];
  for (const d of dims) {
    const by = new Map<string, LedgerRow[]>();
    for (const t of ledger) {
      const k = d.get(t);
      if (k == null) continue;
      if (!by.has(k)) by.set(k, []);
      by.get(k)!.push(t);
    }
    for (const [k, rows] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const s = bucketStats(rows);
      const w = wilson(s.wins, s.n);
      const verdict = s.n >= 10 && s.edge < 0 ? " ❌ below break-even" : s.n >= 10 && s.edge > 0 ? " ✓ edge" : " (small sample)";
      L.push(`  ${d.name}=${k}: n=${s.n} WR ${(s.wr * 100).toFixed(1)}% [${(w.lo * 100).toFixed(0)}-${(w.hi * 100).toFixed(0)}] vs BE ${(s.breakevenWr * 100).toFixed(1)}%${verdict}`);
    }
  }
  const blocks = ledgerBlocks(ledger);
  if (blocks.length) {
    L.push("BLOCKED BUCKETS (do not take these setups):");
    for (const b of blocks) L.push(`  ✗ ${b}`);
  }
  return L.join("\n");
}

/** Discount stated confidence by what that band actually delivered (when history exists). */
export function calibrateConfidence(
  stated: number,
  band?: { realizedHitPct?: number; n?: number }
): number {
  const s = Math.max(0, Math.min(100, Number(stated) || 0));
  if (band && band.n != null && band.n >= 20 && band.realizedHitPct != null) {
    return Math.round(band.realizedHitPct);
  }
  return Math.round(s * 0.9); // no history: shave the overconfidence
}

// ─────────────────────────────────────────────────────────────
// Position sizing
// ─────────────────────────────────────────────────────────────
export function positionSize(input: {
  capital?: number; riskPct?: number; entry: number; sl: number; lotSize: number;
}): {
  ok: boolean; lots: number; qty: number; riskAmount: number; riskPerLot: number;
  maxLoss: number; capitalRequired: number; guidance: string;
} {
  const capital = Number(input.capital) || GATE_CONFIG.capital;
  const riskPct = Math.min(GATE_CONFIG.maxRiskPct, Math.max(0.1, Number(input.riskPct) || GATE_CONFIG.defaultRiskPct));
  const entry = Number(input.entry);
  const sl = Number(input.sl);
  const lotSize = Number(input.lotSize);
  const riskAmount = (capital * riskPct) / 100;
  if (!(entry > 0) || !(lotSize > 0) || !Number.isFinite(entry - sl) || Math.abs(entry - sl) <= 0) {
    return {
      ok: false, lots: 0, qty: 0, riskAmount, riskPerLot: 0, maxLoss: 0, capitalRequired: 0,
      guidance: "Invalid entry/SL/lot-size (entry=SL or missing) — give a real stop, never guess.",
    };
  }
  const riskPerLot = Math.abs(entry - sl) * lotSize;
  const lots = Math.floor(riskAmount / riskPerLot);
  const maxLoss = riskPerLot * lots;
  const capitalRequired = entry * lotSize * lots;
  const guidance = lots >= 1
    ? `${lots} lot(s) × ${lotSize} = ${lots * lotSize} qty | max loss ₹${Math.round(maxLoss).toLocaleString("en-IN")} within ₹${Math.round(riskAmount).toLocaleString("en-IN")} budget (${riskPct}% of ₹${capital.toLocaleString("en-IN")}).`
    : `0 lots: ₹${Math.round(riskPerLot).toLocaleString("en-IN")} risk/lot exceeds the ₹${Math.round(riskAmount).toLocaleString("en-IN")} budget. Tighten the stop, pick a cheaper strike, or use a spread — NEVER risk more than ${riskPct}%.`;
  return { ok: lots >= 1, lots, qty: lots * lotSize, riskAmount, riskPerLot, maxLoss, capitalRequired, guidance };
}

// ─────────────────────────────────────────────────────────────
// Trade gate
// ─────────────────────────────────────────────────────────────
export type LayerState = "agree" | "against" | "neutral" | "unknown";
export interface GateLayer { state: LayerState; evidence: string }
export type Layer = GateLayer;
export interface GateInput {
  direction: string;                    // "call" | "put"
  confidence: number;
  asOfMs?: number;                      // replay: evaluate freshness at this instant instead of now
  layers: Record<"flow" | "structure" | "levels" | "greeksVix" | "trigger", GateLayer>;
  stamps: any[]; allLive: boolean;
  delta?: number; optionRR?: number; lots?: number; strikeDistanceSteps?: number;
  underlyingRR?: number; targetPts?: number; expectedMovePts?: number;
  vix?: number; regime?: string; isExpiryDay?: boolean; eventNear?: boolean;
  oiWallBeyondTarget?: boolean;
  capital?: number; consecutiveLosses?: number; dailyLossPct?: number;
  ledger?: LedgerRow[];
  hybrid?: boolean;                        // hybrid mode: soft checks (confidence, layer
                                            // agreement, unknown underlying R:R) become warnings —
                                            // the old brain generates, this gate only vetoes
}

export interface GateCheck {
  id: string; label: string; status: "pass" | "fail" | "warn" | "skip"; detail: string;
}
export interface GateResult {
  verdict: "TRADE" | "WAIT" | "SKIP";
  checks: GateCheck[];
  layersAgree: number; layersAgainst: number; layersUnknown: number;
  confidence: number; direction: string;
  warnings?: string[];
}

const LAYER_KEYS = ["flow", "structure", "levels", "greeksVix", "trigger"] as const;

export function evaluateTradeGate(input: GateInput): GateResult {
  const checks: GateCheck[] = [];
  const dir = String(input.direction || "").toLowerCase();
  const layers = input.layers || ({} as any);
  let agree = 0, against = 0, unknown = 0;
  for (const k of LAYER_KEYS) {
    const st = layers[k]?.state;
    if (st === "agree") agree++;
    else if (st === "against") against++;
    else if (st === "unknown" || st == null) unknown++;
  }

  // 1. Feed freshness — WAIT (stale/early, not a failed setup)
  const fresh = checkFreshness(input.allLive ? input.stamps : [], GATE_CONFIG.freshnessMaxMin, input.asOfMs ?? Date.now());
  if (!fresh.ok || !input.allLive) {
    checks.push({ id: "feed", label: "Live feed", status: "fail", detail: input.allLive ? fresh.reason : "all_live=false — withhold levels" });
  } else {
    checks.push({ id: "feed", label: "Live feed", status: "pass", detail: `feeds ${fresh.oldestMin} min old` });
  }

  // 2. Confidence floor — WAIT
  const conf = Number(input.confidence) || 0;
  if (conf < C_MINC()) {
    checks.push({ id: "confidence", label: `Confidence ≥ ${GATE_CONFIG.minConfidence}%`, status: "fail", detail: `stated ${conf}% below floor` });
  } else {
    checks.push({ id: "confidence", label: `Confidence ≥ ${GATE_CONFIG.minConfidence}%`, status: "pass", detail: `${conf}%` });
  }

  // 3. Layers — SKIP
  if (against > GATE_CONFIG.maxLayersAgainst) {
    checks.push({ id: "layers", label: "Layer agreement", status: "fail", detail: `${against} layers against (max ${GATE_CONFIG.maxLayersAgainst})` });
  } else if (agree < GATE_CONFIG.minLayersAgree) {
    checks.push({ id: "layers", label: "Layer agreement", status: "fail", detail: `only ${agree} agreeing (need ${GATE_CONFIG.minLayersAgree})` });
  } else {
    checks.push({ id: "layers", label: "Layer agreement", status: "pass", detail: `${agree} agree / ${against} against / ${unknown} unknown` });
  }

  // 4. Direction
  if (dir !== "call" && dir !== "put") {
    checks.push({ id: "direction", label: "Direction", status: "fail", detail: `invalid direction "${input.direction}"` });
  } else {
    checks.push({ id: "direction", label: "Direction", status: "pass", detail: dir });
  }

  // 5. Delta
  const delta = input.delta;
  if (delta == null || !Number.isFinite(Number(delta))) {
    checks.push({ id: "delta", label: `|delta| ≥ ${GATE_CONFIG.minAbsDelta}`, status: "fail", detail: "delta unknown — run strike_selector first" });
  } else if (Math.abs(Number(delta)) < GATE_CONFIG.minAbsDelta) {
    checks.push({ id: "delta", label: `|delta| ≥ ${GATE_CONFIG.minAbsDelta}`, status: "fail", detail: `|delta| ${Math.abs(Number(delta)).toFixed(2)} = lottery ticket` });
  } else {
    checks.push({ id: "delta", label: `|delta| ≥ ${GATE_CONFIG.minAbsDelta}`, status: "pass", detail: `|delta| ${Math.abs(Number(delta)).toFixed(2)}` });
  }

  // 6. Strike distance
  const steps = input.strikeDistanceSteps;
  if (steps == null || !Number.isFinite(Number(steps))) {
    checks.push({ id: "strike_distance", label: `OTM ≤ ${GATE_CONFIG.maxOtmSteps} steps`, status: "fail", detail: "strike distance unknown" });
  } else if (Number(steps) > GATE_CONFIG.maxOtmSteps) {
    checks.push({ id: "strike_distance", label: `OTM ≤ ${GATE_CONFIG.maxOtmSteps} steps`, status: "fail", detail: `${steps} steps OTM` });
  } else {
    checks.push({ id: "strike_distance", label: `OTM ≤ ${GATE_CONFIG.maxOtmSteps} steps`, status: "pass", detail: `${steps} steps from ATM` });
  }

  // 7. Option R:R
  const orr = Number(input.optionRR);
  if (!Number.isFinite(orr) || orr < GATE_CONFIG.minOptionRR) {
    checks.push({ id: "option_rr", label: `Option R:R ≥ ${GATE_CONFIG.minOptionRR}`, status: "fail", detail: `got ${Number.isFinite(orr) ? orr.toFixed(2) : "unknown"} after repricing` });
  } else {
    checks.push({ id: "option_rr", label: `Option R:R ≥ ${GATE_CONFIG.minOptionRR}`, status: "pass", detail: orr.toFixed(2) });
  }

  // 8. Underlying R:R
  {
    const urrV = Number(input.underlyingRR);
    if (!Number.isFinite(urrV) || urrV < GATE_CONFIG.minUnderlyingRR) {
      checks.push({ id: "underlying_rr", label: `Underlying R:R ≥ 1:${GATE_CONFIG.minUnderlyingRR}`, status: "fail", detail: `got ${Number.isFinite(urrV) ? urrV.toFixed(2) : "unknown"}` });
    } else {
      checks.push({ id: "underlying_rr", label: `Underlying R:R ≥ 1:${GATE_CONFIG.minUnderlyingRR}`, status: "pass", detail: urrV.toFixed(2) });
    }
  }

  // 9. Target within VIX expected move — warn
  const target = Number(input.targetPts), em = Number(input.expectedMovePts);
  if (Number.isFinite(target) && Number.isFinite(em) && em > 0 && target > em) {
    checks.push({ id: "expected_move", label: "Target within VIX expected move", status: "warn", detail: `target ${target} pts > expected move ${em} pts — trim target or skip` });
  } else {
    checks.push({ id: "expected_move", label: "Target within VIX expected move", status: "pass", detail: Number.isFinite(em) ? `target ${target} / EM ${em}` : "no EM given" });
  }

  // 10. Expiry day
  if (input.isExpiryDay && !GATE_CONFIG.allowExpiryDay) {
    checks.push({ id: "expiry", label: "Not expiry day", status: "fail", detail: "expiry-day gamma lottery — avoid unless tested edge" });
  } else {
    checks.push({ id: "expiry", label: "Not expiry day", status: "pass", detail: input.isExpiryDay ? "allowed by config" : "regular day" });
  }

  // 11. Event near
  if (input.eventNear) {
    checks.push({ id: "event", label: "No event within hold", status: "fail", detail: "event risk (RBI/results/Budget) — IV crush can lose even when right" });
  } else {
    checks.push({ id: "event", label: "No event within hold", status: "pass", detail: "none flagged" });
  }

  // 12. Regime — warn (halve size, never a silent pass)
  const regime = String(input.regime || "").toLowerCase();
  if (regime && /chopp|range|sideways|uncertain/.test(regime)) {
    checks.push({ id: "regime", label: "Regime friendly", status: "warn", detail: `regime ${input.regime} — halve size or skip` });
  } else {
    checks.push({ id: "regime", label: "Regime friendly", status: "pass", detail: regime || "unknown (warn)" });
  }

  // 13. VIX band — warn above 25
  const vix = Number(input.vix);
  if (Number.isFinite(vix) && vix > 25) {
    checks.push({ id: "vix", label: "VIX sane", status: "warn", detail: `VIX ${vix} — halve size, widen nothing` });
  } else {
    checks.push({ id: "vix", label: "VIX sane", status: "pass", detail: Number.isFinite(vix) ? `VIX ${vix}` : "unknown" });
  }

  // 14. OI wall beyond target — warn
  if (input.oiWallBeyondTarget) {
    checks.push({ id: "oi_wall", label: "No major OI wall between entry and target", status: "warn", detail: "a not-weakening wall sits before target — trim or expect stall" });
  } else {
    checks.push({ id: "oi_wall", label: "No major OI wall between entry and target", status: "pass", detail: "path clear" });
  }

  // 15. Risk budget / lots
  const lots = Number(input.lots);
  if (!Number.isFinite(lots) || lots < 1) {
    checks.push({ id: "risk_budget", label: "Lots inside risk budget", status: "fail", detail: "0 lots — tighten stop / cheaper strike / spread, never risk more" });
  } else {
    checks.push({ id: "risk_budget", label: "Lots inside risk budget", status: "pass", detail: `${lots} lot(s)` });
  }

  // 16. Consecutive losses / daily loss
  const cl = Number(input.consecutiveLosses) || 0;
  if (cl >= GATE_CONFIG.maxConsecutiveLosses) {
    checks.push({ id: "consecutive_losses", label: "Loss streak", status: "fail", detail: `${cl} consecutive losses — stop trading for the session` });
  } else {
    checks.push({ id: "consecutive_losses", label: "Loss streak", status: "pass", detail: `${cl} in a row (max ${GATE_CONFIG.maxConsecutiveLosses})` });
  }
  const dlp = Number(input.dailyLossPct) || 0;
  if (dlp <= -GATE_CONFIG.maxDailyLossPct) {
    checks.push({ id: "daily_loss", label: "Daily loss cap", status: "fail", detail: `down ${dlp.toFixed(1)}% today (cap ${GATE_CONFIG.maxDailyLossPct}%) — done for the day` });
  } else {
    checks.push({ id: "daily_loss", label: "Daily loss cap", status: "pass", detail: `${dlp.toFixed(1)}% today` });
  }

  // 17. Ledger bucket veto
  if (input.ledger && input.ledger.length) {
    const blocks = ledgerBlocks(input.ledger).filter((b) => {
      const reg = String(input.regime ?? "");
      return !reg || b.includes(reg);
    });
    if (blocks.length) {
      checks.push({ id: "ledger_bucket", label: "Ledger bucket healthy", status: "fail", detail: blocks[0] });
    } else {
      checks.push({ id: "ledger_bucket", label: "Ledger bucket healthy", status: "pass", detail: "no blocked bucket matches this setup" });
    }
  }

  // HYBRID MODE: the old brain (scanners / SDM / Zero Hero) generates candidates.
  // This gate then only vetoes on HARD safety failures (bad R:R, expiry-day, risk
  // budget, loss streak…). Soft signals — confidence below the floor, layer agreement
  // short of 3-of-5, unknown underlying R:R — become WARNINGS so a sound setup is
  // not silently swallowed. Strict mode (default) is unchanged.
  const warnings: string[] = [];
  if (input.hybrid) {
    for (const c of checks) {
      if (c.status !== "fail") continue;
      const soft = c.id === "confidence" || c.id === "layers" || (c.id === "underlying_rr" && /unknown/i.test(c.detail));
      if (!soft) continue;
      c.status = "warn";
      c.detail = `soft: ${c.detail}`;
      warnings.push(`${c.label}: ${c.detail}`);
    }
  }

  // Verdict: feed/confidence fail → WAIT; any other fail → SKIP; warns allowed with TRADE
  const fails = checks.filter((c) => c.status === "fail");
  const waitIds = new Set(["feed", "confidence"]);
  const verdict: GateResult["verdict"] =
    fails.some((c) => !waitIds.has(c.id)) ? "SKIP"
    : fails.length ? "WAIT"
    : "TRADE";

  return { verdict, checks, layersAgree: agree, layersAgainst: against, layersUnknown: unknown, confidence: conf, direction: dir, warnings };
}

function C_MINC() { return GATE_CONFIG.minConfidence; }

export function formatGate(res: GateResult): string {
  const icon = res.verdict === "TRADE" ? "✅" : res.verdict === "WAIT" ? "⏳" : "⛔";
  const L: string[] = [];
  L.push(`${icon} GATE: ${res.verdict} — ${res.direction?.toUpperCase() || "?"} @ confidence ${res.confidence}%`);
  L.push(`Layers: ${res.layersAgree} agree / ${res.layersAgainst} against / ${res.layersUnknown} unknown`);
  for (const c of res.checks) {
    const m = c.status === "pass" ? "✓" : c.status === "warn" ? "!" : c.status === "fail" ? "✗" : "-";
    if (c.status !== "pass") L.push(`  ${m} ${c.label}: ${c.detail}`);
  }
  if (res.verdict === "WAIT") L.push("WAIT means: say what is stale or early. Do NOT quote entry/SL/TP.");
  if (res.verdict === "SKIP") L.push("SKIP means: name the failed checks. \"No trade\" is a normal, correct answer.");
  if (res.verdict === "TRADE") {
    L.push("Gate passed. Present the signal with entry/SL/TP from strike_selector's numbers — never your own.");
    if (res.warnings?.length) L.push(`Soft warnings (not blocks) — mention them and HALVE the size: ${res.warnings.join(" | ")}`);
  }
  return L.join("\n");
}

// ─────────────────────────────────────────────────────────────
// Run state + guards
// ─────────────────────────────────────────────────────────────
export interface AgentRunState {
  userMessage: string;
  startedAt: number;
  intent: "trade" | "telegram" | "session" | "query";
  toolCalls: string[];
  lastStrike?: {
    delta?: number; optionRR?: number; lots?: number; strike?: number;
    type?: string; entry?: number; strikeDistanceSteps?: number;
  };
  lastChain?: any;
  lastTech?: any;
  lastGate?: GateResult;
  lastGateAt?: number;
  signalsIssued: number;
}

const TRADE_RE = /\b(buy|sell|long|short|entry|enter|signal|trade|ce|pe|call|put|strike|kharid|kharidna|lena|bech|bechna|lot|position)\b/i;
const TELEGRAM_RE = /\b(telegram|send|bhej|bhejo|whatsapp|alert me|notify)\b/i;
const SESSION_RE = /\b(set .*(session|token)|session set|breeze (login|session|token)|re-?auth)\b/i;

export function newRunState(userMessage: string): AgentRunState {
  const m = String(userMessage || "");
  const intent: AgentRunState["intent"] = SESSION_RE.test(m) ? "session"
    : TELEGRAM_RE.test(m) ? "telegram"
    : TRADE_RE.test(m) ? "trade"
    : "query";
  return { userMessage: m, startedAt: Date.now(), intent, toolCalls: [], signalsIssued: 0 };
}

const SIDE_EFFECT_TOOLS = new Set(["send_telegram_signal", "morning_scan", "record_trade_memory", "set_breeze_session", "place_order", "cancel_order"]);
const LOCAL_HOST_RE = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)([:/]|$)/i;

export function guardToolCall(
  name: string,
  args: any,
  state: AgentRunState,
  _base: string
): { allow: boolean; reason?: string } {
  const a = args || {};
  if (name === "test_api_endpoint") {
    const url = String(a.url || a.endpoint || "");
    if (!url) return { allow: false, reason: "url required" };
    if (!LOCAL_HOST_RE.test(url)) {
      return { allow: false, reason: "SSRF guard: only http(s)://127.0.0.1 or localhost URLs are allowed" };
    }
    return { allow: true };
  }
  if (name === "set_breeze_session") {
    const token = String(a.token || a.sessionToken || "").trim();
    if (!token) return { allow: false, reason: "token required (paste the Breeze session token)" };
    return { allow: true };
  }
  if (name === "send_telegram_signal" || name === "morning_scan") {
    const okIntent = state.intent === "telegram" || state.intent === "trade" && /\b(send|telegram|bhej|alert|notify)\b/i.test(state.userMessage);
    if (!okIntent) {
      return { allow: false, reason: "user did not ask to send/alert — ask first, never push signals unprompted" };
    }
    return { allow: true };
  }
  if (name === "record_trade_memory") {
    if (state.intent === "query") {
      return { allow: false, reason: "record_trade_memory needs an explicit trade/prediction to remember" };
    }
    return { allow: true };
  }
  if (SIDE_EFFECT_TOOLS.has(name)) {
    if (state.intent === "query") return { allow: false, reason: `${name} is a side-effect tool — only on explicit user request` };
  }
  // generic SSRF: any url-looking arg must stay local
  for (const k of ["url", "endpoint", "webhook"]) {
    if (typeof a[k] === "string" && /^https?:\/\//i.test(a[k]) && !LOCAL_HOST_RE.test(a[k])) {
      return { allow: false, reason: `SSRF guard: ${k} must be a local address` };
    }
  }
  return { allow: true };
}

export function wrapToolResult(name: string, text: string): string {
  const s = String(text ?? "");
  if (s.length <= GATE_CONFIG.maxToolResultChars) return s;
  return s.slice(0, GATE_CONFIG.maxToolResultChars) + `\n…[${name} truncated: ${s.length} chars total]`;
}

const SIGNAL_RE = /🎯\s*TRADE SIGNAL/i;

/** Strip any 🎯 TRADE SIGNAL from a response when the gate did not pass. */
export function enforceSignalPolicy(text: string, state: AgentRunState): string {
  const t = String(text ?? "");
  if (!SIGNAL_RE.test(t)) return t;
  const gatePassed = state.lastGate?.verdict === "TRADE" && state.lastGateAt && Date.now() - state.lastGateAt < 10 * 60_000;
  if (gatePassed) return t;
  const cleaned = t
    .split("\n")
    .filter((line) => !/🎯\s*TRADE SIGNAL|^(Entry|SL|TP1|TP2|TP3|R:R):/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const note = "⚠️ Signal withheld: evaluate_trade_gate has not returned TRADE this turn. Run strike_selector → evaluate_trade_gate, then present only what the gate passes. \"No trade\" is fine.";
  return `${cleaned}\n\n${note}`.trim();
}

// ─────────────────────────────────────────────────────────────
// Tool selection v2 — scored, capped, no padding, side-effects gated
// ─────────────────────────────────────────────────────────────
const CORE_V2 = ["get_sdm_signal", "get_option_chain", "get_market_structure"];

const TOOL_PATTERNS: Array<[string, RegExp]> = [
  ["get_vix", /\bvix\b|india vix|volatility index/i],
  ["get_fii_dii", /\bfii\b|\bdii\b|foreign institutional|institutional flow/i],
  ["get_option_chain", /\boption chain\b|\boi\b|open interest|max pain|pcr\b|strike/i],
  ["read_option_chain", /\bread the chain\b|chain read|support.*resistance|resistance.*support|walls?\b|writing|buying zones/i],
  ["get_market_structure", /\bstructure\b|market structure|hh\s*\/\s*hl|higher (high|low)|vwap\b|supertrend|support|resistance/i],
  ["get_atm_straddle", /\batm straddle\b|straddle\b/i],
  ["get_cas_analysis", /\bcas\b|dislocation/i],
  ["get_expiry_liquidity", /\bexpiry\b|liquidity shift/i],
  ["get_market_regime", /\bregime\b|trending|choppy|market environment/i],
  ["get_market_breadth", /\bbreadth\b|advances|declines/i],
  ["get_options_edge", /\boptions edge\b|greeks? flow|dealer/i],
  ["strike_selector", /\bwhich strike\b|strike (selector|for|to)|atm or|otm\b|itm\b|kis strike|strike chahiye|lot size|how many lots|kharid(na|u)?\b|lena hai|bech(na|u)?\b/i],
  ["read_playbook", /\bplaybook\b|checklist|black.?scholes|formula|reference (doc|file|docs)|deep scoring|scoring checklist/i],
  ["hedge_calculator", /\bhedge\b|hedging|debit spread|portfolio hedge|lock (profit|loss)/i],
  ["evaluate_trade_gate", /\bshould i (buy|sell|take|enter)|gate\b|evaluate (the )?trade|trade gate|can i (buy|sell)|kharid(na|u)?|lena hai|bech(na|u)?/i],
  ["check_live_feed", /\blive feed\b|feed (status|down|up|health)|all_live|freshness/i],
  ["check_indicators", /\bsupertrend\b|ema cross|vwap\b|liquidity (pool|sweep)|equal (highs|lows)|\bbos\b|choch|fair value gap|indicator(s)? (read|check)|is the trend/i],
  ["backtest_indicator", /\bbacktest (the )?(indicator|signal)|indicator edge|did .* (indicator|supertrend|ema cross) work/i],
  ["ledger_edge_report", /\bledger\b|edge report|win rate by|which (regime|window|bucket)|break.?even/i],
  ["get_trade_journal", /\bjournal\b|trade history|my trades/i],
  ["get_trade_post_mortem", /\bpost.?mortem\b|why did .* lose|review (my|the) (trade|loss)/i],
  ["get_risk_status", /\brisk\b|position size|risk per trade|drawdown/i],
  ["get_portfolio", /\bportfolio\b|positions\b|holdings/i],
  ["get_sdm_signal", /\bsdm\b|signal quality|recommendation/i],
  ["get_news_sentiment", /\bnews\b|sentiment\b|headlines?/i],
  ["search_memory", /\bremember\b|memory\b|past (trades?|predictions?)|previously i/i],
  ["get_scanner_picks", /\bscanner\b|picks\b|top (gainers|losers)|opportunities/i],
  ["check_session_tokens", /\bsession\b|token\b|login|breeze auth|totp|otp\b/i],
  ["get_gift_nifty", /\bgift nifty\b|sgx/i],
  ["get_most_active_contracts", /\bmost active\b|active contracts/i],
];

const SIDE_EFFECT_V2 = new Set(["send_telegram_signal", "morning_scan", "set_breeze_session", "record_trade_memory", "place_order", "cancel_order"]);
const SIDE_EFFECT_INTENT_RE = /\b(send|telegram|bhej|bhejo|alert|notify|record|remember this|set (breeze )?session)\b/i;

export function selectToolsV2(message: string, tools: Array<{ function: { name: string } }>): any[] {
  const msg = String(message || "");
  const available = new Map(tools.map((t) => [t.function.name, t]));
  const chosen = new Set<string>();

  for (const name of CORE_V2) {
    if (available.has(name)) chosen.add(name);
  }
  for (const [name, re] of TOOL_PATTERNS) {
    if (chosen.size >= GATE_CONFIG.maxToolsPerRequest) break;
    if (available.has(name) && re.test(msg)) chosen.add(name);
  }
  if (SIDE_EFFECT_INTENT_RE.test(msg)) {
    for (const name of SIDE_EFFECT_V2) {
      if (available.has(name) && /telegram|send|bhej/i.test(msg)) chosen.add(name);
      if (available.has(name) && /set (breeze )?session|session token/i.test(msg) && /set|token|session/i.test(msg)) chosen.add(name);
    }
  }
  // Cap — never pad up
  const out = [...chosen].slice(0, GATE_CONFIG.maxToolsPerRequest).map((n) => available.get(n)!).filter(Boolean);
  return out;
}

// ─────────────────────────────────────────────────────────────
// Technical helpers (correct math)
// ─────────────────────────────────────────────────────────────
export function atr(candles: Array<{ high: number; low: number; close: number }>, period = 14): number {
  if (!candles || candles.length < 2) return 0;
  const n = Math.min(period, candles.length - 1);
  let sum = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    if (!c || !prev) continue;
    const h = Number(c.high) || 0, l = Number(c.low) || 0, pc = Number(prev.close) || 0;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return sum / n;
}

export function vixBand(vix: number): { band: "LOW" | "NORMAL" | "ELEVATED" | "EXTREME"; text: string } {
  const v = Number(vix) || 0;
  if (v > 30) return { band: "EXTREME", text: `VIX ${v} — EXTREME volatility: halve size, expect 2× the usual move, prefer no new premium buys` };
  if (v > 20) return { band: "ELEVATED", text: `VIX ${v} — ELEVATED volatility: halve position size, stop wider in points but same rupee risk` };
  if (v > 12) return { band: "NORMAL", text: `VIX ${v} — NORMAL volatility band (thresholds, not a percentile)` };
  return { band: "LOW", text: `VIX ${v} — LOW volatility: premiums cheap but moves are small; tighten targets` };
}

export function postMortem(input: {
  entry: number; exit: number; stopPremium?: number; direction?: string;
  mfePremium?: number; stopMoved?: boolean; averagedDown?: boolean; enteredFirst15?: boolean;
  daysToExpiry?: number;
}): { rMultiple: number; mfeMultiple?: number; learnings: string[] } {
  const entry = Number(input.entry), exit = Number(input.exit);
  const stop = Number(input.stopPremium);
  const dir = String(input.direction || "call").toLowerCase();
  const sign = dir.startsWith("p") || dir === "sell" || dir === "short" ? -1 : 1;
  const risk = Number.isFinite(stop) && Math.abs(entry - stop) > 0 ? Math.abs(entry - stop) : 0;
  const pnlPts = (exit - entry) * sign;
  const rMultiple = risk > 0 ? pnlPts / risk : 0;
  const mfe = Number(input.mfePremium);
  const mfeMultiple = risk > 0 && Number.isFinite(mfe) ? ((mfe - entry) * sign) / risk : undefined;
  const learnings: string[] = [];
  if (risk <= 0) learnings.push("No stop recorded — R is undefined. Always record the stop at entry.");
  if (input.stopMoved) learnings.push("Stop was moved after entry. Hard rule: never widen a stop.");
  if (input.averagedDown) learnings.push("Averaged down a losing option. Never average down premium.");
  if (input.enteredFirst15) learnings.push("Entered in the first 15 minutes — playbook says wait for the opening range.");
  if (mfeMultiple != null && mfeMultiple >= 1 && pnlPts <= 0) {
    learnings.push(`MFE was +${mfeMultiple.toFixed(1)}R but the trade closed ≤ breakeven — exit discipline / time stop failed.`);
  }
  if (rMultiple >= 1) learnings.push(`Closed +${rMultiple.toFixed(1)}R — process worked; repeat the same layers.`);
  if (rMultiple < 0) learnings.push(`Closed ${rMultiple.toFixed(1)}R — check which layer was actually wrong (direction, regime, timing).`);
  return { rMultiple, mfeMultiple, learnings };
}

export function otmSteps(dir: "call" | "put", strike: number, spot: number, symbol: string): number {
  const step = STRIKE_STEP[String(symbol || "").toUpperCase()] || 0;
  const diff = Number(strike) - Number(spot);
  const steps = step > 0 ? Math.round(Math.abs(diff) / step) : Math.round(Math.abs(diff) / 50);
  const otm = dir === "call" ? diff > 0 : diff < 0;
  return otm ? steps : 0;
}

export function journalRiskState(trades: any[], asOfMs?: number): { consecutiveLosses: number; dailyLossPct: number; avgPnl: number } {
  let closed = (trades || []).filter((t) => t && (t.status === "closed" || t.pnl != null));
  const day = new Date(asOfMs ?? Date.now()).toISOString().slice(0, 10);
  if (asOfMs != null) {
    // replay: drop trades that closed AFTER the as-of day — the past must not see the future
    closed = closed.filter((t) => {
      const d = String(t.closedAt || t.updatedAt || t.date || "").slice(0, 10);
      return !d || d <= day;
    });
  }
  let consecutiveLosses = 0;
  // most recent first
  const sorted = [...closed].sort((a, b) => String(b.closedAt || b.updatedAt || "").localeCompare(String(a.closedAt || a.updatedAt || "")));
  for (const t of sorted) {
    if ((Number(t.pnl) || 0) < 0) consecutiveLosses++;
    else break;
  }
  const todayPnl = closed
    .filter((t) => String(t.closedAt || t.updatedAt || t.date || "").slice(0, 10) === day)
    .reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const avgPnl = closed.length ? closed.reduce((s, t) => s + (Number(t.pnl) || 0), 0) / closed.length : 0;
  return { consecutiveLosses, dailyLossPct: (todayPnl / GATE_CONFIG.capital) * 100, avgPnl };
}

export function parseFeedHealth(json: any): { allLive: boolean; marketOpen: boolean; overall: string; stamps: any[]; summary: string } {
  const meta = json?.meta || {};
  const feeds = json?.feeds || {};
  const stamps: any[] = [];
  for (const f of Object.values<any>(feeds)) {
    const s = f?.last_update ?? f?.updated ?? f?.as_of ?? f?.asOf ?? f?.t;
    if (s != null) stamps.push(s);
  }
  if (meta.generated_at) stamps.push(meta.generated_at);
  const allLive = !!meta.all_live;
  const marketOpen = !!meta.market_open;
  const overall = String(meta.overall || (allLive ? "LIVE" : "UNKNOWN"));
  const summary = `overall=${overall} all_live=${allLive} market_open=${marketOpen} feeds=${Object.keys(feeds).length}`;
  return { allLive, marketOpen, overall, stamps, summary };
}

// ─────────────────────────────────────────────────────────────
// Tool definitions (drop into AGENT_TOOLS)
// ─────────────────────────────────────────────────────────────
export const NEW_TOOLS = [
  {
    type: "function",
    function: {
      name: "check_live_feed",
      description: "Probe the Live Option Data Service (127.0.0.1:8765/health) for freshness. Run BEFORE quoting any entry/SL/TP levels. If down, withhold levels.",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "evaluate_trade_gate",
      description:
        "Deterministic trade discipline gate. Run AFTER strike_selector and BEFORE any 🎯 TRADE SIGNAL. Verdict is TRADE / WAIT / SKIP — only TRADE may be presented as a signal. Pass layer states honestly (agree/against/neutral/unknown) with evidence.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", description: "call | put" },
          confidence: { type: "number" },
          flow: { type: "string" }, flowEvidence: { type: "string" },
          structure: { type: "string" }, structureEvidence: { type: "string" },
          levels: { type: "string" }, levelsEvidence: { type: "string" },
          greeksVix: { type: "string" }, greeksVixEvidence: { type: "string" },
          trigger: { type: "string" }, triggerEvidence: { type: "string" },
          underlyingRR: { type: "number" }, targetPts: { type: "number" }, expectedMovePts: { type: "number" },
          regime: { type: "string" }, isExpiryDay: { type: "boolean" }, eventNear: { type: "boolean" },
          oiWallBeyondTarget: { type: "boolean" },
        },
        required: ["direction", "confidence"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ledger_edge_report",
      description: "Win-rate vs break-even from the trade journal, bucketed by regime / window / strike distance. Use before recommending a setup that historically loses.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];
