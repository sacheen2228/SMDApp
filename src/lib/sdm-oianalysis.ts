import type {
  SDMOptionStrike,
  OIPattern,
  OIClassification,
  FreshWritingSignal,
  OITrap,
  SRLines,
  OIMigration,
  OIAnalysis,
} from '@/types/sdm';

// ─── Per-strike OI Pattern Classification ────────────────────────

function classifyOIPattern(strike: SDMOptionStrike): OIClassification {
  let callPattern: OIPattern | null = null;
  let putPattern: OIPattern | null = null;

  if (strike.ce) {
    const ceUp = strike.ce.ltp > 0 && strike.ce.oiChg > 0;
    const ceDown = strike.ce.oiChg < 0;
    // Price direction via option LTP
    const ceLtpUp = strike.ce.ltp > 0;
    // If oiChg is zero or ltp unchanged, pattern is null
    if (ceUp && ceLtpUp) {
      callPattern = 'LONG_BUILDUP';
    } else if (ceDown && !ceLtpUp) {
      callPattern = 'LONG_UNWINDING';
    } else if (ceUp && !ceLtpUp) {
      callPattern = 'SHORT_BUILDUP';
    } else if (ceDown && ceLtpUp) {
      callPattern = 'SHORT_COVERING';
    }
  }

  if (strike.pe) {
    const peUp = strike.pe.ltp > 0 && strike.pe.oiChg > 0;
    const peDown = strike.pe.oiChg < 0;
    const peLtpUp = strike.pe.ltp > 0;
    if (peUp && peLtpUp) {
      putPattern = 'LONG_BUILDUP';
    } else if (peDown && !peLtpUp) {
      putPattern = 'LONG_UNWINDING';
    } else if (peUp && !peLtpUp) {
      putPattern = 'SHORT_BUILDUP';
    } else if (peDown && peLtpUp) {
      putPattern = 'SHORT_COVERING';
    }
  }

  return { strike: strike.strike, callPattern, putPattern };
}

export { classifyOIPattern };

// ─── Fresh Writing Detection ──────────────────────────────────────

function detectFreshWriting(
  optionChain: SDMOptionStrike[],
  spot: number,
): FreshWritingSignal[] {
  const signals: FreshWritingSignal[] = [];

  for (const strike of optionChain) {
    // Fresh Call Writing: CE OI ↑ sharply, CE LTP flat/down, near/above spot
    if (strike.ce && strike.strike >= spot) {
      const oiPctChange =
        strike.ce.oi > 0
          ? (Math.abs(strike.ce.oiChg) / strike.ce.oi) * 100
          : 0;

      if (oiPctChange > 20 && strike.ce.oiChg > 0 && strike.ce.ltp <= 0) {
        const ltpDir: 'UP' | 'DOWN' | 'FLAT' =
          strike.ce.ltp > 0 ? 'UP' : strike.ce.ltp < 0 ? 'DOWN' : 'FLAT';
        signals.push({
          strike: strike.strike,
          side: 'CE',
          type: 'FRESH_CALL_WRITING',
          oiChange: strike.ce.oiChg,
          oiPercentChange: oiPctChange,
          ltpDirection: ltpDir,
        });
      }
    }

    // Fresh Put Writing: PE OI ↑ sharply, PE LTP flat/down, near/below spot
    if (strike.pe && strike.strike <= spot) {
      const oiPctChange =
        strike.pe.oi > 0
          ? (Math.abs(strike.pe.oiChg) / strike.pe.oi) * 100
          : 0;

      if (oiPctChange > 20 && strike.pe.oiChg > 0 && strike.pe.ltp <= 0) {
        const ltpDir: 'UP' | 'DOWN' | 'FLAT' =
          strike.pe.ltp > 0 ? 'UP' : strike.pe.ltp < 0 ? 'DOWN' : 'FLAT';
        signals.push({
          strike: strike.strike,
          side: 'PE',
          type: 'FRESH_PUT_WRITING',
          oiChange: strike.pe.oiChg,
          oiPercentChange: oiPctChange,
          ltpDirection: ltpDir,
        });
      }
    }
  }

  return signals;
}

export { detectFreshWriting };

// ─── OI Trap Detection ───────────────────────────────────────────

function detectOITraps(
  optionChain: SDMOptionStrike[],
  spot: number,
): OITrap[] {
  const traps: OITrap[] = [];

  for (const strike of optionChain) {
    // CE trap: high CE OI, spot moved above strike (call holders winning = writers trapped)
    if (strike.ce && spot > strike.strike && strike.ce.oi > 0) {
      traps.push({
        strike: strike.strike,
        type: 'CE_TRAP',
        trappedOI: strike.ce.oi,
        spotVsStrike: spot - strike.strike,
      });
    }

    // PE trap: high PE OI, spot moved below strike (put holders winning = writers trapped)
    if (strike.pe && spot < strike.strike && strike.pe.oi > 0) {
      traps.push({
        strike: strike.strike,
        type: 'PE_TRAP',
        trappedOI: strike.pe.oi,
        spotVsStrike: spot - strike.strike,
      });
    }
  }

  // Sort by trapped OI descending
  traps.sort((a, b) => b.trappedOI - a.trappedOI);
  return traps;
}

export { detectOITraps };

// ─── Support / Resistance from OI Concentration ───────────────────

function computeSupportResistance(
  optionChain: SDMOptionStrike[],
  spot: number,
): SRLines {
  const TOP_N = 5;

  // Resistance candidates: strikes above spot with call OI
  const resistanceCandidates: { strike: number; oi: number; weight: number }[] =
    [];
  // Support candidates: strikes below spot with put OI
  const supportCandidates: { strike: number; oi: number; weight: number }[] = [];

  for (const strike of optionChain) {
    if (strike.ce && strike.strike > spot) {
      const dist = Math.max(1, Math.abs(strike.strike - spot));
      resistanceCandidates.push({
        strike: strike.strike,
        oi: strike.ce.oi,
        weight: strike.ce.oi / dist,
      });
    }
    if (strike.pe && strike.strike < spot) {
      const dist = Math.max(1, Math.abs(strike.strike - spot));
      supportCandidates.push({
        strike: strike.strike,
        oi: strike.pe.oi,
        weight: strike.pe.oi / dist,
      });
    }
  }

  resistanceCandidates.sort((a, b) => b.weight - a.weight);
  supportCandidates.sort((a, b) => b.weight - a.weight);

  return {
    resistance: resistanceCandidates.slice(0, TOP_N),
    support: supportCandidates.slice(0, TOP_N),
  };
}

export { computeSupportResistance };

// ─── OI Migration Detection ──────────────────────────────────────

function detectOIMigration(
  prevChain: SDMOptionStrike[],
  currentChain: SDMOptionStrike[],
): OIMigration[] {
  const migrations: OIMigration[] = [];
  const DECREASE_THRESHOLD = 0.15; // 15% drop in OI
  const INCREASE_THRESHOLD = 0.15; // 15% rise in OI

  // Build lookup from previous chain
  const prevMap = new Map<number, SDMOptionStrike>();
  for (const s of prevChain) prevMap.set(s.strike, s);

  for (let i = 0; i < currentChain.length; i++) {
    const curr = currentChain[i];
    const prev = prevMap.get(curr.strike);
    if (!prev) continue;

    // CE migration
    if (prev.ce && curr.ce && prev.ce.oi > 0 && curr.ce.oi > 0) {
      const ceOiChg = (curr.ce.oi - prev.ce.oi) / prev.ce.oi;

      // If CE OI dropped significantly at this strike, check neighbor strikes
      if (ceOiChg < -DECREASE_THRESHOLD) {
        // Look forward (higher strikes) for OI increase
        for (let j = i + 1; j < currentChain.length; j++) {
          const next = currentChain[j];
          const nextPrev = prevMap.get(next.strike);
          if (nextPrev?.ce && next.ce && nextPrev.ce.oi > 0 && next.ce.oi > 0) {
            const nextOiChg = (next.ce.oi - nextPrev.ce.oi) / nextPrev.ce.oi;
            if (nextOiChg > INCREASE_THRESHOLD) {
              migrations.push({
                side: 'CE',
                fromStrike: curr.strike,
                toStrike: next.strike,
                oiLost: prev.ce.oi - curr.ce.oi,
                oiGained: next.ce.oi - nextPrev.ce.oi,
              });
              break;
            }
          }
        }

        // Look backward (lower strikes) for OI increase
        for (let j = i - 1; j >= 0; j--) {
          const next = currentChain[j];
          const nextPrev = prevMap.get(next.strike);
          if (nextPrev?.ce && next.ce && nextPrev.ce.oi > 0 && next.ce.oi > 0) {
            const nextOiChg = (next.ce.oi - nextPrev.ce.oi) / nextPrev.ce.oi;
            if (nextOiChg > INCREASE_THRESHOLD) {
              migrations.push({
                side: 'CE',
                fromStrike: curr.strike,
                toStrike: next.strike,
                oiLost: prev.ce.oi - curr.ce.oi,
                oiGained: next.ce.oi - nextPrev.ce.oi,
              });
              break;
            }
          }
        }
      }
    }

    // PE migration
    if (prev.pe && curr.pe && prev.pe.oi > 0 && curr.pe.oi > 0) {
      const peOiChg = (curr.pe.oi - prev.pe.oi) / prev.pe.oi;

      if (peOiChg < -DECREASE_THRESHOLD) {
        for (let j = i + 1; j < currentChain.length; j++) {
          const next = currentChain[j];
          const nextPrev = prevMap.get(next.strike);
          if (nextPrev?.pe && next.pe && nextPrev.pe.oi > 0 && next.pe.oi > 0) {
            const nextOiChg = (next.pe.oi - nextPrev.pe.oi) / nextPrev.pe.oi;
            if (nextOiChg > INCREASE_THRESHOLD) {
              migrations.push({
                side: 'PE',
                fromStrike: curr.strike,
                toStrike: next.strike,
                oiLost: prev.pe.oi - curr.pe.oi,
                oiGained: next.pe.oi - nextPrev.pe.oi,
              });
              break;
            }
          }
        }

        for (let j = i - 1; j >= 0; j--) {
          const next = currentChain[j];
          const nextPrev = prevMap.get(next.strike);
          if (nextPrev?.pe && next.pe && nextPrev.pe.oi > 0 && next.pe.oi > 0) {
            const nextOiChg = (next.pe.oi - nextPrev.pe.oi) / nextPrev.pe.oi;
            if (nextOiChg > INCREASE_THRESHOLD) {
              migrations.push({
                side: 'PE',
                fromStrike: curr.strike,
                toStrike: next.strike,
                oiLost: prev.pe.oi - curr.pe.oi,
                oiGained: next.pe.oi - nextPrev.pe.oi,
              });
              break;
            }
          }
        }
      }
    }
  }

  return migrations;
}

export { detectOIMigration };

// ─── Max Pain Calculation ─────────────────────────────────────────

function computeMaxPain(optionChain: SDMOptionStrike[]): number {
  if (optionChain.length === 0) return 0;

  const strikes = optionChain.map((s) => s.strike);
  const minStrike = Math.min(...strikes);
  const maxStrike = Math.max(...strikes);

  let maxPainStrike = minStrike;
  let minTotalLoss = Infinity;

  // For each candidate expiry price, compute total payout to option holders
  for (let price = minStrike; price <= maxStrike; price += 1) {
    let totalLoss = 0;

    for (const strike of optionChain) {
      // Call holders profit if price > strike
      if (strike.ce && price > strike.strike) {
        totalLoss += (price - strike.strike) * strike.ce.oi;
      }
      // Put holders profit if price < strike
      if (strike.pe && price < strike.strike) {
        totalLoss += (strike.strike - price) * strike.pe.oi;
      }
    }

    if (totalLoss < minTotalLoss) {
      minTotalLoss = totalLoss;
      maxPainStrike = price;
    }
  }

  return maxPainStrike;
}

// ─── PCR Calculations ────────────────────────────────────────────

function computePCR(optionChain: SDMOptionStrike[]) {
  let totalCallOI = 0;
  let totalPutOI = 0;
  let totalCallVolume = 0;
  let totalPutVolume = 0;

  for (const strike of optionChain) {
    if (strike.ce) {
      totalCallOI += strike.ce.oi;
      totalCallVolume += strike.ce.volume;
    }
    if (strike.pe) {
      totalPutOI += strike.pe.oi;
      totalPutVolume += strike.pe.volume;
    }
  }

  return {
    pcrOI: totalCallOI > 0 ? totalPutOI / totalCallOI : 0,
    pcrVolume: totalCallVolume > 0 ? totalPutVolume / totalCallVolume : 0,
  };
}

// ─── Main Entry Point ────────────────────────────────────────────

function analyzeOptionChain(
  optionChain: SDMOptionStrike[],
  spot: number,
  prevChain?: SDMOptionStrike[],
): OIAnalysis {
  const status: 'OK' | 'DEGRADED' = optionChain.length < 5 ? 'DEGRADED' : 'OK';

  const classifications = optionChain.map(classifyOIPattern);
  const freshWriting = detectFreshWriting(optionChain, spot);
  const traps = detectOITraps(optionChain, spot);
  const supportResistance = computeSupportResistance(optionChain, spot);
  const migration = prevChain
    ? detectOIMigration(prevChain, optionChain)
    : [];
  const { pcrOI, pcrVolume } = computePCR(optionChain);
  const maxPain = computeMaxPain(optionChain);

  return {
    classifications,
    freshWriting,
    traps,
    supportResistance,
    migration,
    pcrOI,
    pcrVolume,
    maxPain,
    status,
  };
}

export { analyzeOptionChain };
