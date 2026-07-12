import { Parser as CsvParser } from "json2csv";
import { TradeRecord } from "../types";

/** Flattens the nested marketContext/verification objects so they read cleanly in a spreadsheet. */
function flatten(trade: TradeRecord): Record<string, unknown> {
  const { marketContext, verification, ...rest } = trade;
  const flatContext: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(marketContext ?? {})) {
    flatContext[`ctx_${k}`] = v;
  }
  return {
    ...rest,
    ...flatContext,
    verification_win: verification?.win ?? null,
    verification_entryQuality: verification?.entryQuality ?? null,
    verification_slAssessment: verification?.slAssessment ?? null,
    verification_tpAssessment: verification?.tpAssessment ?? null,
    verification_notes: verification?.notes?.join(" | ") ?? "",
  };
}

export function toCsv(trades: TradeRecord[]): string {
  if (trades.length === 0) return "";
  const parser = new CsvParser({ fields: Object.keys(flatten(trades[0])) });
  return parser.parse(trades.map(flatten));
}

export function toJson(trades: TradeRecord[]): string {
  return JSON.stringify(trades, null, 2);
}
