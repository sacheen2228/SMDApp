// lib/dailyScan.ts
//
// The shared scan engine used by BOTH the morning digest and the
// intraday scanner. For each symbol it pulls a live snapshot, runs the
// same option-alert generator the chat uses, then keeps only setups
// that clear the confidence / risk-reward bar. Caller decides topN,
// minConfidence and minRR.

import { generateOptionAlert, type OptionChainRow, type NewsSentiment, type TradeAlert } from "./tradeAlertEngine";

export interface SymbolSnapshot {
  symbol: string;
  spot: number;
  pcr: number;
  vix: number;
  chain: OptionChainRow[];
  newsSentiment: NewsSentiment;
  expiryLabel?: string;
}

export interface ScanOptions {
  fetchSnapshot: (symbol: string) => Promise<SymbolSnapshot | null>;
  topN?: number;          // how many to return (default 5)
  minConfidence?: number; // 0-1 (default 0.55)
  minRR?: number;         // minimum reward:risk (default 1.2)
}

export interface ScanPick {
  symbol: string;
  confidence: number; // 0-1
  rr: number;
  alert: TradeAlert;
  score: number;       // confidence * rr — used for ranking
}

export async function runDailyScan(
  symbols: string[],
  opts: ScanOptions
): Promise<ScanPick[]> {
  const topN = opts.topN ?? 5;
  const minConfidence = opts.minConfidence ?? 0.55;
  const minRR = opts.minRR ?? 1.2;

  const picks: ScanPick[] = [];

  for (const sym of symbols) {
    let snap: SymbolSnapshot | null = null;
    try {
      snap = await opts.fetchSnapshot(sym);
    } catch {
      snap = null;
    }
    if (!snap || snap.chain.length === 0) continue;

    const alert = generateOptionAlert({
      symbol: snap.symbol || sym,
      spot: snap.spot,
      pcr: snap.pcr,
      vix: snap.vix,
      chain: snap.chain,
      newsSentiment: snap.newsSentiment,
      expiryLabel: snap.expiryLabel,
    });
    if (!alert) continue;

    const confidence = (alert.confidence || 0) / 100;
    const rr = Number(alert.rr) || 1;

    if (confidence < minConfidence || rr < minRR) continue;

    picks.push({
      symbol: snap.symbol || sym,
      confidence,
      rr,
      alert,
      score: confidence * rr,
    });
  }

  picks.sort((a, b) => b.score - a.score);
  return picks.slice(0, topN);
}
