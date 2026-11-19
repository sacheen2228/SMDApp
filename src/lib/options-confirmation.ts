// Options confirmation.
//
// Evaluates the option chain holistically (underlying price + option premium
// + OI + ΔOI + PCR trend + Greeks) to classify each leg and produce a
// directional verdict. Never infers seller positioning from PCR alone, never
// labels PCR < 0.9 as automatic call writing, and never uses EOD OI as
// intraday confirmation. Missing or stale evidence is INCONCLUSIVE.

export interface AtmLegLike {
  ltp: number;
  previousLtp?: number | null;
  volume?: number;
  oiChange?: number;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  iv?: number | null;
}

export interface OptionsConfirmationInput {
  underlyingPrice: number;
  underlyingChangePct?: number | null;
  pcr: number | null;
  pcrPrevious: number | null;
  callOi: number;
  putOi: number;
  callOiChange: number;
  putOiChange: number;
  atmCall: AtmLegLike | null;
  atmPut: AtmLegLike | null;
  dataQuality: "LIVE" | "FRESH" | "STALE" | "UNAVAILABLE";
  isIntraday: boolean;
  oiSnapshotType?: "INTRADAY" | "EOD";
}

export type OptionsConfirmationVerdict = "SUPPORTIVE" | "ADVERSE" | "INCONCLUSIVE";

export type LegClassification =
  | "LONG_BUILDUP"
  | "SHORT_BUILDUP"
  | "SHORT_COVERING"
  | "LONG_UNWINDING"
  | "INCONCLUSIVE";

export interface GreeksLike {
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  iv?: number | null;
}

export interface OptionsConfirmationResult {
  verdict: OptionsConfirmationVerdict;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  reasons: string[];
  conflicts: string[];
  legClass: { ce: LegClassification; pe: LegClassification };
  pcrTrend: "RISING" | "FALLING" | "FLAT" | "UNKNOWN";
  greeks: { ce: GreeksLike | null; pe: GreeksLike | null };
  dataQuality: "LIVE" | "FRESH" | "STALE" | "UNAVAILABLE";
}

// Minimum absolute OI change to treat a leg's OI movement as meaningful.
const OI_SIGNIFICANT = 20_000;

function legClass(
  oiChange: number,
  ltp: number,
  previousLtp: number | null,
): LegClassification {
  const prev = previousLtp == null || !Number.isFinite(previousLtp) || previousLtp <= 0 ? null : previousLtp;
  const cur = ltp == null || !Number.isFinite(ltp) || ltp <= 0 ? null : ltp;
  const significantOi = Math.abs(oiChange) >= OI_SIGNIFICANT;
  if (!significantOi || prev == null || cur == null) return "INCONCLUSIVE";
  const oiUp = oiChange > 0;
  const priceUp = cur > prev;
  if (oiUp && priceUp) return "LONG_BUILDUP";
  if (oiUp && !priceUp) return "SHORT_BUILDUP";
  if (!oiUp && priceUp) return "SHORT_COVERING";
  return "LONG_UNWINDING";
}

function pcrTrend(pcr: number | null, pcrPrevious: number | null): "RISING" | "FALLING" | "FLAT" | "UNKNOWN" {
  if (pcr == null || !Number.isFinite(pcr) || pcrPrevious == null || !Number.isFinite(pcrPrevious)) return "UNKNOWN";
  const d = pcr - pcrPrevious;
  if (d > 0.05) return "RISING";
  if (d < -0.05) return "FALLING";
  return "FLAT";
}

function greeksOf(leg: AtmLegLike | null): GreeksLike | null {
  if (!leg) return null;
  return {
    delta: leg.delta ?? null,
    gamma: leg.gamma ?? null,
    theta: leg.theta ?? null,
    vega: leg.vega ?? null,
    iv: leg.iv ?? null,
  };
}

export function confirmOptions(input: OptionsConfirmationInput): OptionsConfirmationResult {
  const {
    underlyingPrice, underlyingChangePct, pcr, pcrPrevious,
    callOi, putOi, callOiChange, putOiChange,
    atmCall, atmPut, dataQuality, isIntraday, oiSnapshotType,
  } = input;

  const reasons: string[] = [];
  const conflicts: string[] = [];

  // Data-quality gates — never fabricate options confirmation.
  if (dataQuality === "STALE" || dataQuality === "UNAVAILABLE") {
    return {
      verdict: "INCONCLUSIVE", direction: "NEUTRAL",
      reasons: [`options data ${dataQuality.toLowerCase()} — cannot confirm`],
      conflicts: [],
      legClass: { ce: "INCONCLUSIVE", pe: "INCONCLUSIVE" },
      pcrTrend: "UNKNOWN",
      greeks: { ce: greeksOf(atmCall), pe: greeksOf(atmPut) },
      dataQuality,
    };
  }
  if (isIntraday && oiSnapshotType === "EOD") {
    return {
      verdict: "INCONCLUSIVE", direction: "NEUTRAL",
      reasons: ["EOD OI snapshot used for intraday confirmation — rejected"],
      conflicts: [],
      legClass: { ce: "INCONCLUSIVE", pe: "INCONCLUSIVE" },
      pcrTrend: pcrTrend(pcr, pcrPrevious),
      greeks: { ce: greeksOf(atmCall), pe: greeksOf(atmPut) },
      dataQuality,
    };
  }

  const ceClass = legClass(callOiChange, atmCall?.ltp ?? 0, atmCall?.previousLtp ?? null);
  const peClass = legClass(putOiChange, atmPut?.ltp ?? 0, atmPut?.previousLtp ?? null);

  // Per-leg classification reasons (never PCR-only writing claims).
  if (ceClass !== "INCONCLUSIVE") {
    reasons.push(`CE ${ceClass.toLowerCase().replace("_", " ")} (OI Δ ${callOiChange > 0 ? "+" : ""}${callOiChange})`);
  }
  if (peClass !== "INCONCLUSIVE") {
    reasons.push(`PE ${peClass.toLowerCase().replace("_", " ")} (OI Δ ${putOiChange > 0 ? "+" : ""}${putOiChange})`);
  }

  const pcrT = pcrTrend(pcr, pcrPrevious);
  if (pcr != null && Number.isFinite(pcr)) {
    reasons.push(`PCR ${pcr.toFixed(2)} (trend ${pcrT.toLowerCase()})`);
  } else {
    reasons.push("PCR unavailable");
  }

  // Directional score from leg classifications. PCR trend is a weak modifier
  // only — it never determines writing by itself.
  let bullish = 0;
  let bearish = 0;
  const scoreLeg = (cls: LegClassification, isCall: boolean) => {
    if (cls === "INCONCLUSIVE") return { b: 0, br: 0 };
    const w = cls === "LONG_BUILDUP" || cls === "SHORT_BUILDUP" ? 1 : 0.5;
    if (isCall) {
      // CE: long buildup = bullish, short buildup = bearish.
      if (cls === "LONG_BUILDUP") return { b: w, br: 0 };
      if (cls === "SHORT_BUILDUP") return { b: 0, br: w };
      if (cls === "SHORT_COVERING") return { b: 0.5, br: 0 };
      return { b: 0, br: 0.5 }; // LONG_UNWINDING
    }
    // PE: long buildup = bearish, short buildup = bullish.
    if (cls === "LONG_BUILDUP") return { b: 0, br: w };
    if (cls === "SHORT_BUILDUP") return { b: w, br: 0 };
    if (cls === "SHORT_COVERING") return { b: 0, br: 0.5 };
    return { b: 0.5, br: 0 }; // LONG_UNWINDING
  };
  const cs = scoreLeg(ceClass, true);
  const ps = scoreLeg(peClass, false);
  bullish += cs.b + ps.b;
  bearish += cs.br + ps.br;

  if (pcrT === "RISING") bullish += 0.25;
  else if (pcrT === "FALLING") bearish += 0.25;

  let verdict: OptionsConfirmationVerdict = "INCONCLUSIVE";
  let direction: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";

  const dominant = bullish > bearish ? "BULLISH" : bearish > bullish ? "BEARISH" : "NEUTRAL";
  const gap = Math.abs(bullish - bearish);

  const hasCallSignal = ceClass !== "INCONCLUSIVE";
  const hasPutSignal = peClass !== "INCONCLUSIVE";

  if (!hasCallSignal && !hasPutSignal) {
    verdict = "INCONCLUSIVE";
    direction = "NEUTRAL";
    reasons.push("no leg-level OI/premium confirmation available");
  } else if (dominant !== "NEUTRAL" && gap >= 1) {
    verdict = "SUPPORTIVE";
    direction = dominant;
    reasons.push(`${dominant.toLowerCase()} options confirmation dominant`);
  } else if (hasCallSignal || hasPutSignal) {
    verdict = "ADVERSE";
    direction = dominant === "NEUTRAL" ? "NEUTRAL" : dominant;
    conflicts.push("conflicting call/put OI and premium signals");
  } else {
    verdict = "INCONCLUSIVE";
    direction = "NEUTRAL";
  }

  return {
    verdict,
    direction,
    reasons,
    conflicts,
    legClass: { ce: ceClass, pe: peClass },
    pcrTrend: pcrT,
    greeks: { ce: greeksOf(atmCall), pe: greeksOf(atmPut) },
    dataQuality,
  };
}
