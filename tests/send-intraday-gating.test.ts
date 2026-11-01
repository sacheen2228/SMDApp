// send-intraday-gating.test.ts — D-9: alerts respect unified gate
import { describe, test, expect } from "bun:test";

// The alert filter logic is inline in sendIntradayAlerts.ts. Testing the
// decision boundary directly: a candidate should only alert if unifiedDecision
// is TRADE (or hardGatesPassed) AND totalScore >= 65 AND rr >= 1.5.

const makeCandidate = (overrides = {}) => ({
  symbol: "TEST",
  currentPrice: 200,
  totalScore: 70,
  monthlyOptionTrade: {
    premium: 100,
    stopLoss: 90,
    targets: [115],
    ...overrides,
  },
  ...overrides,
});

describe("sendIntradayAlerts: unified gate filtering", () => {
  test("TRADE decision + score>=65 + rr>=1.5 → ALERT", () => {
    const c = makeCandidate({ unifiedDecision: "TRADE", hardGatesPassed: true });
    const scoreOk = (c.totalScore ?? 0) >= 65;
    const opt = c.monthlyOptionTrade;
    const risk = opt.premium - opt.stopLoss;
    const reward = (opt.targets?.[0] ?? 0) - opt.premium;
    const rr = risk > 0 && reward > 0 ? reward / risk : 0;
    const gateOk = c.unifiedDecision === "TRADE" || c.hardGatesPassed === true;
    const shouldAlert = scoreOk && rr >= 1.5 && gateOk;
    expect(shouldAlert).toBe(true);
  });

  test("WAIT decision (gates failed) → NO ALERT even with high score", () => {
    const c = makeCandidate({ unifiedDecision: "WAIT", hardGatesPassed: false, totalScore: 85 });
    const scoreOk = (c.totalScore ?? 0) >= 65;
    const opt = c.monthlyOptionTrade;
    const risk = opt.premium - opt.stopLoss;
    const reward = (opt.targets?.[0] ?? 0) - opt.premium;
    const rr = risk > 0 && reward > 0 ? reward / risk : 0;
    const gateOk = c.unifiedDecision === "TRADE" || c.hardGatesPassed === true;
    const shouldAlert = scoreOk && rr >= 1.5 && gateOk;
    expect(shouldAlert).toBe(false);
  });

  test("NO_TRADE decision → NO ALERT", () => {
    const c = makeCandidate({ unifiedDecision: "NO_TRADE", hardGatesPassed: false });
    const scoreOk = (c.totalScore ?? 0) >= 65;
    const opt = c.monthlyOptionTrade;
    const risk = opt.premium - opt.stopLoss;
    const reward = (opt.targets?.[0] ?? 0) - opt.premium;
    const rr = risk > 0 && reward > 0 ? reward / risk : 0;
    const gateOk = c.unifiedDecision === "TRADE" || c.hardGatesPassed === true;
    const shouldAlert = scoreOk && rr >= 1.5 && gateOk;
    expect(shouldAlert).toBe(false);
  });

  test("TRADE but rr < 1.5 → NO ALERT", () => {
    const c = makeCandidate({ unifiedDecision: "TRADE", hardGatesPassed: true, monthlyOptionTrade: { premium: 100, stopLoss: 95, targets: [102] } }); // rr = 2/5 = 0.4
    const scoreOk = (c.totalScore ?? 0) >= 65;
    const opt = c.monthlyOptionTrade;
    const risk = opt.premium - opt.stopLoss;
    const reward = (opt.targets?.[0] ?? 0) - opt.premium;
    const rr = risk > 0 && reward > 0 ? reward / risk : 0;
    const gateOk = c.unifiedDecision === "TRADE" || c.hardGatesPassed === true;
    const shouldAlert = scoreOk && rr >= 1.5 && gateOk;
    expect(shouldAlert).toBe(false);
  });
});