// tests/discipline-wiring.test.ts
//
// Source-contract tests: the account-level risk caps must be enforced on the
// ONE central alert funnel (sendTradeAlert in src/lib/telegram.ts) that every
// producer — scanners, SDM, Zero Hero, BTST, the intraday cron — flows through.
//
// The discipline veto (src/lib/signal-veto.ts) was REMOVED at the user's
// direction; these tests pin what still stands after that removal:
//   • option SELL/SHORT is never alerted as a buy-path candidate
//   • the day-loss + concurrent-exposure caps (checkSignalRiskLimits) run
//     BEFORE any send, in both the gate helper and the send path
//   • every candidate that reaches the send stage is logged to candidate_log
//   • SL/TP notifications are lifecycle events on registered trades — they
//     bypass the entry gates by design
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";

const read = (p: string) => readFileSync(p, "utf-8");

describe("discipline wiring — every producer obeys the caps via the funnel", () => {
  test("the intraday cron path flows through the sendTradeAlert funnel", () => {
    const src = read("src/lib/sendIntradayAlerts.ts");
    expect(src).toContain('from "@/lib/telegram"');
    expect(src).toContain("evaluateTradeGate");
    expect(src).toContain("sendTradeAlert");
  });

  test("the funnel blocks option SELL/SHORT (instrument-aware)", () => {
    const src = read("src/lib/telegram.ts");
    expect(src).toContain("option selling not allowed");
  });

  test("the funnel checks the account risk caps BEFORE sending", () => {
    const src = read("src/lib/telegram.ts");
    expect(src).toContain("checkSignalRiskLimits");
    // in sendTradeAlertInner the risk block must precede the send call
    const sendIdx = src.indexOf("sent = await sendTelegramMessage(msg)");
    const riskIdx = src.indexOf("checkSignalRiskLimits({");
    expect(riskIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(riskIdx);
  });

  test("the funnel logs every candidate that reaches the send stage", () => {
    const src = read("src/lib/telegram.ts");
    expect(src).toContain("logCandidate(");
  });

  test("SL/TP hits are lifecycle events — detected on registered trades, not gated as entries", () => {
    const src = read("src/lib/sendIntradayAlerts.ts");
    expect(src).toContain("checkSLTP");
  });
});
