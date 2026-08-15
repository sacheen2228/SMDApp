// Auction Engine - Core of Auction Market Theory implementation
// Calculates POC, VAH, VAL, Value Area, Acceptance/Rejection, Value Migration

import { Candle, VolumeProfile, VolumeProfileLevel, SessionProfile, AcceptanceType, AuctionState } from './auction-types';

const VALUE_AREA_PERCENT = 0.70; // 70% of volume

export function calculateVolumeProfile(candles: Candle[], tickSize: number = 0.05): VolumeProfile {
  if (candles.length === 0) {
    return emptyProfile();
  }

  // Build volume at each price level
  const priceVolumeMap = new Map<number, { volume: number; buyVol: number; sellVol: number }>();

  for (const c of candles) {
    const levels = priceLevelsInCandle(c, tickSize);
    for (const { price, vol, buyVol, sellVol } of levels) {
      const existing = priceVolumeMap.get(price) || { volume: 0, buyVol: 0, sellVol: 0 };
      existing.volume += vol;
      existing.buyVol += buyVol;
      existing.sellVol += sellVol;
      priceVolumeMap.set(price, existing);
    }
  }

  // Convert to sorted array
  const levels: VolumeProfileLevel[] = Array.from(priceVolumeMap.entries())
    .map(([price, v]) => ({
      price,
      volume: v.volume,
      buyVolume: v.buyVol,
      sellVolume: v.sellVol,
      delta: v.buyVol - v.sellVol,
      percentage: 0, // will calculate after total
    }))
    .sort((a, b) => b.volume - a.volume); // sort by volume desc

  const totalVolume = levels.reduce((sum, l) => sum + l.volume, 0);
  if (totalVolume === 0) return emptyProfile();

  // Calculate percentages
  for (const l of levels) {
    l.percentage = (l.volume / totalVolume) * 100;
  }

  // Find POC (highest volume price)
  const poc = levels[0].price;

  // Calculate Value Area (70% of volume around POC)
  const { vah, val, valueAreaVolume } = calculateValueArea(levels, poc, totalVolume);

  // Find HVN (High Volume Nodes) - local volume peaks
  const hvn = findHVN(levels, tickSize);

  // Find LVN (Low Volume Nodes) - volume gaps
  const lvn = findLVN(levels, tickSize);

  // Find naked POCs (POC with single print)
  const nakedPoc = findNakedPOC(levels, candles, tickSize);

  // Find volume gaps
  const volumeGaps = findVolumeGaps(levels, tickSize);

  // Sort levels by price for output
  const sortedLevels = levels.sort((a, b) => a.price - b.price);

  return {
    poc,
    vah,
    val,
    hvn,
    lvn,
    nakedPoc,
    volumeGaps,
    levels: sortedLevels,
    totalVolume,
    valueAreaVolume,
  };
}

function priceLevelsInCandle(c: Candle, tickSize: number): Array<{ price: number; vol: number; buyVol: number; sellVol: number }> {
  const levels: Array<{ price: number; vol: number; buyVol: number; sellVol: number }> = [];
  const range = c.high - c.low;
  if (range <= 0) {
    const price = roundToTick(c.close, tickSize);
    const buyVol = c.close >= c.open ? c.volume : 0;
    const sellVol = c.close < c.open ? c.volume : 0;
    levels.push({ price, vol: c.volume, buyVol, sellVol });
    return levels;
  }

  const numTicks = Math.max(1, Math.round(range / tickSize));
  const volPerTick = c.volume / numTicks;
  const buyVolPerTick = (c.close >= c.open ? c.volume * 0.6 : c.volume * 0.4) / numTicks;
  const sellVolPerTick = volPerTick - buyVolPerTick;

  for (let i = 0; i <= numTicks; i++) {
    const price = roundToTick(c.low + i * tickSize, tickSize);
    levels.push({
      price,
      vol: volPerTick,
      buyVol: buyVolPerTick,
      sellVol: sellVolPerTick,
    });
  }
  return levels;
}

function roundToTick(price: number, tickSize: number): number {
  return Math.round(price / tickSize) * tickSize;
}

function calculateValueArea(
  levels: VolumeProfileLevel[],
  poc: number,
  totalVolume: number
): { vah: number; val: number; valueAreaVolume: number } {
  const targetVolume = totalVolume * VALUE_AREA_PERCENT;
  let accumulated = 0;

  // Find POC index
  const pocIndex = levels.findIndex(l => l.price === poc);
  if (pocIndex === -1) {
    return { vah: poc, val: poc, valueAreaVolume: 0 };
  }

  let vah = poc;
  let val = poc;
  accumulated = levels[pocIndex].volume;

  let upIdx = pocIndex - 1;
  let downIdx = pocIndex + 1;

  while (accumulated < targetVolume && (upIdx >= 0 || downIdx < levels.length)) {
    const upVol = upIdx >= 0 ? levels[upIdx].volume : 0;
    const downVol = downIdx < levels.length ? levels[downIdx].volume : 0;

    if (upVol >= downVol && upIdx >= 0) {
      accumulated += upVol;
      vah = levels[upIdx].price;
      upIdx--;
    } else if (downIdx < levels.length) {
      accumulated += downVol;
      val = levels[downIdx].price;
      downIdx++;
    } else if (upIdx >= 0) {
      accumulated += upVol;
      vah = levels[upIdx].price;
      upIdx--;
    } else {
      break;
    }
  }

  return { vah, val, valueAreaVolume: accumulated };
}

function findHVN(levels: VolumeProfileLevel[], tickSize: number): number[] {
  const hvn: number[] = [];
  const sortedByPrice = [...levels].sort((a, b) => a.price - b.price);

  for (let i = 1; i < sortedByPrice.length - 1; i++) {
    const prev = sortedByPrice[i - 1].volume;
    const curr = sortedByPrice[i].volume;
    const next = sortedByPrice[i + 1].volume;

    if (curr > prev && curr > next && curr > sortedByPrice[0].volume * 0.3) {
      hvn.push(sortedByPrice[i].price);
    }
  }
  return hvn;
}

function findLVN(levels: VolumeProfileLevel[], tickSize: number): number[] {
  const lvn: number[] = [];
  const sortedByPrice = [...levels].sort((a, b) => a.price - b.price);
  const avgVol = levels.reduce((s, l) => s + l.volume, 0) / levels.length;

  for (let i = 1; i < sortedByPrice.length; i++) {
    const priceDiff = sortedByPrice[i].price - sortedByPrice[i - 1].price;
    const expectedTicks = priceDiff / tickSize;
    if (expectedTicks > 3) { // gap of more than 3 ticks
      const vol1 = sortedByPrice[i - 1].volume;
      const vol2 = sortedByPrice[i].volume;
      if (vol1 < avgVol * 0.3 && vol2 < avgVol * 0.3) {
        lvn.push((sortedByPrice[i - 1].price + sortedByPrice[i].price) / 2);
      }
    }
  }
  return lvn;
}

function findNakedPOC(levels: VolumeProfileLevel[], candles: Candle[], tickSize: number): number[] {
  const naked: number[] = [];
  const pocLevel = levels[0];
  // Check if POC was formed by single candle
  for (const c of candles) {
    if (c.high >= pocLevel.price && c.low <= pocLevel.price) {
      const cLevels = priceLevelsInCandle(c, tickSize);
      const pocInCandle = cLevels.find(l => l.price === pocLevel.price);
      if (pocInCandle && pocInCandle.vol === pocLevel.volume) {
        naked.push(pocLevel.price);
      }
    }
  }
  return naked;
}

function findVolumeGaps(levels: VolumeProfileLevel[], tickSize: number): { start: number; end: number }[] {
  const gaps: { start: number; end: number }[] = [];
  const sortedByPrice = [...levels].sort((a, b) => a.price - b.price);
  const avgVol = levels.reduce((s, l) => s + l.volume, 0) / levels.length;

  for (let i = 1; i < sortedByPrice.length; i++) {
    const priceDiff = sortedByPrice[i].price - sortedByPrice[i - 1].price;
    if (priceDiff > tickSize * 2) {
      const midPrice = (sortedByPrice[i - 1].price + sortedByPrice[i].price) / 2;
      if (sortedByPrice[i - 1].volume < avgVol * 0.2 && sortedByPrice[i].volume < avgVol * 0.2) {
        gaps.push({ start: sortedByPrice[i - 1].price, end: sortedByPrice[i].price });
      }
    }
  }
  return gaps;
}

export function calculateSessionProfile(candles: Candle[], tickSize: number = 0.05): SessionProfile {
  const profile = calculateVolumeProfile(candles, tickSize);
  const sessionHigh = Math.max(...candles.map(c => c.high));
  const sessionLow = Math.min(...candles.map(c => c.low));

  // Opening range (first 15 min)
  const first15m = candles.slice(0, 15);
  const first15mRange = first15m.length > 0 ? {
    high: Math.max(...first15m.map(c => c.high)),
    low: Math.min(...first15m.map(c => c.low)),
    time: first15m[0]?.time || 0,
  } : { high: sessionHigh, low: sessionLow, time: candles[0]?.time || 0 };

  // Initial Balance (first 60 min)
  const first60m = candles.slice(0, 60);
  const initialBalance = first60m.length > 0 ? {
    high: Math.max(...first60m.map(c => c.high)),
    low: Math.min(...first60m.map(c => c.low)),
  } : { high: sessionHigh, low: sessionLow };

  const first30m = candles.slice(0, 30);
  const first30mRange = first30m.length > 0 ? {
    high: Math.max(...first30m.map(c => c.high)),
    low: Math.min(...first30m.map(c => c.low)),
  } : { high: sessionHigh, low: sessionLow };

  // Session VWAP
  let cumPV = 0, cumV = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumV += c.volume;
  }
  const sessionVwap = cumV > 0 ? cumPV / cumV : candles[candles.length - 1]?.close || 0;

  return {
    ...profile,
    date: new Date(candles[0]?.time || Date.now()).toISOString().split('T')[0],
    sessionHigh,
    sessionLow,
    openingRange: first15mRange,
    initialBalance,
    first15mRange,
    first30mRange,
    sessionVwap,
    prevDayHigh: 0,
    prevDayLow: 0,
    prevWeekHigh: 0,
    prevWeekLow: 0,
  };
}

export function calculateCompositeProfile(sessionProfiles: SessionProfile[]): VolumeProfile {
  const allCandles = sessionProfiles.flatMap(p =>
    p.levels.map(l => ({ time: 0, open: l.price, high: l.price, low: l.price, close: l.price, volume: l.volume }))
  );
  return calculateVolumeProfile(allCandles as Candle[]);
}

export function classifyAuctionState(
  currentPrice: number,
  vah: number,
  val: number,
  poc: number
): { state: AuctionState; location: 'ABOVE_VAH' | 'INSIDE_VALUE' | 'BELOW_VAL' } {
  if (currentPrice > vah) return { state: 'PRICE_ABOVE_VALUE', location: 'ABOVE_VAH' };
  if (currentPrice < val) return { state: 'PRICE_BELOW_VALUE', location: 'BELOW_VAL' };
  return { state: 'PRICE_INSIDE_VALUE', location: 'INSIDE_VALUE' };
}

export function detectAcceptance(
  profile: VolumeProfile,
  prevProfile: VolumeProfile | null,
  currentPrice: number
): AcceptanceType {
  if (!prevProfile) return 'BALANCE';

  const pocMigration = profile.poc - prevProfile.poc;
  const vahMigration = profile.vah - prevProfile.vah;
  const valMigration = profile.val - prevProfile.val;

  const valueAreaExpanded = (profile.vah - profile.val) > (prevProfile.vah - prevProfile.val) * 1.1;
  const valueAreaContracted = (profile.vah - profile.val) < (prevProfile.vah - prevProfile.val) * 0.9;

  // Check rejection (price visited level but closed away)
  const visitedVAH = currentPrice >= profile.vah * 0.999 && currentPrice < profile.vah;
  const visitedVAL = currentPrice <= profile.val * 1.001 && currentPrice > profile.val;

  if (pocMigration > prevProfile.poc * 0.002) return 'VALUE_MIGRATION_HIGHER';
  if (pocMigration < -prevProfile.poc * 0.002) return 'VALUE_MIGRATION_LOWER';

  if (visitedVAH && currentPrice < profile.vah) return 'REJECTION';
  if (visitedVAL && currentPrice > profile.val) return 'REJECTION';

  if (valueAreaExpanded) return 'VALUE_EXPANSION';
  if (valueAreaContracted) return 'VALUE_CONTRACTION';

  if (Math.abs(pocMigration) < prevProfile.poc * 0.001) return 'BALANCE';
  return 'IMBALANCE';
}

function emptyProfile(): VolumeProfile {
  return {
    poc: 0, vah: 0, val: 0, hvn: [], lvn: [], nakedPoc: [],
    volumeGaps: [], levels: [], totalVolume: 0, valueAreaVolume: 0,
  };
}