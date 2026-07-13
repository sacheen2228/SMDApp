// DEPRECATED: duplicate of the consolidated Zero Hero engine in src/lib/zero-hero.ts.
// Kept on disk until production consolidation is verified (see AGENTS.md Architecture Guardian).
// Do NOT use in new code.

// Option Chain Engine
// Analyzes OI, OI Change, PCR, Max Pain

export interface OptionChainInput {
  strikes: {
    strike: number;
    ce: {
      oi: number;
      oiChg: number;
      volume: number;
      ltp: number;
      iv: number;
      bid: number;
      ask: number;
    } | null;
    pe: {
      oi: number;
      oiChg: number;
      volume: number;
      ltp: number;
      iv: number;
      bid: number;
      ask: number;
    } | null;
  }[];
  spot: number;
}

export interface OptionChainOutput {
  pcr: number;                    // Put-Call Ratio
  max_pain: number;               // Max Pain strike
  total_ce_oi: number;
  total_pe_oi: number;
  pcr_trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  highest_oi_ce: number;          // Resistance
  highest_oi_pe: number;          // Support
  unusual_oi_buildup: {
    strike: number;
    type: 'CE' | 'PE';
    oiChg: number;
    oi: number;
    direction: 'LONG' | 'SHORT';
  }[];
  confidence: number;
}

export function optionChainEngine(input: OptionChainInput): OptionChainOutput {
  const { strikes, spot } = input;

  let totalCeOi = 0;
  let totalPeOi = 0;
  let maxPainStrike = spot;
  let maxPainValue = Infinity;

  const ceOiByStrike: { [strike: number]: number } = {};
  const peOiByStrike: { [strike: number]: number } = {};
  const allStrikes: number[] = [];

  for (const s of strikes) {
    const ceOi = s.ce?.oi || 0;
    const peOi = s.pe?.oi || 0;
    totalCeOi += ceOi;
    totalPeOi += peOi;
    ceOiByStrike[s.strike] = ceOi;
    peOiByStrike[s.strike] = peOi;
    allStrikes.push(s.strike);
  }

  // PCR
  const pcr = totalPeOi > 0 ? totalCeOi / totalPeOi : 0;

  // Max Pain calculation
  for (const strike of allStrikes) {
    let pain = 0;
    for (const s of allStrikes) {
      const ceOi = ceOiByStrike[s] || 0;
      const peOi = peOiByStrike[s] || 0;
      if (s > strike) pain += ceOi * (s - strike);
      if (s < strike) pain += peOi * (strike - s);
    }
    if (pain < maxPainValue) {
      maxPainValue = pain;
      maxPainStrike = strike;
    }
  }

  // Highest OI CE (resistance) and PE (support)
  let highestOiCe = 0;
  let highestOiCeStrike = spot;
  let highestOiPe = 0;
  let highestOiPeStrike = spot;

  for (const s of strikes) {
    const ceOi = s.ce?.oi || 0;
    const peOi = s.pe?.oi || 0;
    if (ceOi > highestOiCe) {
      highestOiCe = ceOi;
      highestOiCeStrike = s.strike;
    }
    if (peOi > highestOiPe) {
      highestOiPe = peOi;
      highestOiPeStrike = s.strike;
    }
  }

  // PCR Trend
  let pcrTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  if (pcr > 1.2) pcrTrend = 'BEARISH';
  else if (pcr < 0.8) pcrTrend = 'BULLISH';
  else pcrTrend = 'NEUTRAL';

  // Unusual OI buildup
  const unusualOiBuildup: OptionChainOutput['unusual_oi_buildup'] = [];
  for (const s of strikes) {
    const ceOiChg = s.ce?.oiChg || 0;
    const peOiChg = s.pe?.oiChg || 0;
    const ceOi = s.ce?.oi || 0;
    const peOi = s.pe?.oi || 0;

    if (Math.abs(ceOiChg) > ceOi * 0.3 && ceOi > 0) {
      unusualOiBuildup.push({
        strike: s.strike,
        type: 'CE',
        oiChg: ceOiChg,
        oi: ceOi,
        direction: ceOiChg > 0 ? 'SHORT' : 'LONG',
      });
    }
    if (Math.abs(peOiChg) > peOi * 0.3 && peOi > 0) {
      unusualOiBuildup.push({
        strike: s.strike,
        type: 'PE',
        oiChg: peOiChg,
        oi: peOi,
        direction: peOiChg > 0 ? 'LONG' : 'SHORT',
      });
    }
  }

  return {
    pcr,
    max_pain: maxPainStrike,
    total_ce_oi: totalCeOi,
    total_pe_oi: totalPeOi,
    pcr_trend: pcrTrend,
    highest_oi_ce: highestOiCeStrike,
    highest_oi_pe: highestOiPeStrike,
    unusual_oi_buildup: unusualOiBuildup,
    confidence: 80,
  };
}
