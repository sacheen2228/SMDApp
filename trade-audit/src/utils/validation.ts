import { z } from "zod";

const marketContextSchema = z.record(z.string(), z.unknown()).default({});

export const newSignalSchema = z.object({
  tradeId: z.string().optional(),
  strategyId: z.string().min(1),
  strategyVersion: z.string().min(1),
  symbol: z.string().min(1),
  exchange: z.string().min(1),
  instrumentType: z.enum(["EQUITY", "FUTURES", "OPTIONS", "INDEX"]),
  spotPrice: z.number(),
  strikePrice: z.number().nullable().optional(),
  expiry: z.string().nullable().optional(),
  optionType: z.enum(["CE", "PE"]).nullable().optional(),
  entryPrice: z.number(),
  stopLoss: z.number(),
  tp1: z.number(),
  tp2: z.number().nullable().optional(),
  tp3: z.number().nullable().optional(),
  signalConfidence: z.number().min(0).max(100),
  aiConfidence: z.number().min(0).max(100).nullable().optional(),
  probabilityScore: z.number().min(0).max(1).nullable().optional(),
  trendDirection: z.enum(["BULLISH", "BEARISH", "NEUTRAL"]),
  signalReason: z.string().min(1),
  marketSession: z
    .enum(["PRE_OPEN", "OPENING", "MORNING", "MIDDAY", "AFTERNOON", "CLOSING", "POST_CLOSE"])
    .optional(),
  userAccount: z.string().nullable().optional(),
  marketContext: marketContextSchema,
  signalTimeIst: z.string().optional(),
});

export const priceUpdateSchema = z.object({
  price: z.number(),
  timestampIst: z.string().optional(),
});

export const closeTradeSchema = z.object({
  exitPrice: z.number(),
  exitReason: z.enum([
    "tp1",
    "tp2",
    "tp3",
    "stop_loss",
    "trailing_stop",
    "manual",
    "time_exit",
    "btst_square_off",
  ]),
  exitTimeIst: z.string().optional(),
  fees: z.number().optional(),
});

export const tradeFiltersSchema = z.object({
  strategyId: z.string().optional(),
  symbol: z.string().optional(),
  instrumentType: z.enum(["EQUITY", "FUTURES", "OPTIONS", "INDEX"]).optional(),
  status: z.enum(["open", "closed"]).optional(),
  outcome: z.enum(["win", "loss"]).optional(),
  marketSession: z
    .enum(["PRE_OPEN", "OPENING", "MORNING", "MIDDAY", "AFTERNOON", "CLOSING", "POST_CLOSE"])
    .optional(),
  minConfidence: z.coerce.number().optional(),
  maxConfidence: z.coerce.number().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});
