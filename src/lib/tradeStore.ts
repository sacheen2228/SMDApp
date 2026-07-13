// lib/tradeStore.ts
//
// Persists trades to SQLite via Prisma. Called by the active trade tracker
// when trades are created or SL/TP is hit.

const BASE = process.env.INTERNAL_API_BASE || "http://localhost:3000";

export interface TradeRecord {
  tradeId: string;
  symbol: string;
  strike: number;
  type: string;
  side: string;
  entryPrice: number;
  stopLoss: number;
  target1?: number;
  target2?: number;
  target3?: number;
  confidence?: number;
  strategy?: string;
  aiReasonSnapshot?: string;
  riskPerTrade?: number;
  positionSize?: number;
  qualityScore?: number;
  qualityGrade?: string;
}

export async function createTrade(trade: TradeRecord): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/trade-journal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trade),
    });
    const json = await res.json();
    return json.success === true;
  } catch {
    return false;
  }
}

export async function updateTrade(
  tradeId: string,
  updates: {
    status?: string;
    pnl?: number;
    pnlPercent?: number;
    exitPrice?: number;
    exitReason?: string;
    holdingTimeMin?: number;
    tpHitLevel?: string;
  }
): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/trade-journal`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradeId, ...updates }),
    });
    const json = await res.json();
    return json.success === true;
  } catch {
    return false;
  }
}

export async function getTrades(params?: {
  symbol?: string;
  date?: string;
}): Promise<{
  trades: any[];
  stats: any;
}> {
  const query = new URLSearchParams();
  if (params?.symbol) query.set("symbol", params.symbol);
  if (params?.date) query.set("date", params.date);

  try {
    const res = await fetch(`${BASE}/api/trade-journal?${query}`, { cache: "no-store" });
    return await res.json();
  } catch {
    return { trades: [], stats: {} };
  }
}
