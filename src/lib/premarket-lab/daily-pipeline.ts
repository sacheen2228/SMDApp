// Phase 12 — daily research pipeline orchestration.
// Stages: collect → record shadows → attach outcomes (partial/EOD) → option sim → report.
// Trading-day gated, in-process lock (idempotent), research-only (no Telegram/trades).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { istDateISO, istMinutes, isTradingDay } from "./calendar";
import { collectPreopenSnapshot, type CollectResult } from "./collector";
import {
  listStudyDays, getStudyDay, listPendingOutcomes,
  getShadowSession, saveOptionSim,
} from "./storage";
import { recordShadowSession, trySdmShadowSnapshot, type ShadowRecordInput } from "./shadow-recorder";
import {
  attachOutcomesForSession, fetchCandlesForOutcome,
  type AttachOutcomeResult,
} from "./outcome-attach";
import { buildDailyReport, formatDailyReport, type DailyLabReport } from "./daily-report";
import { simulateBuyOption, pickAtmStrike } from "./option-sim";
import { loadBhavcopyForTrade } from "@/lib/option-bhavcopy";
import type { ShadowSession } from "./types";
import type { CandleBar } from "./outcomes";
import type { SdmShadowSnapshot } from "./types";

export type PipelineStage =
  | "collect"
  | "record"
  | "attach_partial"
  | "attach_eod"
  | "option_sim"
  | "report";

export interface PipelineResult {
  ok: boolean;
  stage: PipelineStage;
  tradeDate: string;
  skipped?: string;
  message: string;
  data?: any;
}

const LOCK_DIR = path.join(os.tmpdir(), "premarket-lab-locks");

function lockPath(stage: PipelineStage, tradeDate: string): string {
  return path.join(LOCK_DIR, `${stage}-${tradeDate}.lock`);
}

/** In-process + file lock. Returns null if another run holds the lock. */
export async function withLabLock<T>(
  stage: PipelineStage,
  tradeDate: string,
  fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false; reason: "locked" | "not_trading_day" }> {
  if (!isTradingDay(tradeDate)) {
    return { ran: false, reason: "not_trading_day" };
  }
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  const lp = lockPath(stage, tradeDate);
  let fd: number | null = null;
  try {
    fd = fs.openSync(lp, "wx");
    fs.writeSync(fd, String(process.pid));
  } catch {
    // Stale lock older than 10 minutes → take over
    try {
      const st = fs.statSync(lp);
      if (Date.now() - st.mtimeMs > 10 * 60_000) {
        fs.unlinkSync(lp);
        fd = fs.openSync(lp, "wx");
        fs.writeSync(fd, String(process.pid));
      } else {
        return { ran: false, reason: "locked" };
      }
    } catch {
      return { ran: false, reason: "locked" };
    }
  }
  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    try {
      if (fd != null) fs.closeSync(fd);
      fs.unlinkSync(lp);
    } catch {
      /* ignore */
    }
  }
}

// ─── Stage: collect ───────────────────────────────────────────────────

export async function runCollectStage(opts: {
  tradeDate?: string;
  skipResearch?: boolean;
} = {}): Promise<PipelineResult> {
  const tradeDate = opts.tradeDate || istDateISO();
  const locked = await withLabLock("collect", tradeDate, async () => {
    return collectPreopenSnapshot(tradeDate, { skipResearch: opts.skipResearch });
  });
  if (!locked.ran) {
    return {
      ok: false, stage: "collect", tradeDate,
      skipped: locked.reason,
      message: locked.reason === "not_trading_day" ? "not_trading_day" : "locked",
    };
  }
  const r: CollectResult = locked.result;
  return {
    ok: r.ok, stage: "collect", tradeDate,
    message: r.ok
      ? `cm=${r.cmRows} fno=${r.fnoRows} symbols=${r.studySymbols.length} quality=${r.quality.overall}`
      : `failed:${r.error}`,
    data: { cmRows: r.cmRows, fnoRows: r.fnoRows, studySymbols: r.studySymbols, quality: r.quality },
  };
}

// ─── Stage: record shadows ────────────────────────────────────────────

export interface RecordStageOptions {
  tradeDate?: string;
  symbols?: string[];
  sdm?: boolean;
  options?: boolean;
  skipResearch?: boolean;
}

export async function runRecordStage(opts: RecordStageOptions = {}): Promise<PipelineResult> {
  const tradeDate = opts.tradeDate || istDateISO();
  const locked = await withLabLock("record", tradeDate, async () => {
    const days = listStudyDays({ from: tradeDate, to: tradeDate, limit: 200 });
    const symbols = opts.symbols?.length
      ? opts.symbols
      : [...new Set(days.map((d) => d.symbol))].filter(Boolean);

    if (!symbols.length) {
      return { sessions: 0, message: "no_study_days" };
    }

    // Prior labeled samples for model fit (chronological — prior only)
    let trainSamples: any[] = [];
    try {
      const { buildFeatureDataset } = await import("./dataset");
      const ds = buildFeatureDataset({ requireOpen: true, persist: false });
      trainSamples = ds.samples.filter((s: any) => s.tradeDate < tradeDate);
    } catch {
      trainSamples = [];
    }

    const recorded: ShadowSession[] = [];
    for (const symbol of symbols) {
      const day = getStudyDay(tradeDate, symbol);
      if (!day) continue;
      // Skip if already recorded with outcomes (idempotent re-record still ok — upsert)
      const existing = getShadowSession(tradeDate, symbol);

      let sdm: SdmShadowSnapshot | null = null;
      if (opts.sdm) {
        try {
          sdm = await trySdmShadowSnapshot(symbol);
        } catch {
          sdm = null;
        }
      }

      let optionSim: ShadowRecordInput["optionSim"] | undefined;
      if (opts.options !== false) {
        let premiumCandle: import("@/lib/option-bhavcopy").PremiumCandle | null = null;
        try {
          const rows = await loadBhavcopyForTrade(tradeDate, symbol);
          const spot =
            day.futures?.finalPrice ?? day.cm?.finalPrice ?? day.cm?.iep ?? null;
          if (rows.length && spot != null) {
            const side = day.cm && day.cm.iep && day.cm.finalPrice != null && day.cm.finalPrice < day.cm.iep
              ? "PE" : "CE";
            premiumCandle = pickAtmStrike(rows, spot, side);
            optionSim = { attempt: true, premiumCandle, side };
          } else {
            optionSim = { attempt: true, premiumCandle: null, side: "CE" };
          }
        } catch {
          optionSim = { attempt: true, premiumCandle: null, side: "CE" };
        }
      }

      // Two-phase: no candles at record time → PENDING_OUTCOME
      const input: ShadowRecordInput = {
        tradeDate,
        symbol,
        trainSamples,
        sdm,
        optionSim,
        skipResearch: opts.skipResearch ?? false,
      };
      try {
        const session = await recordShadowSession(input);
        recorded.push(session);
      } catch (e: any) {
        if (existing) continue;
        // no study day edge already skipped
      }
    }
    return { sessions: recorded.length, symbols: recorded.map((s) => s.symbol), message: "ok" };
  });

  if (!locked.ran) {
    return {
      ok: false, stage: "record", tradeDate,
      skipped: locked.reason,
      message: locked.reason,
    };
  }
  return {
    ok: true, stage: "record", tradeDate,
    message: `recorded=${locked.result.sessions}`,
    data: locked.result,
  };
}

// ─── Stage: attach outcomes ───────────────────────────────────────────

export interface AttachStageOptions {
  tradeDate?: string;
  /** Interval for outcome candles (default 5m). */
  candleIntervalMin?: number;
  /** Mark UNAVAILABLE when past deadline with no prints (EOD stage). */
  eod?: boolean;
  maxAttempts?: number;
}

export async function runAttachStage(opts: AttachStageOptions = {}): Promise<PipelineResult> {
  const tradeDate = opts.tradeDate || istDateISO();
  const stage: PipelineStage = opts.eod ? "attach_eod" : "attach_partial";
  const locked = await withLabLock(stage, tradeDate, async () => {
    const pending = listPendingOutcomes({ limit: 500 }).filter((s) => s.tradeDate === tradeDate);
    const results: AttachOutcomeResult[] = [];
    for (const s of pending) {
      let candles: CandleBar[] | null = null;
      try {
        candles = await fetchCandlesForOutcome(s.symbol, tradeDate, opts.candleIntervalMin ?? 5);
      } catch {
        candles = null;
      }
      const forceUnavailable =
        !!opts.eod && istMinutes() >= 15 * 60 + 45 && !candles?.length;
      results.push(
        attachOutcomesForSession({
          tradeDate,
          symbol: s.symbol,
          candles: candles ?? undefined,
          candleIntervalMin: opts.candleIntervalMin ?? 5,
          forceUnavailable,
          maxAttempts: opts.maxAttempts,
        }),
      );
    }
    const recorded = results.filter((r) => r.status === "OUTCOME_RECORDED").length;
    const unavailable = results.filter((r) => r.status === "OUTCOME_UNAVAILABLE").length;
    const stillPending = results.filter((r) => r.status === "PENDING_OUTCOME").length;
    return {
      pending: pending.length, recorded, unavailable, stillPending,
      results: results.slice(0, 50),
      message: `pending=${pending.length} recorded=${recorded} unavailable=${unavailable} stillPending=${stillPending}`,
    };
  });

  if (!locked.ran) {
    return { ok: false, stage, tradeDate, skipped: locked.reason, message: locked.reason };
  }
  return {
    ok: true, stage, tradeDate,
    message: locked.result.message,
    data: locked.result,
  };
}

// ─── Stage: option sim (bhavcopy warm) ────────────────────────────────

export async function runOptionSimStage(opts: {
  tradeDate?: string;
  symbols?: string[];
} = {}): Promise<PipelineResult> {
  const tradeDate = opts.tradeDate || istDateISO();
  const locked = await withLabLock("option_sim", tradeDate, async () => {
    const days = listStudyDays({ from: tradeDate, to: tradeDate, limit: 200 });
    const symbols = opts.symbols?.length
      ? opts.symbols
      : [...new Set(days.map((d) => d.symbol))].filter(Boolean);

    let saved = 0;
    let notValidated = 0;
    for (const symbol of symbols) {
      const day = getStudyDay(tradeDate, symbol);
      if (!day) continue;
      const spot = day.futures?.finalPrice ?? day.cm?.finalPrice ?? day.cm?.iep ?? null;
      let rows: import("@/lib/option-bhavcopy").PremiumCandle[] = [];
      try {
        rows = await loadBhavcopyForTrade(tradeDate, symbol);
      } catch {
        rows = [];
      }
      const side: "CE" | "PE" =
        day.cm && day.cm.pChange != null && day.cm.pChange < 0 ? "PE" : "CE";
      const candle = rows.length && spot != null ? pickAtmStrike(rows, spot, side) : null;
      const sim = simulateBuyOption(tradeDate, symbol, side, candle, {
        lotSize: candle?.lotSize ?? null,
      });
      saveOptionSim(sim);
      saved++;
      if (!sim.validated) notValidated++;
    }
    return { saved, notValidated, symbols: symbols.length, message: `saved=${saved} notValidated=${notValidated}` };
  });

  if (!locked.ran) {
    return { ok: false, stage: "option_sim", tradeDate, skipped: locked.reason, message: locked.reason };
  }
  return { ok: true, stage: "option_sim", tradeDate, message: locked.result.message, data: locked.result };
}

// ─── Stage: daily report ──────────────────────────────────────────────

export async function runReportStage(opts: {
  tradeDate?: string;
  writeLog?: boolean;
} = {}): Promise<PipelineResult> {
  const tradeDate = opts.tradeDate || istDateISO();
  const locked = await withLabLock("report", tradeDate, async () => {
    const report: DailyLabReport = buildDailyReport({ tradeDate, includeOos: true });
    const text = formatDailyReport(report);
    if (opts.writeLog !== false) {
      try {
        const dir = path.join(process.cwd(), "logs");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `premarket-lab-${tradeDate}.log`);
        fs.writeFileSync(file, text + "\n", "utf8");
        return { report, text, file, message: `wrote ${file}` };
      } catch (e: any) {
        return { report, text, file: null, message: `report_ok_log_failed:${e?.message}` };
      }
    }
    return { report, text, file: null, message: "ok" };
  });

  if (!locked.ran) {
    return { ok: false, stage: "report", tradeDate, skipped: locked.reason, message: locked.reason };
  }
  return {
    ok: true, stage: "report", tradeDate,
    message: locked.result.message,
    data: {
      sessions: locked.result.report.sessions,
      labeled: locked.result.report.labeled,
      byStatus: locked.result.report.byStatus,
      text: locked.result.text,
      file: locked.result.file,
    },
  };
}

// ─── Convenience: full day sequence (for CLI) ─────────────────────────

export async function runFullPipeline(opts: {
  tradeDate?: string;
  skipResearch?: boolean;
  stages?: PipelineStage[];
} = {}): Promise<PipelineResult[]> {
  const tradeDate = opts.tradeDate || istDateISO();
  const stages: PipelineStage[] =
    opts.stages || ["collect", "record", "attach_partial", "attach_eod", "option_sim", "report"];
  const out: PipelineResult[] = [];
  for (const stage of stages) {
    if (stage === "collect") out.push(await runCollectStage({ tradeDate, skipResearch: opts.skipResearch }));
    else if (stage === "record") out.push(await runRecordStage({ tradeDate, skipResearch: opts.skipResearch }));
    else if (stage === "attach_partial") out.push(await runAttachStage({ tradeDate, eod: false }));
    else if (stage === "attach_eod") out.push(await runAttachStage({ tradeDate, eod: true }));
    else if (stage === "option_sim") out.push(await runOptionSimStage({ tradeDate }));
    else if (stage === "report") out.push(await runReportStage({ tradeDate }));
  }
  return out;
}
