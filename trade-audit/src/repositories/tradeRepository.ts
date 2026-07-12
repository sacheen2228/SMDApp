import { db } from "../db";
import {
  MarketContext,
  TradeFilters,
  TradeRecord,
  TradeVerification,
} from "../types";

/** Raw column shape as it comes back from better-sqlite3 (snake_case, 0/1 booleans). */
interface TradeRow {
  id: string;
  strategy_id: string;
  strategy_version: string;
  created_at_ist: string;
  symbol: string;
  exchange: string;
  instrument_type: string;
  spot_price: number;
  strike_price: number | null;
  expiry: string | null;
  option_type: string | null;
  entry_price: number;
  stop_loss: number;
  tp1: number;
  tp2: number | null;
  tp3: number | null;
  risk_reward_ratio: number;
  signal_confidence: number;
  ai_confidence: number | null;
  probability_score: number | null;
  trend_direction: string;
  signal_reason: string;
  market_session: string;
  user_account: string | null;
  market_context_json: string;

  status: string;
  entry_filled: number;
  highest_price: number | null;
  lowest_price: number | null;
  mfe: number | null;
  mae: number | null;
  tp1_hit: number;
  tp1_hit_at: string | null;
  tp2_hit: number;
  tp2_hit_at: string | null;
  tp3_hit: number;
  tp3_hit_at: string | null;
  sl_hit: number;
  trailing_stop: number | null;
  trailing_stop_hit: number;
  last_price: number | null;
  last_update_at: string | null;

  exit_price: number | null;
  exit_time: string | null;
  exit_reason: string | null;
  gross_pnl: number | null;
  fees: number;
  net_pnl: number | null;
  roi_pct: number | null;
  r_multiple: number | null;
  time_in_trade_sec: number | null;

  verification_json: string | null;
}

function rowToRecord(row: TradeRow): TradeRecord {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    createdAtIst: row.created_at_ist,
    symbol: row.symbol,
    exchange: row.exchange,
    instrumentType: row.instrument_type as TradeRecord["instrumentType"],
    spotPrice: row.spot_price,
    strikePrice: row.strike_price,
    expiry: row.expiry,
    optionType: row.option_type as TradeRecord["optionType"],
    entryPrice: row.entry_price,
    stopLoss: row.stop_loss,
    tp1: row.tp1,
    tp2: row.tp2,
    tp3: row.tp3,
    riskRewardRatio: row.risk_reward_ratio,
    signalConfidence: row.signal_confidence,
    aiConfidence: row.ai_confidence,
    probabilityScore: row.probability_score,
    trendDirection: row.trend_direction as TradeRecord["trendDirection"],
    signalReason: row.signal_reason,
    marketSession: row.market_session as TradeRecord["marketSession"],
    userAccount: row.user_account,
    marketContext: JSON.parse(row.market_context_json) as MarketContext,

    status: row.status as TradeRecord["status"],
    entryFilled: !!row.entry_filled,
    highestPrice: row.highest_price,
    lowestPrice: row.lowest_price,
    mfe: row.mfe,
    mae: row.mae,
    tp1Hit: !!row.tp1_hit,
    tp1HitAt: row.tp1_hit_at,
    tp2Hit: !!row.tp2_hit,
    tp2HitAt: row.tp2_hit_at,
    tp3Hit: !!row.tp3_hit,
    tp3HitAt: row.tp3_hit_at,
    slHit: !!row.sl_hit,
    trailingStop: row.trailing_stop,
    trailingStopHit: !!row.trailing_stop_hit,
    lastPrice: row.last_price,
    lastUpdateAt: row.last_update_at,

    exitPrice: row.exit_price,
    exitTime: row.exit_time,
    exitReason: row.exit_reason as TradeRecord["exitReason"],
    grossPnl: row.gross_pnl,
    fees: row.fees,
    netPnl: row.net_pnl,
    roiPct: row.roi_pct,
    rMultiple: row.r_multiple,
    timeInTradeSec: row.time_in_trade_sec,

    verification: row.verification_json
      ? (JSON.parse(row.verification_json) as TradeVerification)
      : null,
  };
}

export function insertTrade(record: TradeRecord): void {
  db.prepare(
    `INSERT INTO trades (
      id, strategy_id, strategy_version, created_at_ist, symbol, exchange, instrument_type,
      spot_price, strike_price, expiry, option_type, entry_price, stop_loss, tp1, tp2, tp3,
      risk_reward_ratio, signal_confidence, ai_confidence, probability_score, trend_direction,
      signal_reason, market_session, user_account, market_context_json,
      status, entry_filled, fees
    ) VALUES (
      @id, @strategyId, @strategyVersion, @createdAtIst, @symbol, @exchange, @instrumentType,
      @spotPrice, @strikePrice, @expiry, @optionType, @entryPrice, @stopLoss, @tp1, @tp2, @tp3,
      @riskRewardRatio, @signalConfidence, @aiConfidence, @probabilityScore, @trendDirection,
      @signalReason, @marketSession, @userAccount, @marketContextJson,
      @status, @entryFilled, @fees
    )`
  ).run({
    id: record.id,
    strategyId: record.strategyId,
    strategyVersion: record.strategyVersion,
    createdAtIst: record.createdAtIst,
    symbol: record.symbol,
    exchange: record.exchange,
    instrumentType: record.instrumentType,
    spotPrice: record.spotPrice,
    strikePrice: record.strikePrice,
    expiry: record.expiry,
    optionType: record.optionType,
    entryPrice: record.entryPrice,
    stopLoss: record.stopLoss,
    tp1: record.tp1,
    tp2: record.tp2,
    tp3: record.tp3,
    riskRewardRatio: record.riskRewardRatio,
    signalConfidence: record.signalConfidence,
    aiConfidence: record.aiConfidence,
    probabilityScore: record.probabilityScore,
    trendDirection: record.trendDirection,
    signalReason: record.signalReason,
    marketSession: record.marketSession,
    userAccount: record.userAccount,
    marketContextJson: JSON.stringify(record.marketContext ?? {}),
    status: record.status,
    entryFilled: record.entryFilled ? 1 : 0,
    fees: record.fees ?? 0,
  });
}

export function findById(id: string): TradeRecord | null {
  const row = db.prepare("SELECT * FROM trades WHERE id = ?").get(id) as TradeRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function existsById(id: string): boolean {
  const row = db.prepare("SELECT 1 FROM trades WHERE id = ?").get(id);
  return !!row;
}

export function updateTracking(
  id: string,
  fields: Partial<{
    highestPrice: number | null;
    lowestPrice: number | null;
    mfe: number | null;
    mae: number | null;
    tp1Hit: boolean;
    tp1HitAt: string | null;
    tp2Hit: boolean;
    tp2HitAt: string | null;
    tp3Hit: boolean;
    tp3HitAt: string | null;
    slHit: boolean;
    trailingStop: number | null;
    trailingStopHit: boolean;
    lastPrice: number | null;
    lastUpdateAt: string | null;
  }>
): void {
  const columnMap: Record<string, string> = {
    highestPrice: "highest_price",
    lowestPrice: "lowest_price",
    mfe: "mfe",
    mae: "mae",
    tp1Hit: "tp1_hit",
    tp1HitAt: "tp1_hit_at",
    tp2Hit: "tp2_hit",
    tp2HitAt: "tp2_hit_at",
    tp3Hit: "tp3_hit",
    tp3HitAt: "tp3_hit_at",
    slHit: "sl_hit",
    trailingStop: "trailing_stop",
    trailingStopHit: "trailing_stop_hit",
    lastPrice: "last_price",
    lastUpdateAt: "last_update_at",
  };

  const setClauses: string[] = [];
  const params: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(fields)) {
    const column = columnMap[key];
    if (!column) continue;
    setClauses.push(`${column} = @${key}`);
    params[key] = typeof value === "boolean" ? (value ? 1 : 0) : value;
  }

  if (setClauses.length === 0) return;

  db.prepare(`UPDATE trades SET ${setClauses.join(", ")} WHERE id = @id`).run(params);
}

export function closeTradeRow(
  id: string,
  fields: {
    exitPrice: number;
    exitTime: string;
    exitReason: string;
    grossPnl: number;
    netPnl: number;
    fees: number;
    roiPct: number;
    rMultiple: number;
    timeInTradeSec: number;
    verification: TradeVerification;
  }
): void {
  db.prepare(
    `UPDATE trades SET
      status = 'closed',
      exit_price = @exitPrice,
      exit_time = @exitTime,
      exit_reason = @exitReason,
      gross_pnl = @grossPnl,
      net_pnl = @netPnl,
      fees = @fees,
      roi_pct = @roiPct,
      r_multiple = @rMultiple,
      time_in_trade_sec = @timeInTradeSec,
      verification_json = @verificationJson
    WHERE id = @id`
  ).run({
    id,
    exitPrice: fields.exitPrice,
    exitTime: fields.exitTime,
    exitReason: fields.exitReason,
    grossPnl: fields.grossPnl,
    netPnl: fields.netPnl,
    fees: fields.fees,
    roiPct: fields.roiPct,
    rMultiple: fields.rMultiple,
    timeInTradeSec: fields.timeInTradeSec,
    verificationJson: JSON.stringify(fields.verification),
  });
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function queryTrades(filters: TradeFilters): PaginatedResult<TradeRecord> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, filters.pageSize ?? 50));
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.strategyId) {
    where.push("strategy_id = @strategyId");
    params.strategyId = filters.strategyId;
  }
  if (filters.symbol) {
    where.push("symbol = @symbol");
    params.symbol = filters.symbol;
  }
  if (filters.instrumentType) {
    where.push("instrument_type = @instrumentType");
    params.instrumentType = filters.instrumentType;
  }
  if (filters.status) {
    where.push("status = @status");
    params.status = filters.status;
  }
  if (filters.marketSession) {
    where.push("market_session = @marketSession");
    params.marketSession = filters.marketSession;
  }
  if (filters.minConfidence !== undefined) {
    where.push("signal_confidence >= @minConfidence");
    params.minConfidence = filters.minConfidence;
  }
  if (filters.maxConfidence !== undefined) {
    where.push("signal_confidence <= @maxConfidence");
    params.maxConfidence = filters.maxConfidence;
  }
  if (filters.dateFrom) {
    where.push("created_at_ist >= @dateFrom");
    params.dateFrom = filters.dateFrom;
  }
  if (filters.dateTo) {
    where.push("created_at_ist <= @dateTo");
    params.dateTo = filters.dateTo;
  }
  if (filters.outcome === "win") {
    where.push("net_pnl > 0");
  } else if (filters.outcome === "loss") {
    where.push("net_pnl <= 0 AND status = 'closed'");
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = (
    db.prepare(`SELECT COUNT(*) as c FROM trades ${whereSql}`).get(params) as { c: number }
  ).c;

  const rows = db
    .prepare(
      `SELECT * FROM trades ${whereSql} ORDER BY created_at_ist DESC LIMIT @pageSize OFFSET @offset`
    )
    .all({ ...params, pageSize, offset }) as TradeRow[];

  return {
    items: rows.map(rowToRecord),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Unfiltered-by-pagination fetch, used by the stats/verification engine. */
export function queryAllForStats(filters: Omit<TradeFilters, "page" | "pageSize">): TradeRecord[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.strategyId) {
    where.push("strategy_id = @strategyId");
    params.strategyId = filters.strategyId;
  }
  if (filters.symbol) {
    where.push("symbol = @symbol");
    params.symbol = filters.symbol;
  }
  if (filters.instrumentType) {
    where.push("instrument_type = @instrumentType");
    params.instrumentType = filters.instrumentType;
  }
  if (filters.marketSession) {
    where.push("market_session = @marketSession");
    params.marketSession = filters.marketSession;
  }
  if (filters.dateFrom) {
    where.push("created_at_ist >= @dateFrom");
    params.dateFrom = filters.dateFrom;
  }
  if (filters.dateTo) {
    where.push("created_at_ist <= @dateTo");
    params.dateTo = filters.dateTo;
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM trades ${whereSql} ORDER BY created_at_ist ASC`)
    .all(params) as TradeRow[];
  return rows.map(rowToRecord);
}
