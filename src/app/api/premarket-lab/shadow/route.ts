// GET /api/premarket-lab/shadow — Phase 11 quantitative shadow validation.
// Research-only. ?record=1 records a shadow session (no Telegram, no trades).

import { NextRequest, NextResponse } from "next/server";
import {
  listShadowSessions, getShadowSession, shadowCoverageStats, listOptionSims,
} from "@/lib/premarket-lab/storage";
import {
  recordShadowSession, trySdmShadowSnapshot,
} from "@/lib/premarket-lab/shadow-recorder";
import { compareShadow, type CompareTarget } from "@/lib/premarket-lab/shadow-compare";
import { summarizeOptionSims } from "@/lib/premarket-lab/option-sim";
import { istDateISO, isTradingDay } from "@/lib/premarket-lab/calendar";
import { loadBhavcopyForTrade, selectPremiumCandles } from "@/lib/option-bhavcopy";
import { pickAtmStrike } from "@/lib/premarket-lab/option-sim";
import { buildFeatureDataset } from "@/lib/premarket-lab/dataset";

export const dynamic = "force-dynamic";

const DISCLAIMER =
  "Shadow validation only. Not trade authorization. Not expected returns. " +
  "Production SDM/veto/risk/position sizing unchanged. BUY CE/PE only under existing gates.";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "list";
    const symbol = url.searchParams.get("symbol") || undefined;
    const from = url.searchParams.get("from") || undefined;
    const to = url.searchParams.get("to") || undefined;
    const date = url.searchParams.get("date") || istDateISO();

    if (action === "list") {
      const sessions = listShadowSessions({ symbol, from, to, limit: 200 });
      const coverage = shadowCoverageStats();
      const sims = listOptionSims({ symbol, from, to, limit: 200 });
      return NextResponse.json({
        success: true,
        coverage,
        sessions,
        optionSims: sims,
        optionSummary: summarizeOptionSims(sims),
        disclaimer: DISCLAIMER,
      });
    }

    if (action === "report") {
      const { buildDailyReport } = await import("@/lib/premarket-lab/daily-report");
      const report = buildDailyReport({ tradeDate: date, includeOos: true });
      return NextResponse.json({ success: true, report, disclaimer: DISCLAIMER });
    }

    if (action === "attach") {
      const { attachOutcomesForSession, fetchCandlesForOutcome } = await import(
        "@/lib/premarket-lab/outcome-attach"
      );
      const eod = url.searchParams.get("eod") === "1";
      const day = url.searchParams.get("date") || date;
      const pending = listShadowSessions({ from: day, to: day, limit: 200 })
        .filter((s) => (s.outcomeStatus || "PENDING_OUTCOME") === "PENDING_OUTCOME");
      const results: Awaited<ReturnType<typeof attachOutcomesForSession>>[] = [];
      for (const s of pending) {
        const candles = await fetchCandlesForOutcome(s.symbol, day, 5);
        results.push(
          attachOutcomesForSession({
            tradeDate: day,
            symbol: s.symbol,
            candles: candles ?? undefined,
            forceUnavailable: eod && !candles?.length,
          }),
        );
      }
      return NextResponse.json({ success: true, results, disclaimer: DISCLAIMER });
    }

    if (action === "get") {
      const d = url.searchParams.get("date") || date;
      const sym = url.searchParams.get("symbol") || "NIFTY";
      const s = getShadowSession(d, sym);
      return NextResponse.json({
        success: true,
        session: s,
        disclaimer: DISCLAIMER,
      });
    }

    if (action === "compare") {
      const target = (url.searchParams.get("target") || "gap_continuation") as CompareTarget;
      const model = (url.searchParams.get("model") || "logistic") as any;
      const result = compareShadow({ target, model, from, to, symbol });
      return NextResponse.json({ success: true, ...result });
    }

    if (action === "record") {
      if (!isTradingDay(date) && url.searchParams.get("force") !== "1") {
        return NextResponse.json({
          success: false,
          error: "not_trading_day",
          disclaimer: DISCLAIMER,
        }, { status: 400 });
      }
      const sym = url.searchParams.get("symbol") || "NIFTY";
      const wantSdm = url.searchParams.get("sdm") === "1";
      const wantOptions = url.searchParams.get("options") === "1";
      const wantResearch = url.searchParams.get("research") !== "0";

      // Prior labeled samples for model fit (chronological — features only, labels from history)
      let trainSamples: any[] = [];
      try {
        const ds = buildFeatureDataset({ requireOpen: true, persist: false });
        trainSamples = ds.samples.filter((s) => s.tradeDate < date);
      } catch {
        trainSamples = [];
      }

      let sdm: import("@/lib/premarket-lab/types").SdmShadowSnapshot | null = null;
      if (wantSdm) {
        sdm = await trySdmShadowSnapshot(sym);
      }

      let optionSim: any = undefined;
      if (wantOptions) {
        let premiumCandle: import("@/lib/option-bhavcopy").PremiumCandle | null = null;
        try {
          const rows = await loadBhavcopyForTrade(date, sym);
          const { getStudyDay } = await import("@/lib/premarket-lab/storage");
          const day = getStudyDay(date, sym);
          const spot = day?.futures?.finalPrice ?? day?.cm?.finalPrice ?? day?.cm?.iep ?? null;
          if (rows.length && spot != null) {
            const side = url.searchParams.get("side") === "PE" ? "PE" : "CE";
            premiumCandle = pickAtmStrike(rows, spot, side);
          }
        } catch {
          premiumCandle = null;
        }
        optionSim = {
          attempt: true,
          premiumCandle,
          side: url.searchParams.get("side") === "PE" ? "PE" : "CE",
        };
      }

      const session = await recordShadowSession({
        tradeDate: date,
        symbol: sym,
        trainSamples,
        sdm,
        optionSim,
        skipResearch: !wantResearch,
      });

      return NextResponse.json({ success: true, session, disclaimer: DISCLAIMER });
    }

    return NextResponse.json({ success: false, error: "unknown_action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || "failed", disclaimer: DISCLAIMER },
      { status: 500 },
    );
  }
}
