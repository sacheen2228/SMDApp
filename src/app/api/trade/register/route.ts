// POST /api/trade/register
//
// Unified trade-registration endpoint. Client-side strategy scanners (SMC /
// Smart Money, Zero Hero AI) post candidate trades here so they flow through
// the SAME lifecycle as server-side strategies: in-memory active tracking +
// Prisma journal + Trade Audit (backtest verification) engine. This guarantees
// every exit is synced everywhere (dashboard, audit, Prisma, Telegram, Agent).
//
// The tradeId is deterministic (STRAT-SYMBOL-STRIKE-TYPE-YYYYMMDD) so re-scans
// are idempotent and match the existing audit-engine records.

import { NextRequest, NextResponse } from "next/server";
import { addTrade, type ActiveTrade } from "@/lib/activeTradeTracker";
import { updatePrice } from "@/lib/trade-audit-client";
import { rejectOptionSelling, isStrikeOnSymbolScale, meetsConfidenceFloor } from "@/lib/trade-validator-gate";

function istYmd(when = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(when)
    .replace(/-/g, "");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      strategyId,
      symbol,
      strike,
      optionType,
      entry,
      sl,
      tp1,
      tp2,
      tp3,
      side = "BUY",
      instrumentType,  // 'CALL' | 'PUT' | 'FUTURES' | 'EQUITY' — for SELL safety
      confidence = 0,
      price,
      spotPrice,
      snapshotId,
      positionSize,
      riskPerTrade,
      qualityScore,
      qualityGrade,
    } = body;

    if (!strategyId || !symbol || !entry || entry <= 0) {
      return NextResponse.json(
        { success: false, error: "strategyId, symbol and entry are required" },
        { status: 400 }
      );
    }

    // Quality floors — PE has 0 historical wins on this book; demand stronger
    // signals before locking one-trade-per-underlying. CE keeps a milder floor.
    // Options with confidence 0/missing are REJECTED (conf=0 hole closed).
    const typeUC = (optionType || "").toUpperCase();
    const confNum = Number(confidence) || 0;
    if (!meetsConfidenceFloor(typeUC, confNum)) {
      const confFloor = typeUC === "PE" ? 65 : 55;
      return NextResponse.json(
        { success: false, error: `confidence ${confNum} below floor ${confFloor} for ${typeUC || "option"}` },
        { status: 422 }
      );
    }
    const entryNum = Number(entry);
    const slNum = Number(sl) || entryNum * 0.78;
    const tp1Num = Number(tp1) || entryNum;
    if (entryNum < 5 || slNum <= 0 || slNum >= entryNum || tp1Num <= entryNum) {
      return NextResponse.json(
        { success: false, error: `invalid levels entry=${entryNum} sl=${slNum} tp1=${tp1Num} (need entry>=5, sl<entry<tp1)` },
        { status: 422 }
      );
    }

    // SAFETY: Option selling rejected — instrument-aware
    const inferredInstrument = instrumentType || (optionType === 'PE' ? 'PUT' : optionType === 'CE' ? 'CALL' : undefined);
    const sellRejection = rejectOptionSelling(side, undefined, inferredInstrument);
    if (sellRejection) {
      return NextResponse.json(
        { success: false, error: sellRejection },
        { status: 422 }
      );
    }

    // SAFETY: wrong-symbol-scale strikes never record (Jul-15 SENSEX-24200
    // incident — NIFTY strikes registered under symbol=SENSEX).
    const strikeNum = Number(strike) || 0;
    const spotNum = Number(spotPrice) || 0;
    if (!isStrikeOnSymbolScale(symbol, strikeNum, spotNum)) {
      return NextResponse.json(
        {
          success: false,
          error: `strike ${strikeNum} is off-scale for ${symbol} (spot ${spotNum || "n/a"}) — refusing wrong-symbol strike`,
        },
        { status: 422 }
      );
    }

    const ymd = istYmd();
    const type = (optionType || "").toUpperCase() === "PE" ? "PE" : "CE";
    const id = `${strategyId}-${symbol}-${strike}-${type}-${ymd}`;

    const trade: ActiveTrade = {
      id,
      symbol,
      side: (side === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
      instrument: `${symbol} ${strike} ${type}`,
      strike: Number(strike) || 0,
      optionType: type,
      entry: Number(entry),
      sl: Number(sl) || Number(entry) * 0.78,
      tp1: Number(tp1) || Number(entry),
      tp2: Number(tp2) || Number(tp1) || Number(entry),
      tp3: tp3 ? Number(tp3) : undefined,
      status: "ACTIVE",
      sentAt: new Date().toISOString(),
      source: strategyId,
      snapshotId: snapshotId ?? undefined,
      spotPrice: spotPrice ? Number(spotPrice) : undefined,
      confidence: confidence ? Number(confidence) : undefined,
      positionSize: positionSize ? Number(positionSize) : undefined,
      riskPerTrade: riskPerTrade ? Number(riskPerTrade) : undefined,
      qualityScore: qualityScore ? Number(qualityScore) : undefined,
      qualityGrade: qualityGrade || undefined,
    };

    await addTrade(trade);

    // Feed the live premium as a tracking tick so the audit engine can compute
    // MFE/MAE and verify the backtest accurately.
    if (price && Number(price) > 0) {
      await updatePrice(id, Number(price)).catch(() => {});
    }

    return NextResponse.json({ success: true, id, confidence });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || "register failed" },
      { status: 500 }
    );
  }
}
