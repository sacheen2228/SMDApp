// MCX Volume & OI Engine — Volume profile, OI classification, divergence
// OI + Volume + Price together tell the participation story.
// Never uses OI classification alone.

import type { MCXCommodity } from './types';

export type OIClassification =
  | 'LONG_BUILDUP' | 'SHORT_BUILDUP'
  | 'SHORT_COVERING' | 'LONG_UNWINDING'
  | 'NEUTRAL';

export type VolumeState = 'EXPANDING' | 'CONTRACTING' | 'ABSORPTION' | 'REJECTION' | 'NORMAL';

export interface MCXVolumeOIResult {
  oiClassification: OIClassification;
  oiDivergence: boolean;
  oiDivergenceDetail: string;
  relativeVolume: number; // current / average
  volumeState: VolumeState;
  totalCEVolume: number;
  totalPEVolume: number;
  totalCEOI: number;
  totalPEOI: number;
  pcrVolume: number;
  pcrOI: number;
  volumeTrend: 'INCREASING' | 'DECREASING' | 'FLAT';
  oiChange: number;
  confidence: number;
  evidence: string[];
}

interface VolumeOIData {
  price: number;
  prevPrice: number;
  volume: number;
  avgVolume: number;
  oi: number;
  prevOI: number;
  ceVolume?: number;
  peVolume?: number;
  ceOI?: number;
  peOI?: number;
}

// ── Classify OI based on price + OI changes ──
function classifyOI(priceChange: number, oiChange: number): OIClassification {
  if (priceChange > 0 && oiChange > 0) return 'LONG_BUILDUP';
  if (priceChange < 0 && oiChange > 0) return 'SHORT_BUILDUP';
  if (priceChange > 0 && oiChange < 0) return 'SHORT_COVERING';
  if (priceChange < 0 && oiChange < 0) return 'LONG_UNWINDING';
  return 'NEUTRAL';
}

// ── Detect OI divergence ──
function detectOIDivergence(
  priceChange: number,
  oiChange: number,
  volumeChange: number
): { divergence: boolean; detail: string } {
  // Price up but OI down = divergence (short covering, not genuine buying)
  if (priceChange > 0 && oiChange < 0 && Math.abs(oiChange) > 100) {
    return { divergence: true, detail: 'Price rising but OI falling — short covering, not genuine buying' };
  }
  // Price down but OI down = divergence (long unwinding, not genuine selling)
  if (priceChange < 0 && oiChange < 0 && Math.abs(oiChange) > 100) {
    return { divergence: true, detail: 'Price falling but OI falling — long unwinding, not genuine selling' };
  }
  // Volume flat but OI rising sharply = unusual positioning
  if (Math.abs(volumeChange) < 0.1 && Math.abs(oiChange) > 500) {
    return { divergence: true, detail: 'OI changing significantly without volume confirmation' };
  }
  return { divergence: false, detail: 'No divergence' };
}

// ── Classify volume state ──
function classifyVolumeState(relVolume: number, priceChange: number): VolumeState {
  if (relVolume > 2.0) return 'EXPANDING';
  if (relVolume < 0.5) return 'CONTRACTING';
  // High volume + small price move = absorption
  if (relVolume > 1.5 && Math.abs(priceChange) < 0.3) return 'ABSORPTION';
  // High volume + large price rejection = rejection
  if (relVolume > 1.5 && Math.abs(priceChange) > 2) return 'REJECTION';
  return 'NORMAL';
}

// ── Main volume/OI analysis ──
export function analyzeMCXVolumeOI(
  _symbol: MCXCommodity,
  data: VolumeOIData
): MCXVolumeOIResult {
  const evidence: string[] = [];

  const priceChange = data.prevPrice > 0
    ? ((data.price - data.prevPrice) / data.prevPrice) * 100
    : 0;
  const oiChange = data.oi - data.prevOI;
  const relVolume = data.avgVolume > 0 ? data.volume / data.avgVolume : 1;
  const volumeChange = data.avgVolume > 0 ? (data.volume - data.avgVolume) / data.avgVolume : 0;

  // OI classification
  const oiClassification = classifyOI(priceChange, oiChange);

  // OI divergence
  const { divergence: oiDivergence, detail: oiDivergenceDetail } = detectOIDivergence(priceChange, oiChange, volumeChange);

  // Volume state
  const volumeState = classifyVolumeState(relVolume, priceChange);

  // PCR
  const totalCEVolume = data.ceVolume || 0;
  const totalPEVolume = data.peVolume || 0;
  const totalCEOI = data.ceOI || 0;
  const totalPEOI = data.peOI || 0;
  const pcrVolume = totalCEVolume > 0 ? totalPEVolume / totalCEVolume : 0;
  const pcrOI = totalCEOI > 0 ? totalPEOI / totalCEOI : 0;

  // Volume trend (simplified — needs historical data for full trend)
  let volumeTrend: 'INCREASING' | 'DECREASING' | 'FLAT' = 'FLAT';
  if (relVolume > 1.3) volumeTrend = 'INCREASING';
  else if (relVolume < 0.7) volumeTrend = 'DECREASING';

  // Confidence
  let confidence = 50;
  if (oiClassification !== 'NEUTRAL') confidence += 15;
  if (volumeState === 'EXPANDING') confidence += 10;
  if (oiDivergence) confidence -= 20;
  if (relVolume < 0.3) confidence -= 15;
  confidence = Math.max(0, Math.min(100, confidence));

  // Evidence
  evidence.push(`OI: ${oiClassification.replace(/_/g, ' ').toLowerCase()}`);
  evidence.push(`Volume: ${relVolume.toFixed(1)}x avg (${volumeState})`);
  if (oiDivergence) evidence.push(`OI DIVERGENCE: ${oiDivergenceDetail}`);
  if (pcrVolume > 0) evidence.push(`PCR (vol): ${pcrVolume.toFixed(2)}`);
  if (pcrOI > 0) evidence.push(`PCR (OI): ${pcrOI.toFixed(2)}`);

  return {
    oiClassification,
    oiDivergence,
    oiDivergenceDetail,
    relativeVolume: relVolume,
    volumeState,
    totalCEVolume,
    totalPEVolume,
    totalCEOI,
    totalPEOI,
    pcrVolume,
    pcrOI,
    volumeTrend,
    oiChange,
    confidence,
    evidence,
  };
}
