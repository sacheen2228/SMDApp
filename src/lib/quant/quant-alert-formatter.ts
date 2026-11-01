// quant-alert-formatter.ts — HTML message bodies for UNIVERSAL_QUANT_V1 alerts.
//
// ISOLATION + TRUTH RULES: pure formatter — no DB, no network, no senders.
// Every dynamic value is HTML-escaped (< > &); null/unavailable fields render
// as "N/A"; there are no template placeholders that can reach the user
// unresolved. Labels are static text. Payload fields mirror the QuantPaperTrade
// columns and the QuantDecision sub-objects (contract/plan/risk) so producers
// can pass their existing shapes straight through.

import type { QuantAlertType } from "./quant-alert-policy";
import type { QuantPlan } from "./quant-types";

/**
 * Single flexible payload — every field optional. Producers may pass
 * QuantDecision sub-objects (contract/plan/risk) or QuantPaperTrade-like
 * flat fields; anything missing renders as "N/A".
 */
export interface QuantAlertPayload {
  // identity
  tradeId?: string | null;
  eventId?: string | null;
  decisionId?: string | null;
  // engine context
  mode?: string | null;
  symbol?: string | null;
  exchange?: string | null;
  underlying?: string | null;
  strategy?: string | null;
  direction?: string | null;
  regime?: string | null;
  // contract (QuantContractSelection-like)
  tradingsymbol?: string | null;
  strike?: number | null;
  optionType?: string | null;
  expiry?: string | null;
  lotSize?: number | null;
  lots?: number | null;
  quantity?: number | null;
  // levels (QuantPlan-like)
  entry?: number | null;
  stopLoss?: number | null; // configured SL
  currentStopLoss?: number | null; // SL in force after this event
  targets?: QuantPlan["targets"] | null;
  targetPrice?: number | null; // the TP level price that was hit
  tpLevel?: string | null; // "TP1".."TP4"
  nextTarget?: string | number | null;
  // execution
  fillPrice?: number | null; // simulated fill (entry / TP exits)
  exitPrice?: number | null; // simulated exit (stop exits)
  quantityExited?: number | null;
  remainingQuantity?: number | null;
  realizedPnl?: number | null;
  unrealizedPnl?: number | null;
  estCosts?: number | null;
  riskAmount?: number | null;
  maxLossPlanned?: number | null;
  rewardRisk?: number | null;
  exitReason?: string | null; // STOP_LOSS | TRAILING_SL | BREAKEVEN_SL | GAP_THROUGH_SL
  // provenance
  dataSource?: string | null;
  dataHealth?: string | null;
  eventTime?: number | string | Date | null;
  // free-form
  reasons?: string[] | null;
  message?: string | null;
  source?: string | null;
  detail?: string | null;
  notes?: string | null;
  // daily summary
  trades?: number | null;
  wins?: number | null;
  losses?: number | null;
  winRate?: number | null;
  pnl?: number | null;
  // startup
  symbols?: string[] | null;
}

// ── escape / render helpers ──────────────────────────────────────────

function esc(v: unknown): string {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escaped string; null/undefined/blank → "N/A". Never leaks "undefined". */
function na(v: unknown): string {
  if (v === null || v === undefined) return "N/A";
  const s = String(v);
  if (s.trim() === "") return "N/A";
  return esc(s);
}

/** Finite number → trimmed 2-decimal string; otherwise null. */
function fmtNum(v: unknown): string | null {
  let n: unknown = v;
  if (typeof n === "string" && n.trim() !== "") n = Number(n);
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return String(Math.round(n * 100) / 100);
}

/** Rupee amount; null → "N/A"; negatives carry the sign before the symbol. */
function money(v: unknown): string {
  const s = fmtNum(v);
  if (s === null) return "N/A";
  return s.startsWith("-") ? `-₹${s.slice(1)}` : `₹${s}`;
}

/** Integer-ish render for quantities; null → "N/A". */
function intOrNa(v: unknown): string {
  return fmtNum(v) ?? "N/A";
}

/** IST wall-clock stamp for the event; falls back to now when absent. */
function istStamp(t: unknown): string {
  let ms: number;
  if (typeof t === "number" && Number.isFinite(t)) ms = t;
  else if (t instanceof Date) ms = t.getTime();
  else if (typeof t === "string" && t.trim() !== "" && Number.isFinite(Date.parse(t))) ms = Date.parse(t);
  else ms = Date.now();
  const body = new Date(ms).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${esc(body)} IST`;
}

// ── type → constant maps ─────────────────────────────────────────────

const TP_LEVEL_BY_TYPE: Partial<Record<QuantAlertType, string>> = {
  QUANT_TP1_HIT: "TP1",
  QUANT_TP2_HIT: "TP2",
  QUANT_TP3_HIT: "TP3",
  QUANT_TP4_HIT: "TP4",
};

const EXIT_REASON_BY_TYPE: Partial<Record<QuantAlertType, string>> = {
  QUANT_SL_HIT: "STOP_LOSS",
  QUANT_TRAILING_SL_HIT: "TRAILING_SL",
  QUANT_BREAKEVEN_SL_HIT: "BREAKEVEN_SL",
  QUANT_GAP_THROUGH_SL: "GAP_THROUGH_SL",
};

function titleFor(type: QuantAlertType): string {
  switch (type) {
    case "QUANT_STARTUP":
      return "🚀 <b>UNIVERSAL QUANT — STARTUP</b>";
    case "QUANT_TRADE_CANDIDATE":
      return "📊 <b>UNIVERSAL QUANT — TRADE CANDIDATE</b>";
    case "QUANT_NO_TRADE":
      return "⏸️ <b>UNIVERSAL QUANT — NO TRADE</b>";
    case "QUANT_PAPER_ENTRY":
      return "🟢 <b>UNIVERSAL QUANT — PAPER ENTRY FILLED</b>";
    case "QUANT_SL_HIT":
    case "QUANT_TRAILING_SL_HIT":
    case "QUANT_BREAKEVEN_SL_HIT":
      return "🔴 <b>UNIVERSAL QUANT — STOP LOSS HIT</b>";
    case "QUANT_GAP_THROUGH_SL":
      return "🟠 <b>UNIVERSAL QUANT — GAP THROUGH STOP</b>";
    case "QUANT_TP1_HIT":
      return "🟢 <b>UNIVERSAL QUANT — TP1 HIT</b>";
    case "QUANT_TP2_HIT":
      return "🟢 <b>UNIVERSAL QUANT — TP2 HIT</b>";
    case "QUANT_TP3_HIT":
      return "🟢 <b>UNIVERSAL QUANT — TP3 HIT</b>";
    case "QUANT_TP4_HIT":
      return "🟢 <b>UNIVERSAL QUANT — TP4 HIT</b>";
    case "QUANT_PARTIAL_PROFIT_BOOKED":
      return "🟢 <b>UNIVERSAL QUANT — PARTIAL PROFIT BOOKED</b>";
    case "QUANT_PAPER_EXIT":
      return "✅ <b>UNIVERSAL QUANT — PAPER EXIT</b>";
    case "QUANT_RISK_BLOCK":
      return "🛑 <b>UNIVERSAL QUANT — RISK BLOCK</b>";
    case "QUANT_DATA_FAILURE":
      return "⚠️ <b>UNIVERSAL QUANT — DATA FAILURE</b>";
    case "QUANT_DATA_WARNING":
      return "⚠️ <b>UNIVERSAL QUANT — DATA WARNING</b>";
    case "QUANT_DAILY_SUMMARY":
      return "📋 <b>UNIVERSAL QUANT — DAILY SUMMARY</b>";
    case "QUANT_ENGINE_ERROR":
      return "❌ <b>UNIVERSAL QUANT — ENGINE ERROR</b>";
    default:
      return `🔔 <b>UNIVERSAL QUANT — ${esc(type)}</b>`;
  }
}

function footerFor(type: QuantAlertType, p: QuantAlertPayload): string | null {
  switch (type) {
    case "QUANT_TRADE_CANDIDATE":
      return "PAPER / SHADOW — NO LIVE ORDER";
    case "QUANT_SL_HIT":
    case "QUANT_TRAILING_SL_HIT":
    case "QUANT_BREAKEVEN_SL_HIT":
    case "QUANT_GAP_THROUGH_SL":
    case "QUANT_PAPER_EXIT": {
      const rem = p.remainingQuantity;
      return rem != null && rem > 0 ? "PARTIAL EXIT — PAPER TRADE" : "PAPER TRADE CLOSED — NO LIVE ORDER";
    }
    default:
      return "PAPER TRADE — NO LIVE ORDER";
  }
}

// ── shared line builders ─────────────────────────────────────────────

function marketPart(p: QuantAlertPayload): string {
  return `${na(p.symbol)} (${na(p.exchange)})`;
}

function contractLine(p: QuantAlertPayload): string {
  const hasSym = p.tradingsymbol != null && String(p.tradingsymbol).trim() !== "";
  const bits: string[] = [];
  const strike = fmtNum(p.strike);
  if (strike !== null) bits.push(`strike ${strike}`);
  if (p.optionType != null && String(p.optionType).trim() !== "") bits.push(esc(String(p.optionType)));
  if (p.expiry != null && String(p.expiry).trim() !== "") bits.push(`expiry ${esc(String(p.expiry))}`);
  if (!hasSym && bits.length === 0) return "";
  return `Contract: ${hasSym ? esc(String(p.tradingsymbol)) : "N/A"}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

function commonTradeLines(p: QuantAlertPayload): string[] {
  const lines = [
    "Engine: UNIVERSAL_QUANT_V1",
    `Mode: ${na(p.mode)}`,
    `Market: ${marketPart(p)}`,
    `Underlying: ${na(p.underlying ?? p.symbol)}`,
    `Strategy: ${na(p.strategy)}`,
    `Direction: ${na(p.direction)}`,
  ];
  const c = contractLine(p);
  if (c) lines.push(c);
  return lines;
}

function targetForLevel(p: QuantAlertPayload, level: string): number | null | undefined {
  const t = p.targets ?? {};
  const map: Record<string, number | null | undefined> = { TP1: t.tp1, TP2: t.tp2, TP3: t.tp3, TP4: t.tp4 };
  return map[level];
}

function nextTargetLine(p: QuantAlertPayload, level: string): string {
  if (p.nextTarget !== null && p.nextTarget !== undefined) return `Next Target: ${na(p.nextTarget)}`;
  const t = p.targets ?? {};
  const seq: Record<string, [string, number | null | undefined][]> = {
    TP1: [["TP2", t.tp2]],
    TP2: [["TP3", t.tp3]],
    TP3: [["TP4", t.tp4]],
    TP4: [],
  };
  const nxt = seq[level] ?? [];
  for (const [name, v] of nxt) {
    if (v !== null && v !== undefined) return `Next Target: ${name} — ₹${fmtNum(v) ?? "N/A"}`;
  }
  if (nxt.length) return `Next Target: ${nxt[0][0]} (not set)`;
  return "Next Target: final target reached";
}

function lotsLine(p: QuantAlertPayload): string {
  const bits: string[] = [];
  const lots = fmtNum(p.lots);
  const qty = fmtNum(p.quantity);
  const ls = fmtNum(p.lotSize);
  if (lots !== null) bits.push(`lots ${lots}`);
  if (qty !== null) bits.push(`quantity ${qty}`);
  if (ls !== null) bits.push(`lot size ${ls}`);
  return bits.length ? `Lots: ${bits.join(", ")}` : "Lots: N/A";
}

function targetsLines(p: QuantAlertPayload): string[] {
  const t = p.targets ?? {};
  const out: string[] = [];
  const pairs: [string, number | null | undefined][] = [
    ["TP1", t.tp1],
    ["TP2", t.tp2],
    ["TP3", t.tp3],
    ["TP4", t.tp4],
  ];
  for (const [name, v] of pairs) {
    if (v !== null && v !== undefined) out.push(`Target ${name}: ₹${fmtNum(v) ?? "N/A"}`);
  }
  return out.length ? out : ["Targets: N/A"];
}

function rrLine(p: QuantAlertPayload): string {
  const rr = fmtNum(p.rewardRisk);
  return rr !== null ? `R:R: 1:${rr}` : "R:R: N/A";
}

function reasonsLines(p: QuantAlertPayload, max: number): string[] {
  const reasons = Array.isArray(p.reasons) ? p.reasons.slice(0, max) : [];
  if (!reasons.length) return ["Reasons: N/A"];
  const out = ["Reasons:"];
  reasons.forEach((r, i) => out.push(`${i + 1}. ${na(r)}`));
  return out;
}

// ── per-type bodies ──────────────────────────────────────────────────

function tpHitLines(type: QuantAlertType, p: QuantAlertPayload): string[] {
  const level = p.tpLevel ?? TP_LEVEL_BY_TYPE[type] ?? "TP";
  const targetPrice = p.targetPrice ?? targetForLevel(p, level);
  return [
    ...commonTradeLines(p),
    `Entry: ${money(p.entry)}`,
    `Target: ${esc(level)} — ${money(targetPrice)}`,
    `Simulated Fill: ${money(p.fillPrice ?? p.exitPrice)}`,
    `Quantity Exited: ${intOrNa(p.quantityExited)}`,
    `Remaining Quantity: ${intOrNa(p.remainingQuantity)}`,
    `Booked P&L: ${money(p.realizedPnl)}`,
    `Current SL: ${money(p.currentStopLoss ?? p.stopLoss)}`,
    nextTargetLine(p, level),
    `Event Time (IST): ${istStamp(p.eventTime)}`,
    `Data Source: ${na(p.dataSource)}`,
    `Data Health: ${na(p.dataHealth)}`,
    `Trade ID: ${na(p.tradeId)}`,
    `Event ID: ${na(p.eventId)}`,
  ];
}

function stopLines(type: QuantAlertType, p: QuantAlertPayload): string[] {
  const reason = p.exitReason ?? EXIT_REASON_BY_TYPE[type] ?? null;
  return [
    ...commonTradeLines(p),
    `Entry: ${money(p.entry)}`,
    `Configured SL: ${money(p.stopLoss)}`,
    `Exit Reason: ${na(reason)}`,
    `Simulated Exit: ${money(p.exitPrice ?? p.fillPrice)}`,
    `Quantity Exited: ${intOrNa(p.quantityExited)}`,
    `Remaining Quantity: ${intOrNa(p.remainingQuantity)}`,
    `Realized P&L: ${money(p.realizedPnl)}`,
    `Current SL: ${money(p.currentStopLoss ?? p.stopLoss)}`,
    `Event Time (IST): ${istStamp(p.eventTime)}`,
    `Data Source: ${na(p.dataSource)}`,
    `Data Health: ${na(p.dataHealth)}`,
    `Trade ID: ${na(p.tradeId)}`,
    `Event ID: ${na(p.eventId)}`,
  ];
}

function partialProfitLines(p: QuantAlertPayload): string[] {
  const level = p.tpLevel ?? null;
  const target = p.targetPrice ?? (level ? targetForLevel(p, level) : null);
  return [
    ...commonTradeLines(p),
    `Entry: ${money(p.entry)}`,
    level ? `Target: ${esc(level)} — ${money(target)}` : `Target: ${money(target)}`,
    `Simulated Fill: ${money(p.fillPrice ?? p.exitPrice)}`,
    `Quantity Exited: ${intOrNa(p.quantityExited)}`,
    `Remaining Quantity: ${intOrNa(p.remainingQuantity)}`,
    `Booked P&L: ${money(p.realizedPnl)}`,
    `Current SL: ${money(p.currentStopLoss ?? p.stopLoss)}`,
    nextTargetLine(p, level ?? ""),
    `Event Time (IST): ${istStamp(p.eventTime)}`,
    `Trade ID: ${na(p.tradeId)}`,
    `Event ID: ${na(p.eventId)}`,
  ];
}

function entryLines(p: QuantAlertPayload): string[] {
  return [
    ...commonTradeLines(p),
    `Regime: ${na(p.regime)}`,
    `Simulated Fill: ${money(p.fillPrice ?? p.entry)}`,
    `Quantity: ${intOrNa(p.quantity)}`,
    lotsLine(p),
    `Stop Loss: ${money(p.stopLoss)}`,
    ...targetsLines(p),
    `Event Time (IST): ${istStamp(p.eventTime)}`,
    `Data Source: ${na(p.dataSource)}`,
    `Data Health: ${na(p.dataHealth)}`,
    `Trade ID: ${na(p.tradeId)}`,
    `Event ID: ${na(p.eventId)}`,
  ];
}

function candidateLines(p: QuantAlertPayload): string[] {
  return [
    ...commonTradeLines(p),
    `Regime: ${na(p.regime)}`,
    `Planned Entry: ${money(p.entry)}`,
    `Stop Loss: ${money(p.stopLoss)}`,
    ...targetsLines(p),
    lotsLine(p),
    `Est Risk: ${money(p.riskAmount)}`,
    rrLine(p),
    `Est Costs: ${money(p.estCosts)}`,
    `Event Time (IST): ${istStamp(p.eventTime)}`,
    `Trade ID: ${na(p.tradeId)}`,
    `Decision ID: ${na(p.decisionId)}`,
  ];
}

function noTradeLines(p: QuantAlertPayload): string[] {
  return [
    "Engine: UNIVERSAL_QUANT_V1",
    `Mode: ${na(p.mode)}`,
    `Market: ${marketPart(p)}`,
    `Regime: ${na(p.regime)}`,
    ...reasonsLines(p, 3),
    `Event Time (IST): ${istStamp(p.eventTime)}`,
    `Decision ID: ${na(p.decisionId)}`,
  ];
}

function riskBlockLines(p: QuantAlertPayload): string[] {
  return [
    ...commonTradeLines(p),
    ...reasonsLines(p, 10),
    `Event Time (IST): ${istStamp(p.eventTime)}`,
    `Trade ID: ${na(p.tradeId)}`,
  ];
}

function dataFailureLines(p: QuantAlertPayload): string[] {
  return [
    "Engine: UNIVERSAL_QUANT_V1",
    `Source: ${na(p.source)}`,
    `Detail: ${na(p.detail)}`,
    `Market: ${marketPart(p)}`,
    `Event Time (IST): ${istStamp(p.eventTime)}`,
  ];
}

function dataWarningLines(p: QuantAlertPayload): string[] {
  return [
    "Engine: UNIVERSAL_QUANT_V1",
    `Mode: ${na(p.mode)}`,
    `Market: ${marketPart(p)}`,
    `Underlying: ${na(p.underlying ?? p.symbol)}`,
    `Detail: ${na(p.detail ?? p.notes ?? p.message)}`,
    `Event Time (IST): ${istStamp(p.eventTime)}`,
    `Trade ID: ${na(p.tradeId)}`,
  ];
}

function paperExitLines(p: QuantAlertPayload): string[] {
  return [
    ...commonTradeLines(p),
    `Exit Reason: ${na(p.exitReason)}`,
    `Simulated Exit: ${money(p.exitPrice ?? p.fillPrice)}`,
    `Quantity Exited: ${intOrNa(p.quantityExited)}`,
    `Remaining Quantity: ${intOrNa(p.remainingQuantity)}`,
    `Realized P&L: ${money(p.realizedPnl)}`,
    `Event Time (IST): ${istStamp(p.eventTime)}`,
    `Trade ID: ${na(p.tradeId)}`,
    `Event ID: ${na(p.eventId)}`,
  ];
}

function dailySummaryLines(p: QuantAlertPayload): string[] {
  const wr = fmtNum(p.winRate);
  return [
    "Engine: UNIVERSAL_QUANT_V1",
    `Mode: ${na(p.mode)}`,
    `Trades: ${intOrNa(p.trades)}`,
    `Wins: ${intOrNa(p.wins)}`,
    `Losses: ${intOrNa(p.losses)}`,
    wr !== null ? `Win Rate: ${wr}%` : "Win Rate: N/A",
    `Realized P&L: ${money(p.pnl)}`,
    `Event Time (IST): ${istStamp(p.eventTime)}`,
  ];
}

function engineErrorLines(p: QuantAlertPayload): string[] {
  return [
    "Engine: UNIVERSAL_QUANT_V1",
    `Message: ${na(p.message)}`,
    `Event Time (IST): ${istStamp(p.eventTime)}`,
    `Trade ID: ${na(p.tradeId)}`,
  ];
}

function startupLines(p: QuantAlertPayload): string[] {
  const symbols = Array.isArray(p.symbols) && p.symbols.length ? p.symbols.map((s) => esc(String(s))).join(", ") : "N/A";
  return [
    "Engine: UNIVERSAL_QUANT_V1",
    `Mode: ${na(p.mode)}`,
    `Symbols: ${symbols}`,
    `Event Time (IST): ${istStamp(p.eventTime)}`,
  ];
}

function fallbackLines(type: QuantAlertType, p: QuantAlertPayload): string[] {
  return [
    "Engine: UNIVERSAL_QUANT_V1",
    `Mode: ${na(p.mode)}`,
    `Trade ID: ${na(p.tradeId)}`,
    `Event ID: ${na(p.eventId)}`,
    `Detail: ${na(p.notes ?? p.message ?? p.detail)}`,
    `Event Time (IST): ${istStamp(p.eventTime)}`,
  ];
}

// ── entry point ──────────────────────────────────────────────────────

/**
 * Renders a quant alert as HTML-safe Telegram text. Never throws for any
 * QuantAlertType × payload combination; unknown types render a generic block.
 */
export function formatQuantAlert(type: QuantAlertType, payload: QuantAlertPayload): string {
  const p: QuantAlertPayload = payload ?? {};
  let lines: string[];
  switch (type) {
    case "QUANT_TP1_HIT":
    case "QUANT_TP2_HIT":
    case "QUANT_TP3_HIT":
    case "QUANT_TP4_HIT":
      lines = tpHitLines(type, p);
      break;
    case "QUANT_SL_HIT":
    case "QUANT_TRAILING_SL_HIT":
    case "QUANT_BREAKEVEN_SL_HIT":
    case "QUANT_GAP_THROUGH_SL":
      lines = stopLines(type, p);
      break;
    case "QUANT_PARTIAL_PROFIT_BOOKED":
      lines = partialProfitLines(p);
      break;
    case "QUANT_PAPER_ENTRY":
      lines = entryLines(p);
      break;
    case "QUANT_TRADE_CANDIDATE":
      lines = candidateLines(p);
      break;
    case "QUANT_NO_TRADE":
      lines = noTradeLines(p);
      break;
    case "QUANT_RISK_BLOCK":
      lines = riskBlockLines(p);
      break;
    case "QUANT_DATA_FAILURE":
      lines = dataFailureLines(p);
      break;
    case "QUANT_DATA_WARNING":
      lines = dataWarningLines(p);
      break;
    case "QUANT_PAPER_EXIT":
      lines = paperExitLines(p);
      break;
    case "QUANT_DAILY_SUMMARY":
      lines = dailySummaryLines(p);
      break;
    case "QUANT_ENGINE_ERROR":
      lines = engineErrorLines(p);
      break;
    case "QUANT_STARTUP":
      lines = startupLines(p);
      break;
    default:
      lines = fallbackLines(type, p);
  }
  const foot = footerFor(type, p);
  if (foot) lines.push(foot);
  return [titleFor(type), ...lines].filter((l) => l && l.trim() !== "").join("\n");
}
