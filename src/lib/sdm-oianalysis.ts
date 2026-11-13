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
//
// Needs the PREMIUM CHANGE (curr vs prev), not absolute `ltp > 0` — every
// live leg has ltp > 0, so the old check always read "price up" and collapsed
// the 4-way matrix onto LONG_BUILDUP / SHORT_COVERING. Without a prev leg
// the pattern is honestly null (unknown), never fabricated.

function premiumDir(curr: number | undefined, prev: number | undefined): "UP" | "DOWN" | "FLAT" | null {
  if (!(curr! > 0) || !(prev! > 0)) return null;
  if (curr! > prev!) return "UP";
  if (curr! < prev!) return "DOWN";
  return "FLAT";
}

function classifyFromOi(
  oiChg: number,
  priceDir: "UP" | "DOWN" | "FLAT" | null,
): OIPattern | null {
  if (oiChg === 0 || priceDir === null) return null;
  const oiUp = oiChg > 0;
  // FLAT premium + OI change is still a real pattern (writers adding into a
  // stall) — treat FLAT like "not down" for buildup and "not up" for covering.
  if (oiUp && priceDir === "UP") return "LONG_BUILDUP";
  if (oiUp && (priceDir === "DOWN" || priceDir === "FLAT")) return "SHORT_BUILDUP";
  if (!oiUp && priceDir === "UP") return "SHORT_COVERING";
  if (!oiUp && (priceDir === "DOWN" || priceDir === "FLAT")) return "LONG_UNWINDING";
  return null;
}

function classifyOIPattern(
  strike: SDMOptionStrike,
  prev?: SDMOptionStrike,
): OIClassification {
  let callPattern: OIPattern | null = null;
  let putPattern: OIPattern | null = null;

  if (strike.ce) {
    callPattern = classifyFromOi(
      strike.ce.oiChg,
      premiumDir(strike.ce.ltp, prev?.ce?.ltp),
    );
  }

  if (strike.pe) {
    putPattern = classifyFromOi(
      strike.pe.oiChg,
      premiumDir(strike.pe.ltp, prev?.pe?.ltp),
    );
  }

  return { strike: strike.strike, callPattern, putPattern };
}

export { classifyOIPattern };

// ─── Fresh Writing Detection ──────────────────────────────────────
//
// Fresh writing = OI ↑ sharply on the writer's side of spot while the
// premium does NOT rise (writers absorbing, not longs piling in). The old
// gate was `ltp <= 0` — never true on a live chain — so the panel was empty
// forever. Needs a prev chain for the premium direction; without it, no
// signal (unknown ≠ flat).

function detectFreshWriting(
  optionChain: SDMOptionStrike[],
  spot: number,
  prevChain?: SDMOptionStrike[],
): FreshWritingSignal[] {
  const signals: FreshWritingSignal[] = [];
  const prevByStrike = new Map<number, SDMOptionStrike>();
  for (const p of prevChain ?? []) prevByStrike.set(p.strike, p);

  for (const strike of optionChain) {
    const prev = prevByStrike.get(strike.strike);

    // Fresh Call Writing: CE OI ↑ sharply, CE premium flat/down, strike ≥ spot
    if (strike.ce && strike.strike >= spot) {
      const oiPctChange =
        strike.ce.oi > 0
          ? (Math.abs(strike.ce.oiChg) / strike.ce.oi) * 100
          : 0;
      const dir = premiumDir(strike.ce.ltp, prev?.ce?.ltp);
      if (oiPctChange > 20 && strike.ce.oiChg > 0 && dir !== null && dir !== "UP") {
        signals.push({
          strike: strike.strike,
          side: 'CE',
          type: 'FRESH_CALL_WRITING',
          oiChange: strike.ce.oiChg,
          oiPercentChange: oiPctChange,
          ltpDirection: dir,
        });
      }
    }

    // Fresh Put Writing: PE OI ↑ sharply, PE premium flat/down, strike ≤ spot
    if (strike.pe && strike.strike <= spot) {
      const oiPctChange =
        strike.pe.oi > 0
          ? (Math.abs(strike.pe.oiChg) / strike.pe.oi) * 100
          : 0;
      const dir = premiumDir(strike.pe.ltp, prev?.pe?.ltp);
      if (oiPctChange > 20 && strike.pe.oiChg > 0 && dir !== null && dir !== "UP") {
        signals.push({
          strike: strike.strike,
          side: 'PE',
          type: 'FRESH_PUT_WRITING',
          oiChange: strike.pe.oiChg,
          oiPercentChange: oiPctChange,
          ltpDirection: dir,
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

  // Materiality: the doc below says "HIGH CE OI", but the old check was just
  // `oi > 0` — every ITM-side strike qualified, so a full NIFTY chain reported
  // "99 OI traps" (one per losing-side strike). A trap is only a trap when a
  // MATERIAL pool is trapped: OI ≥ 25% of the chain's biggest single side.
  const maxSideOI = Math.max(
    1,
    ...optionChain.map((s) => Math.max(s.ce?.oi ?? 0, s.pe?.oi ?? 0)),
  );
  const minTrappedOI = maxSideOI * 0.25;

  for (const strike of optionChain) {
    // CE trap: high CE OI, spot moved above strike (call holders winning = writers trapped)
    if (strike.ce && spot > strike.strike && strike.ce.oi >= minTrappedOI) {
      traps.push({
        strike: strike.strike,
        type: 'CE_TRAP',
        trappedOI: strike.ce.oi,
        spotVsStrike: spot - strike.strike,
      });
    }

    // PE trap: high PE OI, spot moved below strike (put holders winning = writers trapped)
    if (strike.pe && spot < strike.strike && strike.pe.oi >= minTrappedOI) {
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
  // Only look near price for walls (mirrors option-chain-reader CHAIN_CFG.windowPct).
  const WINDOW = 0.05;

  // Resistance = CE OI walls above spot; Support = PE OI walls below spot.
  // Ranked by RAW OI concentration — NOT OI/distance. The old OI/distance
  // ranking (distance clamped at 1 pt) made the strike one tick away win
  // every time, so the card showed the adjacent strike as "Resistance /
  // Support" no matter where the real wall sat.
  const resistanceCandidates: { strike: number; oi: number; weight: number }[] =
    [];
  const supportCandidates: { strike: number; oi: number; weight: number }[] = [];

  for (const strike of optionChain) {
    if (strike.ce && strike.strike > spot && strike.ce.oi > 0) {
      const dist = Math.abs(strike.strike - spot);
      if (dist <= spot * WINDOW) {
        resistanceCandidates.push({ strike: strike.strike, oi: strike.ce.oi, weight: 0 });
      }
    }
    if (strike.pe && strike.strike < spot && strike.pe.oi > 0) {
      const dist = Math.abs(spot - strike.strike);
      if (dist <= spot * WINDOW) {
        supportCandidates.push({ strike: strike.strike, oi: strike.pe.oi, weight: 0 });
      }
    }
  }

  // Sort by raw OI (the wall), then assign weight = OI share of the side max.
  resistanceCandidates.sort((a, b) => b.oi - a.oi);
  supportCandidates.sort((a, b) => b.oi - a.oi);
  const maxCe = resistanceCandidates[0]?.oi ?? 0;
  const maxPe = supportCandidates[0]?.oi ?? 0;
  for (const r of resistanceCandidates) r.weight = maxCe > 0 ? r.oi / maxCe : 0;
  for (const s of supportCandidates) s.weight = maxPe > 0 ? s.oi / maxPe : 0;

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
// SINGLE SOURCE OF TRUTH for max pain (Phase 5). Callers that used to keep
// a private copy must import this instead.

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

export { computeMaxPain };

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

  const prevByStrike = new Map<number, SDMOptionStrike>();
  for (const p of prevChain ?? []) prevByStrike.set(p.strike, p);
  const classifications = optionChain.map((s) =>
    classifyOIPattern(s, prevByStrike.get(s.strike)),
  );
  const freshWriting = detectFreshWriting(optionChain, spot, prevChain);
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
