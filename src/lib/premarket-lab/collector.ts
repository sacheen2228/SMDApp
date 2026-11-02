// Daily collector: fetch CM+F&O pre-open → normalize → study day → storage.
// Fail-closed: never writes fabricated rows.
// Phase 12: trading-day gate, research-at-collect, capture audit (append-only).

import { fetchAllPreopen, cmProvenance, fnoProvenance } from "./fetchers";
import { selectNearestFutures, imbalanceQty } from "./normalize";
import { buildQualityReport } from "./quality";
import { istDateISO, parseNseDateToIso, isTradingDay } from "./calendar";
import {
  saveCmSnapshot, saveFnoSnapshot, saveStudyDay, getLabDb, appendCaptureAudit,
} from "./storage";
import { gapPct, computeImbalance, basis as basisFn, basisPct as basisPctFn } from "./analytics";
import type { PreopenStudyDay, QualityReport, SourceId, ResearchInputs } from "./types";

export interface CollectResult {
  ok: boolean;
  tradeDate: string;
  studySymbols: string[];
  cmRows: number;
  fnoRows: number;
  quality: QualityReport;
  /** Phase 12 — research snapshot collected at capture time (null if skipped/failed). */
  research?: ResearchInputs | null;
  error?: string;
}

const STUDY_SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];

export interface CollectOptions {
  /** Skip network research snapshot (tests / offline). */
  skipResearch?: boolean;
  /** Inject research for tests. */
  research?: ResearchInputs | null;
  now?: Date;
}

/**
 * Run one collection pass. Safe to call multiple times (INSERT OR IGNORE / upsert).
 * Non-trading day → fail-closed no-op (no fabricated rows).
 */
export async function collectPreopenSnapshot(
  tradeDate = istDateISO(),
  opts: CollectOptions = {},
): Promise<CollectResult> {
  if (!isTradingDay(tradeDate)) {
    return {
      ok: false,
      tradeDate,
      studySymbols: [],
      cmRows: 0,
      fnoRows: 0,
      quality: buildQualityReport({}),
      error: "not_trading_day",
    };
  }

  const { cm, fno, quality } = await fetchAllPreopen();
  const capturedAt = (opts.now ?? new Date()).toISOString();
  const cmProv = { ...cmProvenance(), fetchedAt: capturedAt };
  const fnoProv = { ...fnoProvenance(), fetchedAt: capturedAt };

  // Research-at-collect (Phase 12): asOf = actual capture time, never pre-open claim.
  let research: ResearchInputs | null = opts.research ?? null;
  if (!research && !opts.skipResearch) {
    try {
      const { collectResearchInputs } = await import("./research-inputs");
      research = await collectResearchInputs({
        symbol: "NIFTY", // shared market-level inputs; per-symbol options live on shadow sessions
        asOf: capturedAt,
        includeOptions: false, // options PCR is per-symbol at shadow-record time
      });
    } catch {
      research = null;
    }
  }

  if (!cm.ok && !fno.ok) {
    appendCaptureAudit({
      tradeDate,
      capturedAt,
      cmRows: 0,
      fnoRows: 0,
      qualityOverall: quality.overall,
      qualityScore: quality.score,
      researchAsOf: research?.asOf ?? null,
      notes: cm.error || fno.error || "both_sources_failed",
    });
    return {
      ok: false,
      tradeDate,
      studySymbols: [],
      cmRows: 0,
      fnoRows: 0,
      quality,
      research,
      error: cm.error || fno.error || "both_sources_failed",
    };
  }

  let cmRows = 0;
  let fnoRows = 0;
  if (cm.ok) {
    cmRows = saveCmSnapshot(
      tradeDate, capturedAt, cm.rows, cm.timestamp, cm.quality, cmProv,
    );
  }
  if (fno.ok) {
    fnoRows = saveFnoSnapshot(
      tradeDate, capturedAt, fno.rows, fno.timestamp, fno.quality, fnoProv,
    );
  }

  const studySymbols: string[] = [];
  for (const symbol of STUDY_SYMBOLS) {
    const day = buildStudyDay(tradeDate, symbol, cm.rows, fno.rows, quality, capturedAt);
    if (day) {
      // Attach research context (vix/fii/breadth) at collect — real fetch time only.
      if (research) {
        day.vix = research.vix?.value ?? null;
        day.fiiNet = research.fiiDii?.available ? research.fiiDii.fiiNet : null;
        day.diiNet = research.fiiDii?.available ? research.fiiDii.diiNet : null;
      }
      saveStudyDay(day);
      studySymbols.push(symbol);
    }
  }

  // Also persist top stock futures study rows for research (top 20 by turnover)
  if (fno.ok) {
    const stk = fno.rows
      .filter((r) => r.instrumentType === "FUTSTK")
      .sort((a, b) => (b.totalTurnover ?? 0) - (a.totalTurnover ?? 0))
      .slice(0, 20);
    for (const row of stk) {
      const day = buildStudyDayFromFutures(tradeDate, row.symbol, cm.rows, [row], quality, capturedAt);
      if (day) {
        if (research) {
          day.vix = research.vix?.value ?? null;
          day.fiiNet = research.fiiDii?.available ? research.fiiDii.fiiNet : null;
          day.diiNet = research.fiiDii?.available ? research.fiiDii.diiNet : null;
        }
        saveStudyDay(day);
        if (!studySymbols.includes(row.symbol)) studySymbols.push(row.symbol);
      }
    }
  }

  appendCaptureAudit({
    tradeDate,
    capturedAt,
    cmRows,
    fnoRows,
    qualityOverall: quality.overall,
    qualityScore: quality.score,
    researchAsOf: research?.asOf ?? null,
    notes: studySymbols.length ? `symbols:${studySymbols.length}` : "no_study_symbols",
  });

  return {
    ok: cmRows > 0 || fnoRows > 0,
    tradeDate,
    studySymbols,
    cmRows,
    fnoRows,
    quality,
    research,
  };
}

function buildStudyDay(
  tradeDate: string,
  symbol: string,
  cmRows: any[],
  fnoRows: any[],
  quality: QualityReport,
  capturedAt: string,
): PreopenStudyDay | null {
  const cm = cmRows.find((r) => r.symbol === symbol) || null;
  const fut = selectNearestFutures(fnoRows, symbol, tradeDate);
  if (!cm && !fut) return null;

  const cmPart = cm
    ? {
        previousClose: cm.previousClose,
        iep: cm.iep,
        finalPrice: cm.finalPrice,
        pChange: cm.pChange,
        finalQuantity: cm.finalQuantity,
        totalTurnover: cm.totalTurnover,
        imbalanceQty: imbalanceQty(cm.totalBuyQuantity, cm.totalSellQuantity),
        bestBid: cm.bestBid,
        bestAsk: cm.bestAsk,
      }
    : null;

  const futPart = fut
    ? (() => {
        const spot = cm?.iep ?? cm?.finalPrice;
        const fp = fut.iep ?? fut.finalPrice;
        return {
          instrumentType: fut.instrumentType,
          expiryDate: fut.expiryDate,
          previousClose: fut.previousClose,
          iep: fut.iep,
          finalPrice: fut.finalPrice,
          pChange: fut.pChange,
          finalQuantity: fut.finalQuantity,
          totalTurnover: fut.totalTurnover,
          imbalanceQty: imbalanceQty(fut.totalBuyQuantity, fut.totalSellQuantity),
          basis: basisFn(fp, spot),
          basisPct: basisPctFn(fp, spot),
        };
      })()
    : null;

  return {
    tradeDate,
    symbol,
    provenance: {
      source: "NSE_CM_PREOPEN",
      fetchedAt: capturedAt,
      schemaVersion: 1,
      url: "https://www.nseindia.com/api/market-data-pre-open?key=ALL",
    },
    quality,
    cm: cmPart,
    futures: futPart,
    open: null, // filled post-open by opening confirmation
    vix: null,
    fiiNet: null,
    diiNet: null,
  };
}

function buildStudyDayFromFutures(
  tradeDate: string,
  symbol: string,
  cmRows: any[],
  fnoRows: any[],
  quality: QualityReport,
  capturedAt: string,
): PreopenStudyDay | null {
  return buildStudyDay(tradeDate, symbol, cmRows, fnoRows, quality, capturedAt);
}

/** Merge opening print into study day (post 09:15). */
export function attachOpening(
  tradeDate: string,
  symbol: string,
  open: { spotOpen: number | null; futuresOpen: number | null; dayHigh: number | null; dayLow: number | null; dayClose: number | null; volume: number | null },
): boolean {
  const db = getLabDb();
  const row = db.prepare("SELECT payload FROM preopen_study_days WHERE trade_date=? AND symbol=?").get(tradeDate, symbol) as any;
  if (!row) return false;
  let day: PreopenStudyDay;
  try {
    day = JSON.parse(row.payload);
  } catch {
    return false;
  }
  day.open = open;
  saveStudyDay(day);
  return true;
}

export function attachMarketContext(
  tradeDate: string,
  symbol: string,
  ctx: { vix?: number | null; fiiNet?: number | null; diiNet?: number | null },
): boolean {
  const db = getLabDb();
  const row = db.prepare("SELECT payload FROM preopen_study_days WHERE trade_date=? AND symbol=?").get(tradeDate, symbol) as any;
  if (!row) return false;
  let day: PreopenStudyDay;
  try {
    day = JSON.parse(row.payload);
  } catch {
    return false;
  }
  if (ctx.vix != null) day.vix = ctx.vix;
  if (ctx.fiiNet != null) day.fiiNet = ctx.fiiNet;
  if (ctx.diiNet != null) day.diiNet = ctx.diiNet;
  saveStudyDay(day);
  return true;
}

export { gapPct, computeImbalance, parseNseDateToIso };
export type { SourceId };
