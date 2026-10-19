// layer-builder.ts
// Builds the FIVE gate layers from REAL sources so the STRICT gate can reach a TRADE
// verdict when a setup is genuinely warranted (instead of "unknown" everywhere).
//
//   flow      → FII/DII flow (next-day bias only, never an intraday trigger)
//                + the option-chain buying/writing lean
//   structure → tech-read structureLayer (cached read, closed candles)
//   levels    → option-chain-reader layerForDirection + wallBeforeTarget
//   greeksVix → vixBand + ATM |delta| band + IV caution + days-to-expiry (greekCheck)
//   trigger   → tech-read triggerLayer (cached read, closed candles)
//
// Every layer carries EVIDENCE text. Unknown is only returned when the source
// genuinely failed — it is never invented.
import type { GateLayer } from "./agent-brain-gate";
import { vixBand } from "./agent-brain-gate";
import { greekCheck, layerForDirection, wallBeforeTarget, type ChainAnalysis, type NormChain } from "./option-chain-reader";
import { structureLayer, triggerLayer, type TfRead } from "./tech-read";

export interface LayerSources {
  flow?: { fiiDii?: { value?: number | null; bias?: string; asOf?: string } | null; chainLean?: string | null };
  chain?: ChainAnalysis | null;
  chainRaw?: NormChain | null;
  vix?: number | null;
  delta?: number | null;
  iv?: number | null;
  daysToExpiry?: number | null;
  tfRead?: TfRead | null;
  direction?: "call" | "put";
}

const UNKNOWN: GateLayer = { state: "unknown", evidence: "source unavailable" };

/** flow layer — FII/DII bias (next-day bias only) + chain buying/writing lean. */
export function buildFlowLayer(src: LayerSources): GateLayer {
  const bits: string[] = [];
  const f = src.flow?.fiiDii;
  if (f && f.value != null && f.bias) {
    bits.push(`FII/DII ${f.bias} (${f.value}${f.asOf ? `, ${f.asOf}` : ""}) — next-day bias only, never an intraday trigger`);
  }
  const lean = src.flow?.chainLean;
  if (lean) bits.push(`chain lean ${lean}`);
  if (!bits.length) return { ...UNKNOWN, evidence: "no FII/DII or chain lean available" };
  const state: GateLayer["state"] = /bull|strong buy|writing/i.test(bits.join(" ")) ? "agree" : /bear|strong sell/i.test(bits.join(" ")) ? "against" : "neutral";
  return { state, evidence: bits.join("; ") };
}

/** structure layer — HH/HL + BOS on CLOSED candles. */
export function buildStructureLayer(src: LayerSources): GateLayer {
  if (!src.tfRead || !src.direction) return { ...UNKNOWN, evidence: "no closed-candle structure read" };
  return structureLayer(src.tfRead, src.direction);
}

/** trigger layer — BOS/CHOCH/sweep entry on CLOSED candles. */
export function buildTriggerLayer(src: LayerSources): GateLayer {
  if (!src.tfRead || !src.direction) return { ...UNKNOWN, evidence: "no closed-candle trigger read" };
  return triggerLayer(src.tfRead, src.direction);
}

/** levels layer — OI walls / writing zones from the option chain. */
export function buildLevelsLayer(src: LayerSources): GateLayer {
  if (!src.chain) return { ...UNKNOWN, evidence: "no option chain analysis" };
  if (!src.direction) return { ...UNKNOWN, evidence: "no direction for the levels layer" };
  return layerForDirection(src.chain, src.direction);
}

/** greeks/VIX layer — VIX band + delta band + IV caution + days to expiry. */
export function buildGreeksVixLayer(src: LayerSources): GateLayer {
  const notes: string[] = [];
  let agree = 0, against = 0;
  let hardAgainst = false; // a safety statement, not a vote: it stands on its own
  if (src.vix != null && Number.isFinite(src.vix) && src.vix > 0) {
    const band = vixBand(src.vix);
    notes.push(`VIX ${src.vix.toFixed(1)} (${band.band})`);
    if (band.band === "LOW" || band.band === "NORMAL") agree++;
    else if (band.band === "ELEVATED") against++;
    else if (band.band === "EXTREME") { against++; hardAgainst = true; }
  }
  if (src.delta != null && Number.isFinite(src.delta)) {
    const ad = Math.abs(src.delta);
    notes.push(`|delta| ${ad.toFixed(2)}`);
    if (ad >= 0.45 && ad <= 0.65) agree++;
    else if (ad < 0.35) { against++; hardAgainst = true; }
  }
  if (src.iv != null && Number.isFinite(src.iv)) {
    notes.push(`IV ${src.iv.toFixed(1)}%`);
    if (src.iv > 45) against++;
  }
  if (src.daysToExpiry != null) {
    notes.push(`${src.daysToExpiry}d to expiry`);
    if (src.daysToExpiry <= 1) against++;
  }
  if (src.chain?.atmGreeks) {
    const g = greekCheck(src.chain.atmGreeks.ce, src.daysToExpiry ?? undefined);
    if (g.length) notes.push(g.join(" | "));
  }
  if (!notes.length) return { ...UNKNOWN, evidence: "no VIX/delta/IV/expiry data" };
  // A tie is NEUTRAL, never agreement. A safety statement (extreme VIX, lottery
  // delta) is AGAINST on its own.
  const state: GateLayer["state"] = hardAgainst || against > agree ? "against" : agree > against ? "agree" : "neutral";
  return { state, evidence: notes.join("; ") };
}

/** Is a strengthening OI wall sitting between entry and target? (gate check 14) */
export function oiWallBeforeTarget(src: LayerSources, target: number): boolean {
  if (!src.chain || !src.direction || !(target > 0)) return false;
  const wall = wallBeforeTarget(src.chain, src.direction, target);
  return !!wall && wall.trend === "STRENGTHENING";
}

/** Assemble all five layers at once. */
export function buildLayers(src: LayerSources): Record<"flow" | "structure" | "levels" | "greeksVix" | "trigger", GateLayer> {
  return {
    flow: buildFlowLayer(src),
    structure: buildStructureLayer(src),
    levels: buildLevelsLayer(src),
    greeksVix: buildGreeksVixLayer(src),
    trigger: buildTriggerLayer(src),
  };
}
