// tests/discipline-wiring.test.ts
//
// Source-contract tests (same pattern as tests/safety-guards.test.ts): the
// account-level risk caps and the discipline veto must be enforced on EVERY
// alert producer — including the two paths that send via telegramSend
// directly instead of the sendTradeAlert funnel.
//
// Evidence (trade-audit ledger, 353 closed OPTION trades): entries after
// 13:00 IST won 16% of 119 trades (−₹7.2L); the veto's BLOCK bucket was
// dominated by exactly these scanners' rows. A producer that bypasses the
// funnel bypasses the day-loss cap too — "a blown day must not produce
// another trade from any brain" (signal-veto.ts §0).
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";

const read = (p: string) => readFileSync(p, "utf-8");

describe("discipline wiring — every producer obeys the caps + veto", () => {
  test("the intraday direct-send path checks risk caps BEFORE alerting", () => {
    const src = read("src/lib/sendIntradayAlerts.ts");
    expect(src).toContain("checkSignalRiskLimits");
    // the check must run before the send call in the new-entry loop
    const loopIdx = src.indexOf("for (const c of topCandidates)");
    const riskIdx = src.indexOf("checkSignalRiskLimits", loopIdx);
    const sendIdx = src.indexOf("sendTelegramMessage(chatId", loopIdx);
    expect(riskIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(riskIdx);
  });

  test("the intraday path runs the discipline veto and logs blocked candidates", () => {
    const src = read("src/lib/sendIntradayAlerts.ts");
    expect(src).toContain("evaluateSignalVeto");
    expect(src).toContain("logCandidate");
    expect(src).toContain("wouldBlock: true");
  });

  test("a WARN verdict annotates the alert (halve size), never silently passes", () => {
    const src = read("src/lib/sendIntradayAlerts.ts");
    expect(src).toContain("halve size");
  });

  test("the BTST path enforces the account caps (its option gates stay exempt by design)", () => {
    const src = read("src/app/api/btst/route.ts");
    expect(src).toContain("checkSignalRiskLimits");
    // blocked candidates are logged to the candidate ledger, not just skipped
    expect(src).toContain("logCandidate");
    // the response reports how many were risk-blocked (observable, not silent)
    expect(src).toContain("riskBlocked");
  });

  test("exit notifications (SL/TP hits) are NOT vetoed — the veto gates ENTRIES only", () => {
    const src = read("src/lib/sendIntradayAlerts.ts");
    // the SL/TP hit loops must send directly (they are lifecycle events on
    // already-registered trades, not new candidates)
    const exitLoop = src.indexOf('formatSLTPHit(trade, "SL")');
    const riskInExit = src.indexOf("checkSignalRiskLimits", exitLoop - 200);
    // no risk check may sit between the SL-hit loop and its send
    const exitSend = src.indexOf("sendTelegramMessage(chatId", exitLoop);
    expect(exitSend).toBeGreaterThan(-1);
    expect(riskInExit === -1 || riskInExit > exitSend).toBe(true);
  });

  test("the register funnel never invents a stop", () => {
    const src = read("src/app/api/trade/register/route.ts");
    // the CODE must not carry the fabricated default (the comment documenting
    // the old bug may mention it)
    expect(src).not.toContain("Number(sl) || Number(entry) * 0.78");
    expect(src).toContain("no invented stop");
  });

  test("ZeroHero registration failures are surfaced (no silent .catch on the fetch)", () => {
    const src = read("src/components/terminal/ZeroHeroTerminal.tsx");
    // the register call logs failures instead of swallowing them
    expect(src).toContain("registration(s) FAILED");
    expect(src).toContain('body?.error ?? res.statusText');
  });
});
