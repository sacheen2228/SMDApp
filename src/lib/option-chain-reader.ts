// option-chain-reader.ts
// Teaches the SDM agent to READ an option chain deterministically:
//  - support / resistance from OI walls (+ whether each wall is strengthening or weakening)
//  - where CE / PE BUYING vs WRITING is happening (OI change × premium change × volume)
//  - PCR level + trend, bias lean, Greek sanity checks
//  - feeds the trade gate (levels layer + "OI wall between entry and target")
// Educational framework, not financial advice. OI cannot prove who is buyer vs writer —
// every classification here is an INFERENCE from price behaviour and is labelled that way.

import { getJSON, safeSymbol, enc, STRIKE_STEP } from "./agent-brain-gate";

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
export const CHAIN_CFG = {
  windowPct: 5,          // only look ±5% around spot for walls / zones
  minRelOi: 0.10,        // ignore strikes with < 10% of the side's max OI (illiquid)
  materialOiChg: 0.05,   // |ΔOI| ≥ 5% of strike OI counts as real change
  nearWallPct: 0.30,     // spot within 0.3% of a strengthening wall = "pressed against it"
  strongWallShare: 0.6,  // wall OI ≥ 60% of side max = major wall
  pcrFlat: 0.03,
  snapshotKeep: 40,
};

// ─────────────────────────────────────────────────────────────
// Types + tolerant normaliser (ADAPT field names to your /api/option-chain payload)
// ─────────────────────────────────────────────────────────────
export interface Leg { oi: number; oiChange?: number; ltp?: number; ltpChange?: number; volume?: number; iv?: number; delta?: number }
export interface Row { strike: number; ce: Leg; pe: Leg }
export interface NormChain {
  symbol: string; spot: number; rows: Row[]; pcr?: number; maxPain?: number; atm?: number; vix?: number;
  asOf?: number | string | null; derivedChange: boolean;
}

const num = (v: any): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function toLeg(raw: any): Leg {
  return {
    oi: num(raw?.oi ?? raw?.openInterest) ?? 0,
    oiChange: num(raw?.oiChange ?? raw?.changeInOI ?? raw?.changeinOpenInterest ?? raw?.chngInOI ?? raw?.oi_change),
    ltp: num(raw?.ltp ?? raw?.lastPrice),
    ltpChange: num(raw?.change ?? raw?.ltpChange ?? raw?.priceChange),
    volume: num(raw?.volume ?? raw?.totalTradedVolume),
    iv: num(raw?.iv ?? raw?.impliedVolatility),
    delta: num(raw?.delta),
  };
}

export function normalizeChain(json: any, symbolIn: string): NormChain | null {
  const d = json?.data ?? json;
  const strikes: any[] = d?.strikes ?? [];
  const spot = num(d?.spotPrice ?? d?.spot ?? d?.underlyingValue);
  if (!strikes.length || !spot) return null;
  const rows: Row[] = strikes
    .map((s) => ({ strike: Number(s.strike), ce: toLeg(s.ce), pe: toLeg(s.pe) }))
    .filter((r) => Number.isFinite(r.strike))
    .sort((a, b) => a.strike - b.strike);
  const sm = d?.summary ?? {};
  const cOI = rows.reduce((s, r) => s + r.ce.oi, 0);
  const pOI = rows.reduce((s, r) => s + r.pe.oi, 0);
  return {
    symbol: symbolIn, spot, rows,
    pcr: num(sm.pcr ?? d?.pcr) ?? (cOI > 0 ? pOI / cOI : undefined),
    maxPain: num(sm.maxPain), atm: num(sm.atmStrike), vix: num(sm.indiaVIX ?? d?.indiaVIX),
    asOf: d?.timestamp ?? d?.asOf ?? json?.timestamp ?? null,
    derivedChange: false,
  };
}

// ─────────────────────────────────────────────────────────────
// Snapshots — "compare every 15-30 min, not every minute".
// If the API gives no change-in-OI, derive it from our own earlier snapshot.
// (In-memory: fine for a long-running server; use Redis/DB on serverless.)
// ─────────────────────────────────────────────────────────────
interface Snap { t: number; spot: number; pcr?: number; m: Map<number, { ceOi: number; peOi: number; ceLtp?: number; peLtp?: number }> }
const SNAPS = new Map<string, Snap[]>();

export function recordSnapshot(c: NormChain, nowMs = Date.now()) {
  const arr = SNAPS.get(c.symbol) ?? [];
  const m = new Map<number, { ceOi: number; peOi: number; ceLtp?: number; peLtp?: number }>();
  for (const r of c.rows) m.set(r.strike, { ceOi: r.ce.oi, peOi: r.pe.oi, ceLtp: r.ce.ltp, peLtp: r.pe.ltp });
  arr.push({ t: nowMs, spot: c.spot, pcr: c.pcr, m });
  const cutoff = nowMs - 3 * 3600_000;
  SNAPS.set(c.symbol, arr.filter((s) => s.t >= cutoff).slice(-CHAIN_CFG.snapshotKeep));
}

export function baselineSnap(symbol: string, windowMin: number, nowMs = Date.now()): Snap | undefined {
  const arr = SNAPS.get(symbol) ?? [];
  const minAge = windowMin * 0.6 * 60_000;
  const target = nowMs - windowMin * 60_000;
  const old = arr.filter((s) => nowMs - s.t >= minAge);
  if (!old.length) return undefined;
  return old.reduce((best, s) => (Math.abs(s.t - target) < Math.abs(best.t - target) ? s : best));
}

/** Fill oiChange / ltpChange from a prior snapshot when the API doesn't provide them. */
export function fillChanges(c: NormChain, base?: Snap): void {
  const hasApiChange = c.rows.some((r) => r.ce.oiChange != null || r.pe.oiChange != null);
  if (hasApiChange || !base) return;
  c.derivedChange = true;
  for (const r of c.rows) {
    const b = base.m.get(r.strike);
    if (!b) continue;
    r.ce.oiChange = r.ce.oi - b.ceOi; r.pe.oiChange = r.pe.oi - b.peOi;
    if (r.ce.ltp != null && b.ceLtp != null) r.ce.ltpChange = r.ce.ltp - b.ceLtp;
    if (r.pe.ltp != null && b.peLtp != null) r.pe.ltpChange = r.pe.ltp - b.peLtp;
  }
}

// ─────────────────────────────────────────────────────────────
// Classification: what is happening AT a strike?
//   OI↑ + premium↑ → BUYING         OI↑ + premium↓ → WRITING
//   OI↓ + premium↑ → SHORT_COVERING OI↓ + premium↓ → LONG_UNWINDING
// ─────────────────────────────────────────────────────────────
export type Activity = "BUYING" | "WRITING" | "SHORT_COVERING" | "LONG_UNWINDING" | "QUIET";

export function classify(l: Leg, sideMaxOi: number): Activity {
  if (l.oiChange == null || l.ltpChange == null || l.ltpChange === 0) return "QUIET";
  if (l.oi < CHAIN_CFG.minRelOi * sideMaxOi) return "QUIET";               // illiquid
  if (Math.abs(l.oiChange) / Math.max(1, l.oi) < CHAIN_CFG.materialOiChg) return "QUIET";
  if (l.oiChange > 0) return l.ltpChange > 0 ? "BUYING" : "WRITING";
  return l.ltpChange > 0 ? "SHORT_COVERING" : "LONG_UNWINDING";
}

export type WallTrend = "STRENGTHENING" | "WEAKENING" | "STABLE" | "UNKNOWN";
export interface Wall {
  strike: number; side: "support" | "resistance"; oi: number; oiChange?: number;
  share: number; trend: WallTrend; activity: Activity; distPts: number; distPct: number;
}
export interface Zone { strike: number; side: "CE" | "PE"; activity: Activity; oiChange?: number; ltpChange?: number; volume?: number; ltp?: number }

export interface ChainAnalysis {
  symbol: string; spot: number; atm: number; asOf: any; derivedChange: boolean; baselineMinAgo?: number;
  supports: Wall[]; resistances: Wall[];
  freshPutWriting: Zone[]; freshCallWriting: Zone[];
  ceBuying: Zone[]; peBuying: Zone[];
  pcr?: number; pcrTrend: "RISING" | "FALLING" | "FLAT" | "UNKNOWN"; pcrDelta?: number;
  maxPain?: number; vix?: number;
  score: number; bias: "BULLISH_LEAN" | "BEARISH_LEAN" | "NEUTRAL" | "UNKNOWN"; evidence: string[];
  atmGreeks: { ce: Leg; pe: Leg; notes: string[] } | null;
}

function wallTrend(l: Leg): WallTrend {
  if (l.oiChange == null) return "UNKNOWN";
  const rel = l.oiChange / Math.max(1, l.oi);
  return rel >= CHAIN_CFG.materialOiChg ? "STRENGTHENING" : rel <= -CHAIN_CFG.materialOiChg ? "WEAKENING" : "STABLE";
}

function nearestAtm(rows: Row[], spot: number, symbol: string): number {
  const step = STRIKE_STEP[symbol.toUpperCase()];
  if (step) return Math.round(spot / step) * step;
  return rows.reduce((b, r) => (Math.abs(r.strike - spot) < Math.abs(b - spot) ? r.strike : b), rows[0].strike);
}

/** Playbook pre-buy Greek checklist on one leg. */
export function greekCheck(l: Leg, daysToExpiry?: number): string[] {
  const n: string[] = [];
  if (l.delta != null) {
    const ad = Math.abs(l.delta);
    if (ad < 0.35) n.push(`|delta| ${ad.toFixed(2)} < 0.35 → lottery ticket, avoid`);
    else if (ad < 0.45) n.push(`|delta| ${ad.toFixed(2)} — below the 0.45-0.65 sweet spot (needs a bigger move)`);
    else if (ad <= 0.65) n.push(`|delta| ${ad.toFixed(2)} ✓ in the 0.45-0.65 range`);
    else n.push(`|delta| ${ad.toFixed(2)} — deep ITM: expensive premium, low theta per delta`);
  }
  if (daysToExpiry != null) {
    if (daysToExpiry <= 0) n.push("expiry day: gamma-heavy, theta brutal — avoid until you have a tested edge");
    else if (daysToExpiry <= 2) n.push(`${daysToExpiry}d to expiry: you need the move immediately; use a 20-30 min time stop`);
  }
  if (l.iv != null) n.push(`IV ${l.iv.toFixed(1)}% — check IV percentile/rank; high IV = expensive, IV crush risk around events`);
  return n;
}

export function analyze(c: NormChain, base?: Snap, daysToExpiry?: number): ChainAnalysis {
  const { spot } = c;
  const lo = spot * (1 - CHAIN_CFG.windowPct / 100), hi = spot * (1 + CHAIN_CFG.windowPct / 100);
  const near = c.rows.filter((r) => r.strike >= lo && r.strike <= hi);
  const maxCe = Math.max(1, ...near.map((r) => r.ce.oi));
  const maxPe = Math.max(1, ...near.map((r) => r.pe.oi));
  const atm = c.atm ?? nearestAtm(c.rows, spot, c.symbol);

  const mkWall = (r: Row, side: "support" | "resistance"): Wall => {
    const l = side === "support" ? r.pe : r.ce;
    const max = side === "support" ? maxPe : maxCe;
    return {
      strike: r.strike, side, oi: l.oi, oiChange: l.oiChange, share: l.oi / max, trend: wallTrend(l),
      activity: classify(l, max), distPts: r.strike - spot, distPct: ((r.strike - spot) / spot) * 100,
    };
  };
  const supports = near.filter((r) => r.strike <= spot).sort((a, b) => b.pe.oi - a.pe.oi).slice(0, 2).map((r) => mkWall(r, "support"));
  const resistances = near.filter((r) => r.strike >= spot).sort((a, b) => b.ce.oi - a.ce.oi).slice(0, 2).map((r) => mkWall(r, "resistance"));

  const zone = (r: Row, side: "CE" | "PE", act: Activity): Zone => {
    const l = side === "CE" ? r.ce : r.pe;
    return { strike: r.strike, side, activity: act, oiChange: l.oiChange, ltpChange: l.ltpChange, volume: l.volume, ltp: l.ltp };
  };
  const pick = (side: "CE" | "PE", acts: Activity[], region: "above" | "below" | "all", n = 3): Zone[] =>
    near
      .map((r) => ({ r, a: classify(side === "CE" ? r.ce : r.pe, side === "CE" ? maxCe : maxPe) }))
      .filter((x) => acts.includes(x.a))
      .filter((x) => region === "all" || (region === "above" ? x.r.strike >= spot : x.r.strike <= spot))
      .sort((p, q) => {
        const lp = side === "CE" ? p.r.ce : p.r.pe, lq = side === "CE" ? q.r.ce : q.r.pe;
        return (lq.volume ?? Math.abs(lq.oiChange ?? 0)) - (lp.volume ?? Math.abs(lp.oiChange ?? 0));
      })
      .slice(0, n)
      .map((x) => zone(x.r, side, x.a));

  const freshPutWriting = pick("PE", ["WRITING"], "below");
  const freshCallWriting = pick("CE", ["WRITING"], "above");
  const ceBuying = pick("CE", ["BUYING", "SHORT_COVERING"], "all");
  const peBuying = pick("PE", ["BUYING", "SHORT_COVERING"], "all");

  // PCR trend vs baseline
  let pcrTrend: ChainAnalysis["pcrTrend"] = "UNKNOWN"; let pcrDelta: number | undefined;
  if (c.pcr != null && base?.pcr != null) {
    pcrDelta = c.pcr - base.pcr;
    pcrTrend = Math.abs(pcrDelta) < CHAIN_CFG.pcrFlat ? "FLAT" : pcrDelta > 0 ? "RISING" : "FALLING";
  }

  // Bias evidence (levels/OI layer only — still needs price confirmation)
  let bull = 0, bear = 0; const ev: string[] = [];
  const s0 = supports[0], r0 = resistances[0];
  if (s0?.trend === "STRENGTHENING") { bull++; ev.push(`Put wall ${s0.strike} strengthening (fresh put OI below price)`); }
  if (s0?.trend === "WEAKENING") { bear++; ev.push(`Put wall ${s0.strike} weakening — support may break`); }
  if (r0?.trend === "STRENGTHENING") { bear++; ev.push(`Call wall ${r0.strike} strengthening (fresh call OI above price)`); }
  if (r0?.trend === "WEAKENING") { bull++; ev.push(`Call wall ${r0.strike} weakening — breakout more likely`); }
  if (r0?.activity === "SHORT_COVERING") { bull++; ev.push(`Call writers covering at ${r0.strike} (OI↓ premium↑)`); }
  if (s0?.activity === "SHORT_COVERING") { bear++; ev.push(`Put writers covering at ${s0.strike} (OI↓ premium↑)`); }
  const sumChg = (z: Zone[]) => z.reduce((s, x) => s + Math.abs(x.oiChange ?? 0), 0);
  const pw = sumChg(freshPutWriting), cw = sumChg(freshCallWriting);
  if (pw > cw * 1.5 && pw > 0) { bull++; ev.push("fresh put writing outweighs fresh call writing"); }
  if (cw > pw * 1.5 && cw > 0) { bear++; ev.push("fresh call writing outweighs fresh put writing"); }
  const vol = (z: Zone[]) => z.reduce((s, x) => s + (x.volume ?? 0), 0);
  const cb = vol(ceBuying), pb = vol(peBuying);
  if (cb > pb * 1.5 && cb > 0) { bull++; ev.push("CE buying/covering volume dominates PE"); }
  if (pb > cb * 1.5 && pb > 0) { bear++; ev.push("PE buying/covering volume dominates CE"); }
  if (pcrTrend === "RISING") { bull++; ev.push(`PCR rising (${c.pcr?.toFixed(2)}, Δ${pcrDelta?.toFixed(2)})`); }
  if (pcrTrend === "FALLING") { bear++; ev.push(`PCR falling (${c.pcr?.toFixed(2)}, Δ${pcrDelta?.toFixed(2)})`); }

  const haveChange = c.rows.some((r) => r.ce.oiChange != null || r.pe.oiChange != null);
  const score = bull - bear;
  const bias: ChainAnalysis["bias"] = !haveChange ? "UNKNOWN" : score >= 2 ? "BULLISH_LEAN" : score <= -2 ? "BEARISH_LEAN" : "NEUTRAL";

  const atmRow = c.rows.find((r) => r.strike === atm);
  return {
    symbol: c.symbol, spot, atm, asOf: c.asOf, derivedChange: c.derivedChange,
    baselineMinAgo: base ? Math.round((Date.now() - base.t) / 60000) : undefined,
    supports, resistances, freshPutWriting, freshCallWriting, ceBuying, peBuying,
    pcr: c.pcr, pcrTrend, pcrDelta, maxPain: c.maxPain, vix: c.vix, score, bias, evidence: ev,
    atmGreeks: atmRow ? { ce: atmRow.ce, pe: atmRow.pe, notes: [...greekCheck(atmRow.ce, daysToExpiry)] } : null,
  };
}

// ─────────────────────────────────────────────────────────────
// Gate integration
// ─────────────────────────────────────────────────────────────
/** Levels/OI layer for evaluate_trade_gate. */
export function layerForDirection(a: ChainAnalysis, dir: "call" | "put"): { state: "agree" | "against" | "neutral" | "unknown"; evidence: string } {
  if (a.bias === "UNKNOWN") return { state: "unknown", evidence: "no change-in-OI data yet (need a second snapshot 15-30 min later)" };
  const wall = dir === "call" ? a.resistances[0] : a.supports[0];
  if (wall && wall.trend === "STRENGTHENING" && Math.abs(wall.distPct) <= CHAIN_CFG.nearWallPct) {
    return { state: "against", evidence: `price pressed against strengthening ${wall.side} wall at ${wall.strike} (${wall.distPct.toFixed(2)}%)` };
  }
  const aligned = (dir === "call" && a.bias === "BULLISH_LEAN") || (dir === "put" && a.bias === "BEARISH_LEAN");
  const opposed = (dir === "call" && a.bias === "BEARISH_LEAN") || (dir === "put" && a.bias === "BULLISH_LEAN");
  const e = a.evidence.slice(0, 3).join("; ") || `score ${a.score}`;
  return aligned ? { state: "agree", evidence: e } : opposed ? { state: "against", evidence: e } : { state: "neutral", evidence: e };
}

/** Is a major, not-weakening OI wall sitting between spot and the target? (VIX ref step 4) */
export function wallBeforeTarget(a: ChainAnalysis, dir: "call" | "put", target: number): Wall | undefined {
  const walls = dir === "call" ? a.resistances : a.supports;
  return walls.find((w) =>
    w.share >= CHAIN_CFG.strongWallShare && w.trend !== "WEAKENING" &&
    (dir === "call" ? w.strike > a.spot && w.strike <= target : w.strike < a.spot && w.strike >= target));
}

// ─────────────────────────────────────────────────────────────
// Output for the LLM
// ─────────────────────────────────────────────────────────────
const fmtN = (n?: number) => (n == null ? "—" : Math.round(n).toLocaleString("en-IN"));
const fmtWall = (w: Wall) =>
  `${w.strike} (${w.distPts >= 0 ? "+" : ""}${Math.round(w.distPts)} pts) OI ${fmtN(w.oi)} [${Math.round(w.share * 100)}% of side max] ΔOI ${fmtN(w.oiChange)} → ${w.trend}${w.activity !== "QUIET" ? ` / ${w.activity}` : ""}`;
const fmtZone = (z: Zone) =>
  `${z.strike} ${z.side}: ${z.activity} | ΔOI ${fmtN(z.oiChange)} | LTP ${z.ltp ?? "—"} (${z.ltpChange != null ? (z.ltpChange >= 0 ? "+" : "") + z.ltpChange.toFixed(1) : "—"}) | vol ${fmtN(z.volume)}`;

export function formatChainAnalysis(a: ChainAnalysis, daysToExpiry?: number): string {
  const L: string[] = [];
  L.push(`OPTION CHAIN READ — ${a.symbol} spot ₹${a.spot} | ATM ${a.atm} | as of ${a.asOf ?? "unknown (no timestamp — verify freshness with check_live_feed)"}`);
  if (a.derivedChange) L.push(`ΔOI/ΔLTP derived from our own snapshot ${a.baselineMinAgo} min ago (API gave none).`);
  else if (a.baselineMinAgo != null) L.push(`PCR trend baseline: snapshot ${a.baselineMinAgo} min ago.`);
  L.push("");
  L.push(`SUPPORT (highest Put OI below price):\n${a.supports.map((w) => "  " + fmtWall(w)).join("\n") || "  none in ±5% window"}`);
  L.push(`RESISTANCE (highest Call OI above price):\n${a.resistances.map((w) => "  " + fmtWall(w)).join("\n") || "  none in ±5% window"}`);
  L.push("");
  L.push(`FRESH PUT WRITING below price (support being built):\n${a.freshPutWriting.map((z) => "  " + fmtZone(z)).join("\n") || "  none material"}`);
  L.push(`FRESH CALL WRITING above price (resistance being built):\n${a.freshCallWriting.map((z) => "  " + fmtZone(z)).join("\n") || "  none material"}`);
  L.push(`CE BUYING / SHORT-COVERING (OI↑ or ↓ with premium↑):\n${a.ceBuying.map((z) => "  " + fmtZone(z)).join("\n") || "  none material"}`);
  L.push(`PE BUYING / SHORT-COVERING:\n${a.peBuying.map((z) => "  " + fmtZone(z)).join("\n") || "  none material"}`);
  L.push("");
  L.push(`PCR ${a.pcr?.toFixed(2) ?? "—"} (${a.pcrTrend}${a.pcrDelta != null ? ` Δ${a.pcrDelta.toFixed(2)}` : ""}) | Max pain ${a.maxPain ?? "—"} (weak predictor) | VIX ${a.vix ?? "—"}`);
  L.push(`OI/LEVELS LEAN: ${a.bias} (score ${a.score})${a.evidence.length ? "\n  - " + a.evidence.join("\n  - ") : ""}`);
  if (a.atmGreeks) {
    const g = (l: Leg) => `LTP ${l.ltp ?? "—"} Δ ${l.delta ?? "—"} IV ${l.iv ?? "—"}`;
    L.push(`ATM Greeks: CE ${g(a.atmGreeks.ce)} | PE ${g(a.atmGreeks.pe)}`);
    const notes = [...greekCheck(a.atmGreeks.ce, daysToExpiry)];
    if (notes.length) L.push("  Greek checks: " + notes.join("; "));
  }
  L.push("");
  L.push("HONEST LIMITS: OI can't prove buyer vs writer — buying/writing is inferred from premium direction. Big OI is often hedged. The highest-OI strike is not unbreakable; breaks that HOLD are where good buys come from. This is the levels/OI layer only — it needs structure, flow and a candle trigger before any trade, and must go through evaluate_trade_gate. Not financial advice.");
  return L.join("\n");
}

// ─────────────────────────────────────────────────────────────
// Tool definition + executor
// ─────────────────────────────────────────────────────────────
export const OPTION_CHAIN_TOOL = {
  type: "function",
  function: {
    name: "read_option_chain",
    description:
      "Read the option chain like a pro: support/resistance from OI walls (with strengthening/weakening), fresh call/put WRITING zones, CE/PE BUYING zones (OI × premium × volume), PCR + trend, bias lean and ATM Greek checks. Use for: support, resistance, levels, where is buying/writing, OI, PCR, walls, 'read the chain'. Prefer this over get_option_chain for any interpretation.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX" },
        windowMin: { type: "number", description: "Compare against a snapshot this many minutes ago (default 20; use 15-30)" },
        daysToExpiry: { type: "number", description: "Optional, for Greek checks" },
      },
      required: [],
    },
  },
};

export async function runReadOptionChain(
  args: any, baseUrl: string, state: { lastChain?: ChainAnalysis }, fallbackSymbol = "NIFTY"
): Promise<string> {
  const symbol = safeSymbol(args?.symbol, fallbackSymbol);
  const r = await getJSON(`${baseUrl}/api/option-chain?symbol=${enc(symbol)}`, { timeoutMs: 15000 });
  if (!r.ok) return `Option chain unavailable (${r.error}). Do NOT invent levels — say the feed is down and ask for pasted data.`;
  const c = normalizeChain(r.data, symbol);
  if (!c) return "Option chain payload had no strikes/spot (market closed or feed issue). Do NOT invent levels.";
  const windowMin = Math.min(60, Math.max(5, Number(args?.windowMin) || 20));
  const base = baselineSnap(symbol, windowMin);
  fillChanges(c, base);
  recordSnapshot(c);
  const a = analyze(c, base, num(args?.daysToExpiry));
  state.lastChain = a;
  return formatChainAnalysis(a, num(args?.daysToExpiry));
}

// ─────────────────────────────────────────────────────────────
// Prompt knowledge block — replaces TRADING_KNOWLEDGE.substring(0, 2500)
// ─────────────────────────────────────────────────────────────
export const OPTION_CHAIN_KNOWLEDGE = `## READING THE OPTION CHAIN (use read_option_chain; explain in plain words)
- Writers (mostly institutions) defend strikes. Highest PUT OI below price = support zone. Highest CALL OI above price = resistance zone. Use CHANGE in OI too: fresh writing matters more than old positions.
- Put OI rising below price → support strengthening. Call OI rising above price → resistance strengthening. Call OI FALLING at resistance + price rising → call writers covering → breakout likely. Put OI FALLING at support + price falling → put writers covering → breakdown likely.
- Who is BUYING vs WRITING (inferred from premium, OI alone can't tell): OI↑+premium↑ = buying; OI↑+premium↓ = writing; OI↓+premium↑ = short covering; OI↓+premium↓ = long unwinding.
- Strong CE buying = Call OI and Call premium both rising with volume, price above VWAP, Put OI rising below. Strong PE buying = mirror image.
- PCR >~1.3 bullish lean, <~0.7 bearish lean, 0.8-1.2 neutral — the TREND matters more than the level. Max pain is a weak predictor. Never trade PCR/OI alone.
- Levels: keep 2 supports + 2 resistances near price; combine OI walls with prev-day H/L/C, swing points, VWAP, round numbers. Overlap = strong level.
- The best buys come when price BREAKS a wall and HOLDS (writers cover), or rejects it with fresh writing — always with candle confirmation, never mid-range.
- Greeks (buyer): delta 0.45-0.65; delta <0.35 = lottery ticket; premium risk ≈ points × delta; theta steepest last 2-3 days (time stop 20-30 min); vega/IV crush around events (RBI/results/Budget) can lose even when right; expiry-day buying = gamma lottery, avoid.
- Always state limits: OI can't prove buyer or seller, large OI is often hedged, walls shift as expiry nears. Educational, not financial advice.`;
