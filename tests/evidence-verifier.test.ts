import { describe, test, expect } from "bun:test";
import {
  checkOiPlausibility,
  checkGreeksPlausibility,
  checkDeltaBounds,
  checkNewsPlausibility,
  looksLikeGenericHeadline,
  verifyTradeEvidence,
  buildEvidenceIntegrityReport,
  formatEvidenceBlock,
  printEvidenceIntegrityReport,
  emptyEvidence,
  TradeEvidence,
  OIEvidence,
  GreeksEvidence,
  NewsEvidence,
} from "@/lib/evidence-verifier";
import {
  pickSnapshotAtOrBefore,
  buildOiEvidence,
  buildGreeksEvidence,
  buildNewsEvidence,
} from "@/lib/evidence-fetcher";

// ─── Fixtures ───────────────────────────────────────────────────

const ENTRY = "2026-08-14T10:32:00+05:30";

function goodOi(): OIEvidence {
  return {
    pcr: 1.34,
    oiResistance: { strike: 24300, ceOi: 1820000 },
    oiSupport: { strike: 24100, peOi: 2140000 },
    oiChangeNearSpot: { peChange: 210000, ceChange: 40000 },
    maxPain: 24150,
    atmOis: { strike: 24200, ceOi: 950000, peOi: 1100000 },
  };
}

function goodGreeks(): GreeksEvidence {
  return {
    atmIv: 13.8,
    skew: 1.2,
    gammaFlip: 24160,
    regime: "trending",
    expectedMove: 187,
    atmThetaPct: -6.2,
    atmDeltaCe: 0.55,
    atmDeltaPe: -0.45,
  };
}

function goodNews(): NewsEvidence {
  return {
    score: 6,
    origin: "recorded",
    headlines: [
      {
        title: "RBI holds repo rate, signals accommodative stance",
        source: "Moneycontrol",
        url: "https://moneycontrol.com/news/rbi-holds-repo-rate-1234567.html",
        publishedAt: "2026-08-14T08:15:00+05:30",
      },
      {
        title: "Nifty banks lead early gains on strong FII inflows",
        source: "Economic Times",
        url: "https://economictimes.indiatimes.com/markets/nifty-banks-gains/articleshow/98765432.cms",
        publishedAt: "2026-08-14T09:20:00+05:30",
      },
    ],
  };
}

function goodEvidence(): TradeEvidence {
  return {
    available: true,
    unavailableReason: null,
    oi: goodOi(),
    greeks: goodGreeks(),
    news: goodNews(),
    biasScore: 62,
    groupsAgreeing: 6,
    groupsTotal: 9,
    confidence: "High",
  };
}

// ─── OI plausibility ────────────────────────────────────────────

describe("OI plausibility", () => {
  test("clean OI produces no flags", () => {
    expect(checkOiPlausibility(goodOi()).length).toBe(0);
  });

  test("negative CE OI is CRITICAL", () => {
    const oi = goodOi();
    oi.oiResistance = { strike: 24300, ceOi: -1000 };
    const flags = checkOiPlausibility(oi);
    expect(flags.some((f) => f.severity === "CRITICAL" && /Negative CE OI/.test(f.message))).toBe(true);
  });

  test("PCR outside 0.3-3.0 flagged REVIEW, not auto-rejected", () => {
    const oi = goodOi();
    oi.pcr = 4.5;
    const flags = checkOiPlausibility(oi);
    expect(flags.length).toBe(1);
    expect(flags[0].severity).toBe("REVIEW");
    expect(flags[0].category).toBe("OI");
  });

  test("extreme-but-real PCR near expiry is REVIEW (manual), never CRITICAL", () => {
    const oi = goodOi();
    oi.pcr = 0.1;
    const flags = checkOiPlausibility(oi);
    expect(flags[0].severity).toBe("REVIEW");
  });

  test("ATM strike zero OI both sides = data gap REVIEW flag", () => {
    const oi = goodOi();
    oi.atmOis = { strike: 24200, ceOi: 0, peOi: 0 };
    const flags = checkOiPlausibility(oi);
    expect(flags.some((f) => /data gap/.test(f.message))).toBe(true);
  });

  test("non-finite PCR is CRITICAL", () => {
    const oi = goodOi();
    oi.pcr = NaN;
    expect(checkOiPlausibility(oi)[0].severity).toBe("CRITICAL");
  });
});

// ─── Greeks plausibility ────────────────────────────────────────

describe("Greeks plausibility", () => {
  test("clean greeks produce no flags", () => {
    expect(checkGreeksPlausibility(goodGreeks(), "CE").length).toBe(0);
  });

  test("deliberately corrupted IV of -5% is flagged CRITICAL", () => {
    const g = goodGreeks();
    g.atmIv = -5;
    const flags = checkGreeksPlausibility(g, "CE");
    expect(flags.some((f) => f.category === "GREEKS" && f.severity === "CRITICAL" && /not positive/.test(f.message))).toBe(true);
  });

  test("IV of 300% outside sane band is flagged CRITICAL", () => {
    const g = goodGreeks();
    g.atmIv = 300;
    const flags = checkGreeksPlausibility(g, "PE");
    expect(flags.some((f) => /outside sane band/.test(f.message))).toBe(true);
  });

  test("IV of exactly 5% and 150% are within band (bounds inclusive)", () => {
    const lo = goodGreeks(); lo.atmIv = 5;
    const hi = goodGreeks(); hi.atmIv = 150;
    expect(checkGreeksPlausibility(lo, "CE").length).toBe(0);
    expect(checkGreeksPlausibility(hi, "CE").length).toBe(0);
  });

  test("positive theta on a long option is CRITICAL (sign bug)", () => {
    const g = goodGreeks();
    g.atmThetaPct = 6.2;
    const flags = checkGreeksPlausibility(g, "CE", true);
    expect(flags.some((f) => /theta is positive/.test(f.message))).toBe(true);
  });

  test("deliberately corrupted CE delta of 1.4 is flagged CRITICAL", () => {
    const flags = checkDeltaBounds(1.4, "CE");
    expect(flags.length).toBe(1);
    expect(flags[0].severity).toBe("CRITICAL");
    expect(flags[0].message).toContain("(0,1)");
  });

  test("PE delta must be in (-1,0)", () => {
    expect(checkDeltaBounds(0.3, "PE").length).toBe(1);
    expect(checkDeltaBounds(-0.4, "PE").length).toBe(0);
    expect(checkDeltaBounds(-1.4, "PE").length).toBe(1);
  });

  test("valid CE delta 0.55 passes", () => {
    expect(checkDeltaBounds(0.55, "CE").length).toBe(0);
  });
});

// ─── News plausibility (fabrication detection) ──────────────────

describe("News plausibility", () => {
  test("clean pre-entry headlines produce no flags", () => {
    expect(checkNewsPlausibility(goodNews(), ENTRY).length).toBe(0);
  });

  test("injected FUTURE headline (after entry) is caught as fabricated evidence", () => {
    const news = goodNews();
    news.headlines.push({
      title: "FIIs buy index futures heavily in afternoon trade session",
      source: "LiveMint",
      url: "https://livemint.com/markets/fii-futures-12345.html",
      publishedAt: "2026-08-14T14:00:00+05:30", // AFTER 10:32 entry
    });
    const flags = checkNewsPlausibility(news, ENTRY);
    const future = flags.find((f) => /AFTER trade entry/.test(f.message));
    expect(future).toBeDefined();
    expect(future!.severity).toBe("CRITICAL");
    expect(future!.message).toContain("fabricated evidence");
  });

  test("headline with no source is CRITICAL", () => {
    const news = goodNews();
    news.headlines.push({
      title: "Market participants expect volatile week ahead of expiry",
      source: null,
      url: "https://example.com/a",
      publishedAt: "2026-08-14T09:00:00+05:30",
    });
    const flags = checkNewsPlausibility(news, ENTRY);
    expect(flags.some((f) => /no source/.test(f.message))).toBe(true);
  });

  test("headline with no URL is CRITICAL", () => {
    const news = goodNews();
    news.headlines.push({
      title: "Bank Nifty outperforms on HDFC Bank earnings optimism",
      source: "Moneycontrol",
      url: "",
      publishedAt: "2026-08-14T09:00:00+05:30",
    });
    expect(checkNewsPlausibility(news, ENTRY).some((f) => /no URL/.test(f.message))).toBe(true);
  });

  test("headline with no publish timestamp is CRITICAL", () => {
    const news = goodNews();
    news.headlines.push({
      title: "Rupee steadies against dollar in early morning trade",
      source: "Reuters",
      url: "https://reuters.com/rupee-1",
      publishedAt: null,
    });
    expect(checkNewsPlausibility(news, ENTRY).some((f) => /no publish timestamp/.test(f.message))).toBe(true);
  });

  test("generic/generated text headline is flagged", () => {
    const news = goodNews();
    news.headlines.push({
      title: "Market update",
      source: "X",
      url: "https://x.com/1",
      publishedAt: "2026-08-14T09:00:00+05:30",
    });
    const flags = checkNewsPlausibility(news, ENTRY);
    expect(flags.some((f) => /generic\/generated/.test(f.message))).toBe(true);
  });

  test("placeholder template headline with {{}} is flagged", () => {
    expect(looksLikeGenericHeadline("Nifty closes {{points}} points higher")).toBe(true);
    expect(looksLikeGenericHeadline("[headline]")).toBe(true);
    expect(looksLikeGenericHeadline("Sample trade alert")).toBe(true);
  });

  test("real-looking long headline is not flagged", () => {
    expect(looksLikeGenericHeadline("RBI holds repo rate, signals accommodative stance")).toBe(false);
    expect(looksLikeGenericHeadline("Nifty banks lead early gains on strong FII inflows")).toBe(false);
  });

  test("too-short headline is treated as generic", () => {
    expect(looksLikeGenericHeadline("Big news!")).toBe(true);
  });
});

// ─── Per-trade verification + report ────────────────────────────

describe("verifyTradeEvidence", () => {
  test("clean full evidence → FULL integrity, no flags", () => {
    const r = verifyTradeEvidence({
      tradeId: "T1",
      entryTime: ENTRY,
      optionType: "CE",
      evidence: goodEvidence(),
    });
    expect(r.integrity).toBe("FULL");
    expect(r.flags.length).toBe(0);
  });

  test("missing evidence → PRICE_ONLY (explicitly NOT AVAILABLE, never filled)", () => {
    const ev = emptyEvidence(
      "historical OI/Greeks data not accessible for this date"
    );
    const r = verifyTradeEvidence({
      tradeId: "T2",
      entryTime: ENTRY,
      optionType: "CE",
      evidence: ev,
    });
    expect(r.integrity).toBe("PRICE_ONLY");
    expect(r.evidence.oi).toBeNull();
    expect(r.evidence.greeks).toBeNull();
    expect(r.evidence.news).toBeNull();
    expect(r.evidence.unavailableReason).toContain("not accessible");
  });

  test("corrupted greeks → FAILED integrity", () => {
    const ev = goodEvidence();
    ev.greeks!.atmIv = -5;
    const r = verifyTradeEvidence({
      tradeId: "T3",
      entryTime: ENTRY,
      optionType: "CE",
      evidence: ev,
    });
    expect(r.integrity).toBe("FAILED");
    expect(r.flags.some((f) => f.category === "GREEKS")).toBe(true);
  });

  test("fabricated news → FAILED integrity with tradeId attached", () => {
    const ev = goodEvidence();
    ev.news!.headlines.push({
      title: "Secret institutional buying detected in index options",
      source: "unknown",
      url: "",
      publishedAt: "2026-08-14T15:00:00+05:30",
    });
    const r = verifyTradeEvidence({
      tradeId: "T4",
      entryTime: ENTRY,
      optionType: "PE",
      evidence: ev,
    });
    expect(r.integrity).toBe("FAILED");
    expect(r.flags.every((f) => f.tradeId === "T4")).toBe(true);
    expect(r.flags.some((f) => f.category === "NEWS")).toBe(true);
  });

  test("OI+greeks but no news → PARTIAL", () => {
    const ev = goodEvidence();
    ev.news = null;
    const r = verifyTradeEvidence({
      tradeId: "T5",
      entryTime: ENTRY,
      optionType: "CE",
      evidence: ev,
    });
    expect(r.integrity).toBe("PARTIAL");
  });

  // ── ATM delta bounds wiring (GreeksEvidence.atmDeltaCe / atmDeltaPe) ──

  test("out-of-bounds CE delta → FAILED + GREEKS CRITICAL flag with tradeId", () => {
    const ev = goodEvidence();
    ev.greeks!.atmDeltaCe = 1.4;
    const r = verifyTradeEvidence({
      tradeId: "T7",
      entryTime: ENTRY,
      optionType: "CE",
      evidence: ev,
    });
    expect(r.integrity).toBe("FAILED");
    const f = r.flags.find(
      (f) => f.category === "GREEKS" && /CE delta 1\.4/.test(f.message)
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe("CRITICAL");
    expect(r.flags.every((f) => f.tradeId === "T7")).toBe(true);
  });

  test("out-of-bounds PE delta → FAILED", () => {
    const ev = goodEvidence();
    ev.greeks!.atmDeltaPe = 0.3;
    const r = verifyTradeEvidence({
      tradeId: "T8",
      entryTime: ENTRY,
      optionType: "PE",
      evidence: ev,
    });
    expect(r.integrity).toBe("FAILED");
    expect(
      r.flags.some(
        (f) => f.category === "GREEKS" && /PE delta 0\.3/.test(f.message)
      )
    ).toBe(true);
  });

  test("in-bounds deltas → no delta flag (CE judges atmDeltaCe, PE judges atmDeltaPe)", () => {
    const ev = goodEvidence();
    ev.greeks!.atmDeltaCe = 0.55;
    ev.greeks!.atmDeltaPe = -0.45;
    const ce = verifyTradeEvidence({
      tradeId: "T9",
      entryTime: ENTRY,
      optionType: "CE",
      evidence: ev,
    });
    expect(ce.integrity).toBe("FULL");
    expect(ce.flags.length).toBe(0);
    const pe = verifyTradeEvidence({
      tradeId: "T10",
      entryTime: ENTRY,
      optionType: "PE",
      evidence: ev,
    });
    expect(pe.integrity).toBe("FULL");
    expect(pe.flags.length).toBe(0);
  });

  test("a CE trade never judges atmDeltaPe (and vice versa)", () => {
    const ev = goodEvidence();
    ev.greeks!.atmDeltaPe = 0.9; // out of bounds for PE, irrelevant to a CE trade
    const r = verifyTradeEvidence({
      tradeId: "T11",
      entryTime: ENTRY,
      optionType: "CE",
      evidence: ev,
    });
    expect(r.integrity).toBe("FULL");
    expect(r.flags.filter((f) => /delta/i.test(f.message)).length).toBe(0);
  });

  test("null deltas and optionType=null skip delta bounds — no false CRITICAL", () => {
    const ev = goodEvidence();
    ev.greeks!.atmDeltaCe = null;
    ev.greeks!.atmDeltaPe = null;
    const noDeltas = verifyTradeEvidence({
      tradeId: "T12",
      entryTime: ENTRY,
      optionType: "CE",
      evidence: ev,
    });
    expect(noDeltas.integrity).toBe("FULL");
    expect(noDeltas.flags.length).toBe(0);
    const equity = verifyTradeEvidence({
      tradeId: "T13",
      entryTime: ENTRY,
      optionType: null,
      evidence: goodEvidence(),
    });
    expect(equity.integrity).toBe("FULL");
    expect(equity.flags.length).toBe(0);
  });
});

describe("buildEvidenceIntegrityReport", () => {
  test("aggregates counts by category and separates news fabrication", () => {
    const results = [
      verifyTradeEvidence({
        tradeId: "A",
        entryTime: ENTRY,
        optionType: "CE",
        evidence: goodEvidence(),
      }),
      verifyTradeEvidence({
        tradeId: "B",
        entryTime: ENTRY,
        optionType: "CE",
        evidence: emptyEvidence("historical OI/Greeks data not accessible for this date"),
      }),
    ];

    // Trade C: OI flag (REVIEW) + fabricated news (CRITICAL)
    const evC = goodEvidence();
    evC.oi!.pcr = 9;
    evC.news!.headlines.push({
      title: "Wonderful market day continues upward strongly",
      source: null,
      url: null,
      publishedAt: "2026-08-15T10:00:00+05:30",
    });
    results.push(
      verifyTradeEvidence({
        tradeId: "C",
        entryTime: ENTRY,
        optionType: "CE",
        evidence: evC,
      })
    );

    const report = buildEvidenceIntegrityReport(results);
    expect(report.totalTrades).toBe(3);
    expect(report.fullEvidenceTrades).toBe(1);
    expect(report.priceOnlyTrades).toBe(1);
    expect(report.failedIntegrityTrades).toBe(1);
    expect(report.oiPlausibilityFlags).toBe(1);
    expect(report.newsPlausibilityFlags).toBeGreaterThanOrEqual(2);
    expect(report.newsFabricationFailures).toBeGreaterThanOrEqual(2);
    expect(report.flaggedTrades.map((t) => t.tradeId)).toContain("C");
    // failed integrity must be its own line, distinct from price-only
    expect(report.failedIntegrityTrades + report.priceOnlyTrades).toBeLessThanOrEqual(3);
  });

  test("empty report is all zeros", () => {
    const r = buildEvidenceIntegrityReport([]);
    expect(r.totalTrades).toBe(0);
    expect(r.newsFabricationFailures).toBe(0);
  });
});

// ─── Print formatting ───────────────────────────────────────────

describe("formatEvidenceBlock", () => {
  test("missing evidence prints the explicit NOT AVAILABLE sentence", () => {
    const block = formatEvidenceBlock(
      emptyEvidence("historical OI/Greeks data not accessible for this date")
    );
    expect(block).toContain("Evidence: NOT AVAILABLE");
    expect(block).toContain("signal generated from price-structure only");
    // must never contain fabricated numbers
    expect(block).not.toMatch(/PCR \d/);
    expect(block).not.toMatch(/ATM IV \d/);
  });

  test("full evidence prints OI, greeks and news blocks", () => {
    const block = formatEvidenceBlock(goodEvidence());
    expect(block).toContain("Option chain evidence:");
    expect(block).toContain("PCR 1.34");
    expect(block).toContain("OI resistance 24300");
    expect(block).toContain("OI support 24100");
    expect(block).toContain("Greeks evidence:");
    expect(block).toContain("ATM IV 13.8%");
    expect(block).toContain("Skew (put-call) +1.20");
    expect(block).toContain("ATM CE delta 0.55");
    expect(block).toContain("ATM PE delta -0.45");
    expect(block).toContain("News/sentiment evidence:");
    expect(block).toContain("RBI holds repo rate, signals accommodative stance");
    expect(block).toContain("source: Moneycontrol, published 2026-08-14T08:15:00+05:30");
    expect(block).toContain("Bias score: 62 | Groups agreeing: 6/9 | Confidence: High");
  });

  test("integrity report prints news fabrication as its own severe line", () => {
    const report = buildEvidenceIntegrityReport([
      verifyTradeEvidence({
        tradeId: "X",
        entryTime: ENTRY,
        optionType: "CE",
        evidence: goodEvidence(),
      }),
    ]);
    const lines = printEvidenceIntegrityReport(report);
    const text = lines.join("\n");
    expect(text).toContain("EVIDENCE INTEGRITY CHECK");
    expect(text).toContain("News evidence integrity failures: 0");
    expect(text).toContain("OI flags:");
    expect(text).toContain("Greeks flags:");
    expect(text).toContain("Evidence NOT AVAILABLE (price-only): 0");
  });
});

// ─── Historical snapshot → evidence builders ────────────────────

describe("evidence-fetcher builders", () => {
  const snapshot = {
    timestamp: "2026-08-14T10:30:00+05:30",
    spot: 24187,
    indiaVix: 13.2,
    maxPain: 24150,
    iv: 13.5,
    features: { regime: "trending" },
    optionChain: [
      { strike: 24100, type: "CE", ltp: 160, oi: 1200000, oiChg: 30000, iv: 13.9,
        greeks: { delta: 0.62, theta: -8.1, gamma: 0.0021, vega: 12.3 }, volume: 900000 },
      { strike: 24100, type: "PE", ltp: 95, oi: 2140000, oiChg: 210000, iv: 14.4,
        greeks: { delta: -0.38, theta: -7.5, gamma: 0.0020, vega: 11.9 }, volume: 850000 },
      { strike: 24200, type: "CE", ltp: 105, oi: 950000, oiChg: 40000, iv: 13.6,
        greeks: { delta: 0.45, theta: -7.9, gamma: 0.0024, vega: 13.1 }, volume: 1100000 },
      { strike: 24200, type: "PE", ltp: 118, oi: 1100000, oiChg: 95000, iv: 13.8,
        greeks: { delta: -0.55, theta: -8.0, gamma: 0.0023, vega: 13.0 }, volume: 1050000 },
      { strike: 24300, type: "CE", ltp: 58, oi: 1820000, oiChg: -15000, iv: 14.1,
        greeks: { delta: 0.28, theta: -6.4, gamma: 0.0018, vega: 10.8 }, volume: 700000 },
      { strike: 24300, type: "PE", ltp: 175, oi: 700000, oiChg: 5000, iv: 14.0,
        greeks: { delta: -0.72, theta: -7.2, gamma: 0.0019, vega: 10.5 }, volume: 600000 },
    ],
  };

  test("buildOiEvidence: PCR, resistance/support, near-spot OI change, ATM", () => {
    const oi = buildOiEvidence(snapshot);
    expect(oi).not.toBeNull();
    // PCR = total PE / total CE
    const totalCe = 1200000 + 950000 + 1820000;
    const totalPe = 2140000 + 1100000 + 700000;
    expect(oi!.pcr!).toBeCloseTo(totalPe / totalCe, 5);
    // resistance = highest CE OI >= spot(24187) → 24300 with 1.82M
    expect(oi!.oiResistance).toEqual({ strike: 24300, ceOi: 1820000 });
    // support = highest PE OI <= spot → 24100 with 2.14M
    expect(oi!.oiSupport).toEqual({ strike: 24100, peOi: 2140000 });
    expect(oi!.maxPain).toBe(24150);
    // ATM = 24200 (nearest to 24187)
    expect(oi!.atmOis!.strike).toBe(24200);
    // near-spot OI change: strikes within 1% of 24187 → 24100, 24200, 24300 (diff 113 < 241.87)
    expect(oi!.oiChangeNearSpot!.peChange).toBe(210000 + 95000 + 5000);
    expect(oi!.oiChangeNearSpot!.ceChange).toBe(30000 + 40000 - 15000);
  });

  test("buildGreeksEvidence: real math — expected move from VIX, skew, theta%", () => {
    const g = buildGreeksEvidence(snapshot);
    expect(g).not.toBeNull();
    // ATM IV = mean(13.6, 13.8)
    expect(g!.atmIv!).toBeCloseTo(13.7, 5);
    // skew = PE IV − CE IV at ATM
    expect(g!.skew!).toBeCloseTo(0.2, 5);
    // expected move = spot * vix/100 / sqrt(252)
    const expected = (24187 * 0.132) / Math.sqrt(252);
    expect(g!.expectedMove!).toBeCloseTo(expected, 4);
    // theta% = ATM CE theta / ltp (long → negative)
    expect(g!.atmThetaPct!).toBeLessThan(0);
    expect(g!.atmThetaPct!).toBeCloseTo((-7.9 / 105) * 100, 5);
    expect(g!.regime).toBe("trending");
    expect(typeof g!.gammaFlip).toBe("number");
  });

  test("buildGreeksEvidence returns null for empty chain (no placeholder numbers)", () => {
    expect(buildGreeksEvidence({ spot: 24187, optionChain: [] })).toBeNull();
    expect(buildOiEvidence({ optionChain: [] })).toBeNull();
  });

  test("buildGreeksEvidence: ATM CE/PE deltas read from the ATM chain legs", () => {
    const g = buildGreeksEvidence(snapshot);
    expect(g).not.toBeNull();
    // ATM = 24200 (nearest to spot 24187): CE delta 0.45, PE delta -0.55
    expect(g!.atmDeltaCe!).toBeCloseTo(0.45, 5);
    expect(g!.atmDeltaPe!).toBeCloseTo(-0.55, 5);
  });

  test("buildGreeksEvidence: legs with zero greeks (NSE legacy snapshots) → deltas and theta null, not 0", () => {
    const zeroed = {
      ...snapshot,
      optionChain: snapshot.optionChain.map((l: any) => ({
        ...l,
        greeks: { delta: 0, theta: 0, gamma: 0, vega: 0 },
      })),
    };
    const g = buildGreeksEvidence(zeroed);
    expect(g).not.toBeNull();
    // 0 means "greeks not computed" — must surface as null, never as a fake value
    expect(g!.atmDeltaCe).toBeNull();
    expect(g!.atmDeltaPe).toBeNull();
    expect(g!.atmThetaPct).toBeNull();
    // IV is real data and survives
    expect(g!.atmIv!).toBeCloseTo(13.7, 5);
  });

  test("pickSnapshotAtOrBefore never selects a snapshot AFTER entry", () => {
    const snaps = [
      { timestamp: "2026-08-14T10:00:00+05:30" },
      { timestamp: "2026-08-14T10:30:00+05:30" },
      { timestamp: "2026-08-14T14:00:00+05:30" }, // after entry 10:32
    ];
    const picked = pickSnapshotAtOrBefore(snaps, ENTRY);
    expect(picked.timestamp).toBe("2026-08-14T10:30:00+05:30");
  });

  test("pickSnapshotAtOrBefore returns null when all snapshots are after entry", () => {
    const snaps = [{ timestamp: "2026-08-14T15:00:00+05:30" }];
    expect(pickSnapshotAtOrBefore(snaps, ENTRY)).toBeNull();
  });

  test("buildNewsEvidence: recorded marketContext news is used", () => {
    const n = buildNewsEvidence({
      newsScore: 6,
      newsHeadlines: [
        {
          title: "RBI holds repo rate, signals accommodative stance",
          source: "Moneycontrol",
          url: "https://moneycontrol.com/news/rbi-1.html",
          publishedAt: "2026-08-14T08:15:00+05:30",
        },
        { title: "   " }, // blank → dropped
      ],
    });
    expect(n).not.toBeNull();
    expect(n!.score).toBe(6);
    expect(n!.headlines.length).toBe(1);
    expect(n!.origin).toBe("recorded");
  });

  test("buildNewsEvidence returns null when nothing was recorded (no fabrication)", () => {
    expect(buildNewsEvidence(null)).toBeNull();
    expect(buildNewsEvidence({})).toBeNull();
    expect(buildNewsEvidence({ vix: 13 })).toBeNull();
  });

  test("snapshot with zero ATM OI (data gap) surfaces as REVIEW flag through verify", () => {
    const oi = buildOiEvidence(snapshot);
    // simulate gap: ATM OI both zero
    oi!.atmOis = { strike: 24200, ceOi: 0, peOi: 0 };
    const flags = checkOiPlausibility(oi!);
    expect(flags.some((f) => f.severity === "REVIEW" && /data gap/.test(f.message))).toBe(true);
  });
});
