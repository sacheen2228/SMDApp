import { describe, test, expect } from "bun:test";
import { formatSLTPHit } from "@/lib/activeTradeTracker";

const trade = (over: any = {}) => ({
  id: "t1", symbol: "SBIN", side: "BUY" as const, instrument: "SBIN 970 PE",
  strike: 970, optionType: "PE", entry: 8.5, sl: 10.2, tp1: 5.1, tp2: 3.4, tp3: 1.7,
  status: "ACTIVE", sentAt: new Date().toISOString(), source: "stock-scanner",
  exchange: "NFO", ...over,
});

describe("TP/SL P&L math", () => {
  test("loss % is per-unit (not the lot-multiplied rupee P&L over the per-unit entry)", () => {
    const msg = formatSLTPHit(trade() as any, "SL");
    // entry 8.50, SL 10.20 → 20% loss on the premium (was 1300%)
    expect(msg).toContain("Loss: ₹");
    expect(msg).not.toContain("1300.0%");
    expect(msg).toMatch(/\(20\.0%\)/);
  });

  test("gain % is per-unit too", () => {
    const msg = formatSLTPHit(trade({ optionType: "CE", sl: 7.0, tp1: 11.0 } as any), "TP1");
    expect(msg).toMatch(/\(29\.4%\)/);   // (11.0 - 8.5) / 8.5
  });
});

describe("option R:R in the stock-option alert", () => {
  test("R:R comes from the OPTION levels, not the underlying stock's R:R", async () => {
    const { formatStockOptionAlert } = await import("@/lib/sendIntradayAlerts");
    // the option plan: entry 8.50, SL 10.20 (PE), TP1 5.10 → R:R = 3.40 / 1.70 = 2.0
    const msg = formatStockOptionAlert(
      { symbol: "SBIN", riskReward: 39.4, totalScore: 62, reasons: ["HVNREJECTIONBEARISH"] },
      { optionType: "PE", strike: 970, premium: 8.5, stopLoss: 10.2, targets: [5.1, 3.4, 1.7], expiryLabel: "27-Oct-2026" },
    );
    expect(msg).toContain("R:R 1:2.0");
    expect(msg).not.toContain("1:39.4");
  });

  test("a CE uses entry − stop as the risk and TP1 − entry as the reward", async () => {
    const { formatStockOptionAlert } = await import("@/lib/sendIntradayAlerts");
    const msg = formatStockOptionAlert(
      { symbol: "HCLTECH", riskReward: 1.9, totalScore: 65, reasons: ["PREVLOWSWEEP"] },
      { optionType: "CE", strike: 1380, premium: 18.8, stopLoss: 15.05, targets: [26.3, 30.1, 33.85], expiryLabel: "27-Oct-2026" },
    );
    expect(msg).toContain("R:R 1:2.0");   // 7.50 reward / 3.75 risk
  });
});
