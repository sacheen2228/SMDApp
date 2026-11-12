import { describe, test, expect } from "bun:test";
import {
  GATE_CONFIG as C,
  STRIKE_STEP,
  NEW_TOOLS,
  safeSymbol,
  redactArgs,
  enc,
  istClock,
  checkFreshness,
  wilson,
  bucketStats,
  ledgerBlocks,
  ledgerReport,
  calibrateConfidence,
  positionSize,
  evaluateTradeGate,
  formatGate,
  newRunState,
  guardToolCall,
  wrapToolResult,
  selectToolsV2,
  atr,
  vixBand,
  postMortem,
  otmSteps,
  journalRiskState,
  parseFeedHealth,
  type GateInput,
} from "@/lib/agent-brain-gate";

// Fresh timestamps for feed checks
const nowIso = () => new Date().toISOString();

function baseInput(over: Partial<GateInput> = {}): GateInput {
  return {
    direction: "call",
    confidence: 72,
    layers: {
      flow: { state: "agree", evidence: "FII buying" },
      structure: { state: "agree", evidence: "HH/HL intact" },
      levels: { state: "agree", evidence: "above VWAP, PE wall holding" },
      greeksVix: { state: "agree", evidence: "delta 0.52, VIX 13" },
      trigger: { state: "agree", evidence: "5m close above range" },
    },
    stamps: [nowIso()],
    allLive: true,
    delta: 0.52,
    optionRR: 2.0,     // meets the 1:2 minimum floor
    lots: 2,
    strikeDistanceSteps: 0,
    underlyingRR: 2.1,
    targetPts: 80,
    expectedMovePts: 100,
    vix: 13,
    isExpiryDay: false,
    eventNear: false,
    capital: C.capital,
    consecutiveLosses: 0,
    dailyLossPct: 0,
    ...over,
  };
}

const layersOver = (agree: number, against = 0) => {
  const mk = (n: number) => (n > 0 ? "agree" : n < 0 ? "against" : "neutral");
  // build 5 layers: first `agree` are agree, next `against` are against, rest neutral
  const states: Array<"agree" | "against" | "neutral"> = [
    ...Array(agree).fill("agree"),
    ...Array(against).fill("against"),
  ];
  while (states.length < 5) states.push("neutral");
  const keys = ["flow", "structure", "levels", "greeksVix", "trigger"] as const;
  const layers: GateInput["layers"] = {} as any;
  keys.forEach((k, i) => (layers[k] = { state: states[i], evidence: `${k} ${states[i]}` }));
  return layers;
};

describe("GATE_CONFIG / STRIKE_STEP", () => {
  test("discipline defaults present and coherent", () => {
    expect(C.minConfidence).toBe(50);
    expect(C.minLayersAgree).toBe(3);
    expect(C.maxLayersAgainst).toBe(1);
    expect(C.minUnderlyingRR).toBeGreaterThanOrEqual(2);
    expect(C.minOptionRR).toBe(2);   // 1:2 minimum
    expect(C.maxRiskPct).toBeGreaterThanOrEqual(C.defaultRiskPct);
    expect(C.maxOtmSteps).toBeLessThanOrEqual(3);
    expect(C.minAbsDelta).toBeGreaterThanOrEqual(0.3);
  });
  test("strike steps cover all index symbols", () => {
    expect(STRIKE_STEP.NIFTY).toBe(50);
    expect(STRIKE_STEP.SENSEX).toBe(100);
    expect(STRIKE_STEP.BANKEX).toBeTruthy();
  });
  test("NEW_TOOLS = the three gate tools", () => {
    const names = NEW_TOOLS.map((t: any) => t.function.name);
    expect(names).toEqual(["check_live_feed", "evaluate_trade_gate", "ledger_edge_report"]);
  });
});

describe("safeSymbol / redactArgs / enc", () => {
  test("sanitises injection attempts, keeps real symbols", () => {
    expect(safeSymbol("NIFTY")).toBe("NIFTY");
    expect(safeSymbol("BANKNIFTY&x=1")).toBe("BANKNIFTY");
    expect(safeSymbol('"; DROP TABLE')).toBe("NIFTY"); // leading-run only; junk falls back
    expect(safeSymbol("nifty")).toBe("NIFTY");
    expect(safeSymbol(undefined, "SENSEX")).toBe("SENSEX");
    expect(safeSymbol("")).toBe("NIFTY");
  });
  test("masks secret-ish fields but keeps reasoning args", () => {
    const r = redactArgs({ token: "secret-123", api_key: "k", session: "s", note: "buy 24500 CE", confidence: 70 });
    expect(r.token).toMatch(/\*\*\*/);
    expect(r.api_key).toMatch(/\*\*\*/);
    expect(r.session).toMatch(/\*\*\*/);
    expect(r.note).toBe("buy 24500 CE");
    expect(r.confidence).toBe(70);
  });
  test("enc encodes URL-unsafe chars", () => {
    expect(enc("NIFTY&evil=1")).toBe("NIFTY%26evil%3D1");
    expect(enc("A B")).toBe("A%20B");
  });
});

describe("istClock / checkFreshness", () => {
  test("returns IST hhmm + phase, closed on weekend", () => {
    const c = istClock(Date.UTC(2026, 9, 16, 6, 30)); // Fri 12:00 IST
    expect(c.hhmm).toBe("12:00");
    expect(c.phase.length).toBeGreaterThan(0);
    const sat = istClock(Date.UTC(2026, 9, 17, 6, 30));
    expect(sat.phase).toBe("CLOSED");
  });
  test("fresh stamps pass; old/empty fail with reason", () => {
    expect(checkFreshness([nowIso()]).ok).toBe(true);
    const old = checkFreshness([new Date(Date.now() - 30 * 60_000).toISOString()]);
    expect(old.ok).toBe(false);
    expect(old.reason).toBeTruthy();
    expect(checkFreshness([]).ok).toBe(false);
    expect(checkFreshness(null).ok).toBe(false);
  });
});

describe("positionSize", () => {
  test("normal sizing", () => {
    const r = positionSize({ capital: 200000, riskPct: 1, entry: 150, sl: 120, lotSize: 75 });
    expect(r.ok).toBe(false); // 2250 risk/lot > 2000 budget → 0 lots, not ok
    expect(r.lots).toBe(0);
    expect(r.guidance).toMatch(/tighten|cheaper|spread/i);
  });
  test("fits when stop is tight enough (per-trade budget model)", () => {
    // ₹45,000 deployed cap; risk = 20% of deployed → ₹9,000 budget; 1 NIFTY lot
    // at a ₹20 stop risks ₹1,300 and commits ₹19,500 → 2 lots fit (₹39,000),
    // 3 lots (₹58,500) would breach the cap.
    const r = positionSize({ entry: 300, sl: 280, lotSize: 65 });
    expect(r.lots).toBe(2);
    expect(r.riskAmount).toBe(2600);
    expect(r.capitalRequired).toBe(39000);
  });

  test("the per-trade deployment cap binds (a big capital does not buy a bigger position)", () => {
    const r = positionSize({ capital: 200000, riskPct: 1, entry: 150, sl: 145, lotSize: 75 });
    // ₹45,000 deployed cap; 1% risk = ₹450; one lot risks ₹375 → 1 lot fits,
    // two lots (₹750 risk) exceed the risk budget → still 1 lot even with ₹2L
    // capital; the cap binds on deployment, not risk.
    expect(r.lots).toBe(1);
    expect(r.ok).toBe(true);
  });

  test("a premium that does not fit the deployment budget yields 0 lots", () => {
    const r = positionSize({ entry: 900, sl: 700, lotSize: 65 });
    expect(r.lots).toBe(0);
    expect(r.maxLoss).toBeLessThanOrEqual(r.riskAmount + 1e-6);
  });
  test("entry=sl never divides by zero", () => {
    const r = positionSize({ capital: 200000, riskPct: 1, entry: 150, sl: 150, lotSize: 75 });
    expect(r.lots).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.guidance.length).toBeGreaterThan(0);
  });
});

describe("evaluateTradeGate", () => {
  test("all green → TRADE", () => {
    const res = evaluateTradeGate(baseInput());
    expect(res.verdict).toBe("TRADE");
    expect(res.checks.every((c) => c.status !== "fail")).toBe(true);
  });
  test("stale feed → WAIT (early/stale, not a failed trade)", () => {
    const res = evaluateTradeGate(baseInput({ stamps: [new Date(Date.now() - 45 * 60_000).toISOString()], allLive: false }));
    expect(res.verdict).toBe("WAIT");
    expect(formatGate(res)).toMatch(/WAIT/);
  });
  test("confidence below floor → WAIT", () => {
    expect(evaluateTradeGate(baseInput({ confidence: 49 })).verdict).toBe("WAIT");
    expect(evaluateTradeGate(baseInput({ confidence: 50 })).verdict).toBe("TRADE"); // floor is inclusive
  });
  test("two layers against → SKIP", () => {
    const res = evaluateTradeGate(baseInput({ layers: layersOver(3, 2) }));
    expect(res.verdict).toBe("SKIP");
  });
  test("fewer than 3 agreeing → SKIP", () => {
    expect(evaluateTradeGate(baseInput({ layers: layersOver(1, 0) })).verdict).toBe("SKIP");
  });
  test("lottery delta → SKIP", () => {
    expect(evaluateTradeGate(baseInput({ delta: 0.22 })).verdict).toBe("SKIP");
  });
  test("deep OTM strike → SKIP", () => {
    expect(evaluateTradeGate(baseInput({ strikeDistanceSteps: 5 })).verdict).toBe("SKIP");
  });
  test("option R:R below floor → SKIP", () => {
    expect(evaluateTradeGate(baseInput({ optionRR: 1.1 })).verdict).toBe("SKIP");
  });
  test("underlying R:R below floor → SKIP", () => {
    expect(evaluateTradeGate(baseInput({ underlyingRR: 1.2 })).verdict).toBe("SKIP");
  });
  test("expiry day → SKIP", () => {
    expect(evaluateTradeGate(baseInput({ isExpiryDay: true })).verdict).toBe("SKIP");
  });
  test("event near → SKIP", () => {
    expect(evaluateTradeGate(baseInput({ eventNear: true })).verdict).toBe("SKIP");
  });
  test("3+ consecutive losses → SKIP", () => {
    expect(evaluateTradeGate(baseInput({ consecutiveLosses: 3 })).verdict).toBe("SKIP");
  });
  test("0 lots in budget → SKIP with guidance in formatted output", () => {
    const res = evaluateTradeGate(baseInput({ lots: 0 }));
    expect(res.verdict).toBe("SKIP");
    expect(formatGate(res)).toMatch(/lot/i);
  });
  test("target beyond VIX expected move → warn, not hard fail", () => {
    const res = evaluateTradeGate(baseInput({ targetPts: 250, expectedMovePts: 100 }));
    expect(res.verdict).toBe("TRADE");
    expect(res.checks.some((c) => c.status === "warn" && /expected move/i.test(c.detail))).toBe(true);
  });
  test("formatGate names failed checks", () => {
    const text = formatGate(evaluateTradeGate(baseInput({ delta: 0.2 })));
    expect(text).toMatch(/delta/i);
    expect(text).not.toMatch(/🎯/); // gate text itself carries no signal emoji
  });
});

describe("ledger stats", () => {
  const ledger = [
    { pnl: 100, direction: "CE", regime: "trending", window: "CAS_MORNING", strikeDistance: 0, confidence: 70 },
    { pnl: 100, direction: "CE", regime: "trending", window: "CAS_MORNING", strikeDistance: 0, confidence: 72 },
    { pnl: -100, direction: "PE", regime: "choppy", window: "CAS_AFTERNOON", strikeDistance: 2, confidence: 68 },
  ];
  test("bucketStats: wr vs breakeven from real avg win/loss", () => {
    const s = bucketStats(ledger.map((t) => ({ pnl: t.pnl })));
    expect(s.n).toBe(3);
    expect(s.wr).toBeCloseTo(2 / 3, 5);
    expect(s.breakevenWr).toBeCloseTo(0.5, 5);
    expect(s.edge).toBeGreaterThan(0);
  });
  test("wilson bounds contain the point estimate", () => {
    const w = wilson(7, 10);
    expect(w.lo).toBeLessThan(0.7);
    expect(w.hi).toBeGreaterThan(0.7);
  });
  test("ledgerBlocks vetoes losing buckets with >=30 trades", () => {
    const big = Array.from({ length: 40 }, (_, i) => ({ pnl: i < 12 ? 100 : -100, regime: "choppy", window: "CAS_AFTERNOON", strikeDistance: 0, confidence: 70, direction: "CE" }));
    const blocks = ledgerBlocks(big as any);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]).toMatch(/choppy/i);
  });
  test("ledgerReport is text + mentions buckets", () => {
    const text = ledgerReport(ledger as any);
    expect(text).toMatch(/trending/);
  });
  test("calibrateConfidence discounts stated confidence without history", () => {
    const c = calibrateConfidence(90);
    expect(c).toBeLessThan(90);
    expect(calibrateConfidence(70, { realizedHitPct: 60, n: 50 })).toBe(60);
  });
});

describe("newRunState / guardToolCall / wrapToolResult / enforceSignalPolicy", () => {
  test("detects trade intent (EN + Hinglish) and telegram intent", () => {
    expect(newRunState("should I buy NIFTY 24500 CE").intent).toMatch(/trade/);
    expect(newRunState("NIFTY kharidna chahiye?").intent).toMatch(/trade/);
    expect(newRunState("send this signal on telegram").intent).toMatch(/telegram/);
    expect(newRunState("what is PCR?").intent).toMatch(/query/);
  });
  test("blocks side-effect tools without intent", () => {
    const st = newRunState("what is PCR?");
    const g = guardToolCall("send_telegram_signal", {}, st, "");
    expect(g.allow).toBe(false);
    expect(g.reason).toBeTruthy();
  });
  test("allows telegram send when user asked to send", () => {
    const st = newRunState("send this on telegram");
    expect(guardToolCall("send_telegram_signal", {}, st, "").allow).toBe(true);
  });
  test("blocks SSRF on test_api_endpoint to non-local hosts", () => {
    const st = newRunState("test https://evil.example.com/x");
    const g = guardToolCall("test_api_endpoint", { url: "https://evil.example.com/x" }, st, "");
    expect(g.allow).toBe(false);
    expect(guardToolCall("test_api_endpoint", { url: "http://127.0.0.1:3000/api/x" }, st, "").allow).toBe(true);
  });
  test("set_breeze_session requires a token and never echoes it back", () => {
    const st = newRunState("set breeze session");
    expect(guardToolCall("set_breeze_session", {}, st, "").allow).toBe(false);
    const ok = guardToolCall("set_breeze_session", { token: "abc" }, st, "");
    expect(ok.allow).toBe(true);
    expect(JSON.stringify(ok)).not.toContain("abc");
  });
  test("read-only tools always allowed", () => {
    const st = newRunState("what is PCR?");
    expect(guardToolCall("get_option_chain", {}, st, "").allow).toBe(true);
    expect(guardToolCall("check_live_feed", {}, st, "").allow).toBe(true);
    expect(guardToolCall("ledger_edge_report", {}, st, "").allow).toBe(true);
  });
  test("wrapToolResult caps length", () => {
    expect(wrapToolResult("x", "y".repeat(10_000)).length).toBeLessThan(6500);
    expect(wrapToolResult("x", "short")).toBe("short");
  });
});

describe("selectToolsV2", () => {
  const TOOLS = [
    { function: { name: "get_sdm_signal", description: "" } },
    { function: { name: "get_option_chain", description: "" } },
    { function: { name: "get_market_structure", description: "" } },
    { function: { name: "get_fii_dii", description: "" } },
    { function: { name: "get_vix", description: "" } },
    { function: { name: "strike_selector", description: "" } },
    { function: { name: "hedge_calculator", description: "" } },
    { function: { name: "send_telegram_signal", description: "" } },
    { function: { name: "set_breeze_session", description: "" } },
    { function: { name: "morning_scan", description: "" } },
    { function: { name: "evaluate_trade_gate", description: "" } },
    { function: { name: "check_live_feed", description: "" } },
    { function: { name: "ledger_edge_report", description: "" } },
    { function: { name: "get_trade_journal", description: "" } },
    { function: { name: "get_portfolio", description: "" } },
    { function: { name: "get_news_sentiment", description: "" } },
  ];
  const names = (q: string) => selectToolsV2(q, TOOLS as any).map((t: any) => t.function.name);

  test("narrows by intent — no padding to a floor size", () => {
    const out = names("what is the India VIX right now?");
    expect(out).toContain("get_vix");
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.length).toBeLessThan(TOOLS.length);
  });
  test("Hinglish trade words select trade tools", () => {
    expect(names("NIFTY kharidna sahi rahega?")).toContain("strike_selector");
  });
  test("side-effect tools only on explicit intent", () => {
    expect(names("what is PCR?")).not.toContain("send_telegram_signal");
    expect(names("what is PCR?")).not.toContain("set_breeze_session");
    expect(names("send the trade signal on telegram")).toContain("send_telegram_signal");
  });
  test("trade question pulls the gate", () => {
    expect(names("should I buy BANKNIFTY CE")).toContain("evaluate_trade_gate");
  });
  test("never exceeds 12", () => {
    const out = names("buy kharid signal telegram session token scan hedge vix option chain sdm memory portfolio journal");
    expect(out.length).toBeLessThanOrEqual(12);
  });
});

describe("technical helpers", () => {
  const candles = Array.from({ length: 30 }, (_, i) => ({
    high: 100 + (i % 5), low: 95 + (i % 4), close: 98 + (i % 3),
  }));
  test("atr uses correct prev-candle indexing (positive, finite)", () => {
    const a = atr(candles, 14);
    expect(Number.isFinite(a)).toBe(true);
    expect(a).toBeGreaterThan(0);
  });
  test("vixBand labels are thresholds, not fake percentiles", () => {
    expect(vixBand(10).band).toBe("LOW");
    expect(vixBand(14).band).toBe("NORMAL");
    expect(vixBand(22).band).toBe("ELEVATED");
    expect(vixBand(35).band).toBe("EXTREME");
    expect(vixBand(22).text).not.toMatch(/percentile/i);
  });
  test("postMortem computes R from stop, flags discipline breaks", () => {
    const pm = postMortem({ entry: 100, exit: 130, stopPremium: 80, direction: "call", mfePremium: 140, stopMoved: true, averagedDown: false, enteredFirst15: true });
    expect(pm.rMultiple).toBeCloseTo(1.5, 2);
    expect(pm.learnings.join(" ")).toMatch(/stop/i);
  });
});

describe("otmSteps / journalRiskState / parseFeedHealth", () => {
  test("otmSteps counts steps OTM correctly per direction", () => {
    expect(otmSteps("call", 24600, 24500, "NIFTY")).toBe(2);   // 2 strikes OTM (NIFTY step 50)
    expect(otmSteps("call", 24500, 24500, "NIFTY")).toBe(0);   // ATM
    expect(otmSteps("put", 24400, 24500, "NIFTY")).toBe(2);
    expect(otmSteps("put", 24500, 24500, "NIFTY")).toBe(0);
    expect(otmSteps("call", 24700, 24500, "NIFTY")).toBe(4);   // deep OTM
  });
  test("journalRiskState counts trailing losses + today's P&L", () => {
    const today = new Date().toISOString().slice(0, 10);
    const trades = [
      { pnl: -500, closedAt: `${today}T10:00:00Z`, status: "closed" },
      { pnl: -300, closedAt: `${today}T11:00:00Z`, status: "closed" },
      { pnl: +400, closedAt: `${today}T09:00:00Z`, status: "closed" },
    ];
    const r = journalRiskState(trades as any);
    expect(r.consecutiveLosses).toBe(2);
    expect(r.dailyLossPct).toBeLessThan(0); // net -400 on 200k
  });
  test("parseFeedHealth reads meta.all_live + feed stamps", () => {
    const j = {
      meta: { all_live: true, overall: "LIVE", market_open: true, generated_at: nowIso() },
      feeds: { spot_vix: { status: "LIVE", last_update: nowIso() }, chain_NIFTY: { status: "LIVE", updated: nowIso() } },
    };
    const f = parseFeedHealth(j);
    expect(f.allLive).toBe(true);
    expect(f.stamps.length).toBeGreaterThan(0);
    expect(checkFreshness(f.stamps).ok).toBe(true);
    const down = parseFeedHealth({ meta: { all_live: false, overall: "DEGRADED", market_open: true }, feeds: {} });
    expect(down.allLive).toBe(false);
  });
});

describe("replay time override (asOfMs)", () => {
  const asOf = Date.parse("2026-07-15T10:00:00+05:30");
  test("checkFreshness evaluates stamps at asOf, not Date.now()", () => {
    const stamps = [new Date(asOf - 4 * 60_000).toISOString()]; // 4 min old AT that time
    expect(checkFreshness(stamps, 10, asOf).ok).toBe(true);
    expect(checkFreshness(stamps, 10).ok).toBe(false); // months old now
  });
  test("evaluateTradeGate passes freshness when asOfMs is inside the window", () => {
    const res = evaluateTradeGate(baseInput({
      asOfMs: asOf,
      stamps: [new Date(asOf - 5 * 60_000).toISOString()],
      allLive: true,
      delta: 0.5, optionRR: 2, lots: 1, strikeDistanceSteps: 1, underlyingRR: 2.5, targetPts: 100,
      layers: {
        flow: { state: "unknown", evidence: "e" }, structure: { state: "agree", evidence: "e" },
        levels: { state: "agree", evidence: "e" }, greeksVix: { state: "unknown", evidence: "e" },
        trigger: { state: "agree", evidence: "e" },
      },
    }));
    const feed = res.checks.find((c) => c.id === "feed")!;
    expect(feed.status).toBe("pass");
  });
  test("journalRiskState buckets daily pnl as of a historical day and ignores future trades", () => {
    const trades = [
      { status: "closed", closedAt: "2026-07-14T15:00:00+05:30", pnl: -9000 }, // prior day
      { status: "closed", closedAt: "2026-07-15T11:00:00+05:30", pnl: -5000 }, // the as-of day
      { status: "closed", closedAt: "2026-07-15T14:00:00+05:30", pnl: -6000 }, // the as-of day
      { status: "closed", closedAt: "2026-08-01T14:00:00+05:30", pnl: 99999 }, // AFTER asOf — must not leak
    ];
    const now = journalRiskState(trades);
    expect(now.dailyLossPct).toBe(0); // not "today" in real time
    const hist = journalRiskState(trades, asOf);
    expect(hist.dailyLossPct).toBeCloseTo((-11_000 / C.capital) * 100, 5);
    expect(hist.consecutiveLosses).toBe(3); // future win excluded, then 3 losses in a row
  });
});

describe("hybrid mode (old brain generates, new brain vetoes)", () => {
  test("soft fails become warnings and the verdict is TRADE", () => {
    const res = evaluateTradeGate(baseInput({
      hybrid: true,
      confidence: 55, // below floor → warn, not block
      layers: {
        flow: { state: "unknown", evidence: "no flow snapshot" },
        structure: { state: "agree", evidence: "HH/HL" },
        levels: { state: "agree", evidence: "PE wall" },
        greeksVix: { state: "unknown", evidence: "no VIX snapshot" },
        trigger: { state: "unknown", evidence: "no trigger read" },
      },
    }));
    expect(res.verdict).toBe("TRADE");
    expect(res.checks.find((c) => c.id === "confidence")!.status).toBe("pass");
    expect(res.checks.find((c) => c.id === "layers")!.status).toBe("warn");
    expect(res.warnings!.join(" ")).toMatch(/layers/i);
  });
  test("hard safety fails still block in hybrid mode", () => {
    const res = evaluateTradeGate(baseInput({ hybrid: true, optionRR: 1.0 }));
    expect(res.verdict).toBe("SKIP");
    expect(res.checks.find((c) => c.id === "option_rr")!.status).toBe("fail");
  });
  test("unknown underlying R:R is a warning in hybrid mode, a known bad one blocks", () => {
    const unknown = evaluateTradeGate(baseInput({ hybrid: true, underlyingRR: undefined }));
    expect(unknown.verdict).toBe("TRADE");
    expect(unknown.checks.find((c) => c.id === "underlying_rr")!.status).toBe("warn");
    const bad = evaluateTradeGate(baseInput({ hybrid: true, underlyingRR: 1.1 }));
    expect(bad.verdict).toBe("SKIP");
    expect(bad.checks.find((c) => c.id === "underlying_rr")!.status).toBe("fail");
  });
  test("strict mode is unchanged — soft fails still skip", () => {
    const res = evaluateTradeGate(baseInput({ confidence: 55 }));
    expect(res.verdict).toBe("TRADE");
  });

  test("strict mode still skips on a genuine soft fail (layers below 3-of-5)", () => {
    const res = evaluateTradeGate(baseInput({ confidence: 72, layers: layersOver(2) }));
    expect(res.verdict).toBe("SKIP");
  });
});
