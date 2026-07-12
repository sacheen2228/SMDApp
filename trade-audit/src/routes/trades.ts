import { Router, Request, Response } from "express";
import { closeTrade, recordPriceUpdate, recordSignal } from "../services/recorder";
import { computeAggregateStats } from "../services/verification";
import { toCsv, toJson } from "../services/export";
import { findById } from "../repositories/tradeRepository";
import { queryTrades, queryAllForStats } from "../repositories/tradeRepository";
import { closeTradeSchema, newSignalSchema, priceUpdateSchema, tradeFiltersSchema } from "../utils/validation";

export const tradesRouter = Router();

/** Record a new signal the instant a strategy generates it. Returns 202 — write is async. */
tradesRouter.post("/signals", (req: Request, res: Response) => {
  const parsed = newSignalSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }
  const { tradeId } = recordSignal(parsed.data as any);
  return res.status(202).json({ tradeId, status: "queued" });
});

/** Feed a live price tick for tracking (MFE/MAE, TP/SL detection). Non-blocking. */
tradesRouter.post("/signals/:id/price", (req: Request, res: Response) => {
  const parsed = priceUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }
  recordPriceUpdate(req.params.id, parsed.data);
  return res.status(202).json({ status: "queued" });
});

/** Explicitly close a trade (manual exit, time exit, BTST square-off, etc). Non-blocking. */
tradesRouter.post("/signals/:id/close", (req: Request, res: Response) => {
  const parsed = closeTradeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }
  closeTrade(req.params.id, parsed.data);
  return res.status(202).json({ status: "queued" });
});

/** Fetch a single trade record (full lifecycle state + verification once closed). */
tradesRouter.get("/signals/:id", (req: Request, res: Response) => {
  const trade = findById(req.params.id);
  if (!trade) return res.status(404).json({ error: "not_found" });
  return res.json(trade);
});

/** Paginated, filterable trade search. */
tradesRouter.get("/trades", (req: Request, res: Response) => {
  const parsed = tradeFiltersSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() });
  }
  return res.json(queryTrades(parsed.data));
});

/** Aggregate backtest-verification stats: win rate, avg R, profit factor, drawdown, breakdowns. */
tradesRouter.get("/stats", (req: Request, res: Response) => {
  const parsed = tradeFiltersSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() });
  }
  const { page, pageSize, ...filters } = parsed.data;
  const trades = queryAllForStats(filters);
  return res.json(computeAggregateStats(trades));
});

/** Export filtered trades as CSV or JSON. */
tradesRouter.get("/export/:format", (req: Request, res: Response) => {
  const format = req.params.format;
  if (format !== "csv" && format !== "json") {
    return res.status(400).json({ error: "unsupported_format", details: "use 'csv' or 'json'" });
  }
  const parsed = tradeFiltersSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() });
  }
  const { page, pageSize, ...filters } = parsed.data;
  const trades = queryAllForStats(filters);

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=trades_export.csv");
    return res.send(toCsv(trades));
  }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", "attachment; filename=trades_export.json");
  return res.send(toJson(trades));
});
