// Derivative Flow Intelligence Engine
// Combines OI, FII/DII, participant OI, gamma, VIX, breadth into a single score.
// No ML. Pure deterministic weighting.

export interface DerivativeFlowInput {
  // OI
  oiBias: "BULLISH" | "BEARISH" | "MIXED" | "NEUTRAL";
  oiSpurtScore: number;
  longBuildupPct: number;
  shortBuildupPct: number;

  // FII/DII
  fiiNet: number;
  diiNet: number;
  fiiBias: "BULLISH" | "BEARISH" | "NEUTRAL";

  // Participant OI
  fiiOi: number;
  clientOi: number;
  participantBias: "BULLISH" | "BEARISH" | "NEUTRAL";

  // Option chain
  pcr: number;
  callWall: number;
  putWall: number;
  maxPain: number;

  // Gamma
  gammaRegime: "PINNING" | "EXPANSION" | "NEUTRAL";
  dealerGammaExposure: number;

  // VIX
  vix: number;
  vixRegime: "LOW" | "NORMAL" | "HIGH" | "EXTREME";

  // Breadth
  breadthScore: number;
  advances: number;
  declines: number;
}

export interface DerivativeFlowResult {
  score: number;
  bias: "BULLISH" | "BEARISH" | "MIXED" | "NEUTRAL";
  components: {
    oi: { score: number; weight: number; bias: string };
    optionPositioning: { score: number; weight: number; bias: string };
    participantOi: { score: number; weight: number; bias: string };
    fiiDii: { score: number; weight: number; bias: string };
    gamma: { score: number; weight: number; regime: string };
    vix: { score: number; weight: number; regime: string };
    breadth: { score: number; weight: number; bias: string };
  };
  putSupport: "STRONG" | "WEAKENING" | "NEUTRAL";
  callResistance: "HIGH" | "INCREASING" | "NEUTRAL";
  gammaState: string;
  interpretation: string;
  confirmation: "CONFIRMED" | "PARTIAL" | "CONFLICTING" | "INSUFFICIENT_DATA";
}

export function analyzeDerivativeFlow(input: DerivativeFlowInput): DerivativeFlowResult {
  const weights = {
    oi: 0.25,
    optionPositioning: 0.20,
    participantOi: 0.15,
    fiiDii: 0.15,
    gamma: 0.05,
    vix: 0.05,
    breadth: 0.15,
  };

  // 1. OI Score (0-100)
  let oiScore = 50;
  if (input.oiBias === "BULLISH") oiScore = 70 + Math.min(30, input.oiSpurtScore * 0.3);
  else if (input.oiBias === "BEARISH") oiScore = 30 - Math.min(30, input.oiSpurtScore * 0.3);
  else if (input.oiBias === "MIXED") oiScore = 50;

  // 2. Option Positioning Score (0-100)
  let optionScore = 50;
  if (input.pcr != null && input.pcr > 1.2) optionScore = 70 + Math.min(30, (input.pcr - 1.2) * 50);
  else if (input.pcr < 0.8) optionScore = 30 - Math.min(30, (0.8 - input.pcr) * 50);
  if (input.putWall > input.maxPain * 0.98) optionScore += 5;
  if (input.callWall < input.maxPain * 1.02) optionScore += 5;

  // 3. Participant OI Score (0-100)
  let participantScore = 50;
  if (input.participantBias === "BULLISH") participantScore = 70;
  else if (input.participantBias === "BEARISH") participantScore = 30;

  // 4. FII/DII Score (0-100)
  let fiiDiiScore = 50;
  if (input.fiiBias === "BULLISH") fiiDiiScore = 70 + Math.min(30, Math.abs(input.fiiNet) / 1000);
  else if (input.fiiBias === "BEARISH") fiiDiiScore = 30 - Math.min(30, Math.abs(input.fiiNet) / 1000);
  if (input.diiNet > 0) fiiDiiScore += 5;
  if (input.diiNet < 0) fiiDiiScore -= 5;

  // 5. Gamma Score (0-100)
  let gammaScore = 50;
  if (input.gammaRegime === "PINNING") gammaScore = 50; // neutral for direction
  else if (input.gammaRegime === "EXPANSION") gammaScore = 60;

  // 6. VIX Score (0-100)
  let vixScore = 50;
  if (input.vixRegime === "LOW") vixScore = 65;
  else if (input.vixRegime === "NORMAL") vixScore = 55;
  else if (input.vixRegime === "HIGH") vixScore = 35;
  else if (input.vixRegime === "EXTREME") vixScore = 20;

  // 7. Breadth Score (0-100)
  let breadthScore = input.breadthScore;

  // Weighted composite
  const composite = Math.round(
    oiScore * weights.oi +
    optionScore * weights.optionPositioning +
    participantScore * weights.participantOi +
    fiiDiiScore * weights.fiiDii +
    gammaScore * weights.gamma +
    vixScore * weights.vix +
    breadthScore * weights.breadth
  );

  let bias: DerivativeFlowResult["bias"] = "NEUTRAL";
  if (composite >= 65) bias = "BULLISH";
  else if (composite <= 35) bias = "BEARISH";
  else if (Math.abs(composite - 50) < 10) bias = "MIXED";

  // Put support / Call resistance
  const putSupport = input.pcr > 1.1 ? "STRONG" : input.pcr > 0.9 ? "NEUTRAL" : "WEAKENING";
  const callResistance = input.pcr < 0.9 ? "HIGH" : input.pcr < 1.1 ? "NEUTRAL" : "INCREASING";

  // Confirmation
  const biases = [input.oiBias, input.fiiBias, input.participantBias];
  const bullish = biases.filter(b => b === "BULLISH").length;
  const bearish = biases.filter(b => b === "BEARISH").length;
  let confirmation: DerivativeFlowResult["confirmation"] = "INSUFFICIENT_DATA";
  if (bullish >= 2 || bearish >= 2) confirmation = "CONFIRMED";
  else if (bullish === 1 && bearish === 1) confirmation = "CONFLICTING";
  else confirmation = "PARTIAL";

  // Interpretation
  const parts: string[] = [];
  if (input.oiBias !== "NEUTRAL") parts.push(`OI: ${input.oiBias.replace("_", " ")}`);
  if (input.fiiBias !== "NEUTRAL") parts.push(`FII: ${input.fiiBias}`);
  if (input.gammaRegime !== "NEUTRAL") parts.push(`Gamma: ${input.gammaRegime}`);
  if (input.vixRegime === "HIGH" || input.vixRegime === "EXTREME") parts.push(`VIX: ${input.vixRegime}`);
  if (input.breadthScore < 40) parts.push("Breadth: Weak");
  if (input.breadthScore > 70) parts.push("Breadth: Strong");

  return {
    score: Math.max(0, Math.min(100, composite)),
    bias,
    components: {
      oi: { score: Math.round(oiScore), weight: weights.oi, bias: input.oiBias },
      optionPositioning: { score: Math.round(optionScore), weight: weights.optionPositioning, bias: input.pcr > 1.1 ? "BULLISH" : input.pcr < 0.9 ? "BEARISH" : "NEUTRAL" },
      participantOi: { score: Math.round(participantScore), weight: weights.participantOi, bias: input.participantBias },
      fiiDii: { score: Math.round(fiiDiiScore), weight: weights.fiiDii, bias: input.fiiBias },
      gamma: { score: Math.round(gammaScore), weight: weights.gamma, regime: input.gammaRegime },
      vix: { score: Math.round(vixScore), weight: weights.vix, regime: input.vixRegime },
      breadth: { score: Math.round(breadthScore), weight: weights.breadth, bias: input.breadthScore > 60 ? "BULLISH" : input.breadthScore < 40 ? "BEARISH" : "NEUTRAL" },
    },
    putSupport,
    callResistance,
    gammaState: input.gammaRegime,
    interpretation: parts.join(" | ") || "No significant derivative signals",
    confirmation,
  };
}
