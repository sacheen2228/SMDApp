import type { MemoryEntry, MemoryResult, MemoryStats, MarketStateType, MarketIntent, LiquidityNodeType, Destination } from './types';

export class MarketMemory {
  private entries: MemoryEntry[] = [];
  private maxEntries = 500;

  record(entry: MemoryEntry): void {
    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) this.entries.pop();
  }

  getStats(): MemoryStats {
    const total = this.entries.length;
    if (total === 0) {
      return {
        totalTrades: 0, winRate: 0, avgPnl: 0, avgMfe: 0, avgMae: 0,
        bestIntents: [], bestDestinations: [],
      };
    }

    const winners = this.entries.filter(e => e.success);
    const losers = this.entries.filter(e => e.failure);
    const winRate = total > 0 ? winners.length / total * 100 : 0;
    const avgPnl = this.entries.reduce((s, e) => s + e.pnl, 0) / total;
    const avgMfe = this.entries.reduce((s, e) => s + e.mfe, 0) / total;
    const avgMae = this.entries.reduce((s, e) => s + e.mae, 0) / total;

    // Best intents by win rate
    const intentMap = new Map<MarketIntent, { wins: number; total: number }>();
    for (const e of this.entries) {
      const curr = intentMap.get(e.intent) || { wins: 0, total: 0 };
      curr.total++;
      if (e.success) curr.wins++;
      intentMap.set(e.intent, curr);
    }
    const bestIntents = Array.from(intentMap.entries())
      .map(([intent, { wins, total }]) => ({ intent, winRate: total > 0 ? wins / total * 100 : 0, count: total }))
      .filter(x => x.count >= 3)
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 5);

    // Best destination types by win rate
    const destMap = new Map<LiquidityNodeType, { wins: number; total: number }>();
    for (const e of this.entries) {
      if (!e.destination?.node) continue;
      const dt = e.destination.node.type;
      const curr = destMap.get(dt) || { wins: 0, total: 0 };
      curr.total++;
      if (e.success) curr.wins++;
      destMap.set(dt, curr);
    }
    const bestDestinations = Array.from(destMap.entries())
      .map(([type, { wins, total }]) => ({ type, winRate: total > 0 ? wins / total * 100 : 0, count: total }))
      .filter(x => x.count >= 3)
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 5);

    return {
      totalTrades: total,
      winRate: parseFloat(winRate.toFixed(1)),
      avgPnl: parseFloat(avgPnl.toFixed(2)),
      avgMfe: parseFloat(avgMfe.toFixed(2)),
      avgMae: parseFloat(avgMae.toFixed(2)),
      bestIntents,
      bestDestinations,
    };
  }

  getEntries(): MemoryEntry[] {
    return [...this.entries];
  }

  getRecent(n: number): MemoryEntry[] {
    return this.entries.slice(0, n);
  }

  clear(): void {
    this.entries = [];
  }
}
