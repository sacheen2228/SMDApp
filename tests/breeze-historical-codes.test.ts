import { describe, test, expect } from "bun:test";
import { buildIntradayRequest } from "@/lib/breeze-historical";

// Breeze's getHistoricalDatav2 wants ICICI scrip codes, not exchange symbols:
// plain "FINNIFTY"/"SENSEX" return zero rows (same class of bug as
// scrip-master: RELIANCE → RELIND). Every other production path already uses
// INDEX_BREEZE_CODES — this test pins the historical module to it, because the
// candle chain (capture, tech-cache, indicators) reads through here.
describe("breeze-historical index request mapping", () => {
  test("maps each index to Breeze's own scrip code + cash exchange", () => {
    const cases: [string, string, string][] = [
      ["NIFTY", "NIFTY", "NSE"],
      ["BANKNIFTY", "CNXBAN", "NSE"],
      ["FINNIFTY", "NIFFIN", "NSE"],
      ["MIDCPNIFTY", "NIFMID", "NSE"],
      ["SENSEX", "BSESEN", "BSE"],
      ["BANKEX", "BSESEN", "BSE"],
    ];
    for (const [sym, code, exch] of cases) {
      const req = buildIntradayRequest(sym, "2026-11-09", "1minute");
      expect(req, `${sym} request`).not.toBeNull();
      expect(req!.stockCode, `${sym} stockCode`).toBe(code);
      expect(req!.exchangeCode, `${sym} exchangeCode`).toBe(exch);
      expect(req!.productType, `${sym} productType`).toBe("cash");
    }
  });

  test("index requests are cash spot bars with no option legs", () => {
    const req = buildIntradayRequest("FINNIFTY", "2026-11-09", "5minute")!;
    expect(req.expiryDate).toBeUndefined();
    expect(req.right).toBeUndefined();
    expect(req.strikePrice).toBeUndefined();
    expect(req.fromDate).toContain("09:15:00");
    expect(req.toDate).toContain("15:30:00");
    expect(req.interval).toBe("5minute");
  });

  test("symbol lookup is case-insensitive and rejects unknown symbols", () => {
    expect(buildIntradayRequest("finnifty", "2026-11-09", "1minute")!.stockCode).toBe("NIFFIN");
    expect(buildIntradayRequest("RELIANCE", "2026-11-09", "5minute")).toBeNull();
  });
});
