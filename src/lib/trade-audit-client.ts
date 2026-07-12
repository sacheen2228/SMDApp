// Client for the Trade Audit (backtest verification) sidecar engine on :4001.
// Browser + server safe. The engine records strategy signals, tracks them
// live, and computes verification stats (win rate, R-multiple, profit factor,
// expectancy, max drawdown, broken down by strategy/symbol/session).

export const TRADE_AUDIT_BASE =
  process.env.NEXT_PUBLIC_TRADE_AUDIT_URL ?? "http://localhost:4001";

export interface AggregateStats {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  todaysTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
  expectancy: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  netPnl: number;
  maxDrawdown: number;
  maxDrawdownPct: number | null;
  bestStrategy: { strategyId: string; netPnl: number } | null;
  worstStrategy: { strategyId: string; netPnl: number } | null;
  byStrategy: StrategyBreakdown[];
  bySymbol: SymbolBreakdown[];
  byMarketSession: SessionBreakdown[];
}

export interface StrategyBreakdown {
  strategyId: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
  netPnl: number;
  profitFactor: number | null;
}

export interface SymbolBreakdown {
  symbol: string;
  trades: number;
  winRate: number;
  netPnl: number;
}

export interface SessionBreakdown {
  marketSession: string;
  trades: number;
  winRate: number;
  netPnl: number;
}

export interface TradeVerification {
  win: boolean;
  entryQuality: "good" | "late" | "early" | "unknown";
  slAssessment: "appropriate" | "too_tight" | "too_wide" | "unknown";
  tpAssessment: "appropriate" | "too_conservative" | "unreached" | "unknown";
  notes: string[];
}

export interface TradeRecord {
  id: string;
  strategyId: string;
  strategyVersion: string;
  createdAtIst: string;
  symbol: string;
  exchange: string;
  instrumentType: string;
  spotPrice: number;
  strikePrice: number | null;
  expiry: string | null;
  optionType: string | null;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number | null;
  tp3: number | null;
  riskRewardRatio: number;
  signalConfidence: number;
  aiConfidence: number | null;
  probabilityScore: number | null;
  trendDirection: string;
  signalReason: string;
  marketSession: string;
  status: "open" | "closed";
  highestPrice: number | null;
  lowestPrice: number | null;
  mfe: number | null;
  mae: number | null;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  slHit: boolean;
  lastPrice: number | null;
  exitPrice: number | null;
  exitTime: string | null;
  exitReason: string | null;
  grossPnl: number | null;
  fees: number;
  netPnl: number | null;
  roiPct: number | null;
  rMultiple: number | null;
  timeInTradeSec: number | null;
  verification: TradeVerification | null;
}

export interface TradeFilters {
  strategyId?: string;
  symbol?: string;
  instrumentType?: string;
  status?: "open" | "closed";
  outcome?: "win" | "loss";
  marketSession?: string;
  minConfidence?: number;
  maxConfidence?: number;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface TradesPage {
  items: TradeRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Loose signal shape the engine accepts (mirrors NewSignalInput). */
export interface SignalInput {
  tradeId?: string;
  strategyId: string;
  strategyVersion: string;
  symbol: string;
  exchange: string;
  instrumentType: "EQUITY" | "FUTURES" | "OPTIONS" | "INDEX";
  spotPrice: number;
  strikePrice?: number | null;
  expiry?: string | null;
  optionType?: "CE" | "PE" | null;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2?: number | null;
  tp3?: number | null;
  signalConfidence: number;
  aiConfidence?: number | null;
  probabilityScore?: number | null;
  trendDirection: "BULLISH" | "BEARISH" | "NEUTRAL";
  signalReason: string;
  marketSession:
    | "PRE_OPEN"
    | "OPENING"
    | "MORNING"
    | "MIDDAY"
    | "AFTERNOON"
    | "CLOSING"
    | "POST_CLOSE";
  userAccount?: string | null;
  marketContext?: Record<string, unknown>;
  signalTimeIst?: string;
}

function toQuery(filters?: TradeFilters): string {
  if (!filters) return "";
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") params.append(k, String(v));
  });
  const s = params.toString();
  return s ? `?${s}` : "";
}

export async function getStats(filters?: TradeFilters): Promise<AggregateStats> {
  const res = await fetch(`${TRADE_AUDIT_BASE}/api/stats${toQuery(filters)}`);
  if (!res.ok) throw new Error(`stats ${res.status}`);
  return res.json();
}

export async function getTrades(filters?: TradeFilters): Promise<TradesPage> {
  const res = await fetch(`${TRADE_AUDIT_BASE}/api/trades${toQuery(filters)}`);
  if (!res.ok) throw new Error(`trades ${res.status}`);
  return res.json();
}

export function exportUrl(format: "csv" | "json", filters?: TradeFilters): string {
  return `${TRADE_AUDIT_BASE}/api/export/${format}${toQuery(filters)}`;
}

/** Record a signal. Fire-and-forget from callers' perspective. */
export async function recordSignal(input: SignalInput): Promise<string | null> {
  try {
    const res = await fetch(`${TRADE_AUDIT_BASE}/api/signals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.tradeId ?? null;
  } catch {
    return null;
  }
}

export async function updatePrice(id: string, price: number): Promise<void> {
  try {
    await fetch(`${TRADE_AUDIT_BASE}/api/signals/${id}/price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ price }),
    });
  } catch {
    /* ignore */
  }
}

export async function closeTrade(
  id: string,
  exitPrice: number,
  exitReason: string,
  fees?: number
): Promise<void> {
  try {
    await fetch(`${TRADE_AUDIT_BASE}/api/signals/${id}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exitPrice, exitReason, fees }),
    });
  } catch {
    /* ignore */
  }
}

export const EMPTY_STATS: AggregateStats = {
  totalTrades: 0,
  openTrades: 0,
  closedTrades: 0,
  todaysTrades: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  avgR: 0,
  expectancy: 0,
  grossProfit: 0,
  grossLoss: 0,
  profitFactor: null,
  netPnl: 0,
  maxDrawdown: 0,
  maxDrawdownPct: null,
  bestStrategy: null,
  worstStrategy: null,
  byStrategy: [],
  bySymbol: [],
  byMarketSession: [],
};
