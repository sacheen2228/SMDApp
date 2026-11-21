/// <reference types="bun-types" />
// ═══════════════════════════════════════════════════════════════════════════
// THE EOD DIGEST MUST READ THE REAL LEDGER (user complaint 2026-11-21)
//
// THE DEFECT (the 20/11 digest showed 0 / 0 / 0 / 0):
//   fetchTodayTrades() read ONLY the Prisma `Trade` table — and the real
//   signals of that day (22 INTRADAY equity + 9 BTST) live in the TRADE-AUDIT
//   sidecar (and in CandidateLog / AlertClaim), not in Prisma. The sidecar rows
//   carried last_price / highest_price / exit_price, so the real TP/SL hits
//   were invisible to the digest. `getTodaySignals()` reads the SENT-only
//   dedup file, so a day where every candidate was BLOCKED showed "0 signals"
//   with no reason at all.
//
// THE FIX (Wave 3):
//   1. the digest reads the sidecar (the real ledger) + the Prisma journal,
//   2. the sent alerts come from AlertClaim (the atomic send decision),
//   3. the BLOCKED candidates come from CandidateLog with their REASON — the
//      user can finally see WHY nothing was sent.
//
// OFFLINE: pure mapping / merging / formatting helpers only — no DB, no
// network, no sidecar.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test, expect } from "bun:test";
import {
  mapAuditTrade,
  mergeDigestTrades,
  summarizeCandidates,
  formatDigestMessage,
  type DigestTrade,
  type DigestCandidate,
} from "@/lib/dailyDigest";

const auditTrade = (over: Record<string, any> = {}) => ({
  id: "audit-1",
  strategyId: "INTRADAY",
  strategyVersion: "1",
  createdAtIst: "2026-11-20T10:32:00+05:30",
  symbol: "RELIANCE",
  exchange: "NSE",
  instrumentType: "EQUITY",
  spotPrice: 2500,
  strikePrice: null,
  expiry: null,
  optionType: null,
  entryPrice: 2500,
  stopLoss: 2450,
  tp1: 2600,
  tp2: null,
  tp3: null,
  quantity: 10,
  riskRewardRatio: 2,
  signalConfidence: 72,
  aiConfidence: null,
  probabilityScore: null,
  trendDirection: "BULLISH",
  signalReason: "breakout",
  marketSession: "MORNING",
  status: "open" as const,
  highestPrice: null,
  lowestPrice: null,
  mfe: null,
  mae: null,
  tp1Hit: false,
  tp2Hit: false,
  tp3Hit: false,
  slHit: false,
  lastPrice: null,
  exitPrice: null,
  exitTime: null,
  exitReason: null,
  grossPnl: null,
  fees: 0,
  netPnl: null,
  roiPct: null,
  rMultiple: null,
  timeInTradeSec: null,
  verification: null,
  ...over,
});

describe("the digest reads the TRADE-AUDIT ledger (the real trades)", () => {
  test("an open audit trade is an ACTIVE trade", () => {
    const t = mapAuditTrade(auditTrade() as any);
    expect(t.status).toBe("ACTIVE");
    expect(t.symbol).toBe("RELIANCE");
    expect(t.strategy).toBe("INTRADAY");
  });

  test("a TP1 hit is a TP hit (never counted Active)", () => {
    const t = mapAuditTrade(auditTrade({ status: "closed", tp1Hit: true, exitPrice: 2600, netPnl: 1000 }) as any);
    expect(t.status).toBe("TP1_HIT");
    expect(t.tpHitLevel).toBe("TP1");
    expect(t.pnl).toBe(1000);
  });

  test("an SL hit is an SL hit with the realised loss", () => {
    const t = mapAuditTrade(auditTrade({ status: "closed", slHit: true, exitPrice: 2450, netPnl: -500 }) as any);
    expect(t.status).toBe("SL_HIT");
    expect(t.pnl).toBe(-500);
  });

  test("a closed trade without a TP/SL is CLOSED with its P&L", () => {
    const t = mapAuditTrade(auditTrade({ status: "closed", exitPrice: 2550, netPnl: 500, exitReason: "time_exit" }) as any);
    expect(t.status).toBe("CLOSED");
    expect(t.pnl).toBe(500);
  });
});

describe("the digest merges the two stores without double counting", () => {
  test("the same trade in both stores appears once", () => {
    const audit: DigestTrade = mapAuditTrade(auditTrade() as any);
    const journal: DigestTrade = {
      tradeId: "prisma-1",
      symbol: "RELIANCE",
      side: "BUY",
      status: "ACTIVE",
      entryPrice: 2500,
      strategy: "intraday-scanner",
    };
    const merged = mergeDigestTrades([audit], [journal]);
    expect(merged.length).toBe(1);
  });

  test("different trades are both kept", () => {
    const merged = mergeDigestTrades(
      [mapAuditTrade(auditTrade() as any)],
      [{ tradeId: "p2", symbol: "TCS", status: "ACTIVE", entryPrice: 4000, side: "BUY" }],
    );
    expect(merged.length).toBe(2);
  });
});

describe("the digest shows WHY a candidate never became an alert", () => {
  test("a blocked candidate carries its reason", () => {
    const rows: DigestCandidate[] = [
      {
        source: "stock-scanner",
        symbol: "RELIANCE",
        direction: "BUY",
        strike: null,
        sent: false,
        wouldBlock: true,
        gateVerdict: "BLOCK",
        fails: ['risk ₹9,000 exceeds the ₹8,000 risk budget'],
      },
      { source: "grok", symbol: "TCS", direction: "BUY", strike: null, sent: true, wouldBlock: false, gateVerdict: "PASS", fails: [] },
    ];
    const out = summarizeCandidates(rows);
    expect(out.sent).toBe(1);
    expect(out.blocked.length).toBe(1);
    expect(out.blocked[0]).toContain("RELIANCE");
    expect(out.blocked[0]).toContain("risk budget");
  });

  test("no candidates → no blocked lines (never an empty noise section)", () => {
    const out = summarizeCandidates([]);
    expect(out.sent).toBe(0);
    expect(out.blocked.length).toBe(0);
  });
});

describe("the digest message carries the blocked section", () => {
  test("the blocked count and the reasons are in the message", () => {
    const sections = {
      newSignals: [],
      activeOpen: [],
      tpHits: [],
      slHits: [],
      closed: [],
      deliveryFailures: [],
      blocked: ["  stock-scanner RELIANCE — risk ₹9,000 exceeds the ₹8,000 risk budget"],
      sentCount: 0,
    };
    const msg = formatDigestMessage(
      sections as any,
      { vix: { value: "DATA_UNAVAILABLE", source: "none", freshness: "UNAVAILABLE" }, fii: { fii: "DATA_UNAVAILABLE", dii: "DATA_UNAVAILABLE" } },
      "20/11/2026, 3:25:00 pm",
    );
    expect(msg).toContain("Blocked");
    expect(msg).toContain("risk budget");
  });
});
