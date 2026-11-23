import { describe, it, expect } from "bun:test";
import * as hist from "@/lib/breeze-historical";

const buildFutures: any = (hist as any).buildFuturesIntradayRequest;

describe("buildFuturesIntradayRequest", () => {
  it("builds an NFO futures request with the IST session window", () => {
    expect(typeof buildFutures).toBe("function");

    const req = buildFutures("NIFTY", "2026-11-23", "2026-11-20");

    expect(req).not.toBeNull();
    expect(req.stockCode).toBe("NIFTY");
    expect(req.exchangeCode).toBe("NFO");
    expect(req.productType).toBe("futures");
    expect(req.right).toBe("none");
    expect(req.expiryDate).toBe("2026-11-23");
    expect(req.fromDate).toBe("2026-11-20 09:15:00");
    expect(req.toDate).toBe("2026-11-20 15:30:00");
    expect(req.interval).toBe("5minute");
  });

  it("uses the BFO segment and BSESEN scrip code for SENSEX", () => {
    const req = buildFutures("SENSEX", "2026-11-26", "2026-11-20");
    expect(req.exchangeCode).toBe("BFO");
    expect(req.stockCode).toBe("BSESEN");
  });

  it("uses the ICICI scrip codes for BANKNIFTY and FINNIFTY futures", () => {
    expect(buildFutures("BANKNIFTY", "2026-11-23", "2026-11-20").stockCode).toBe("CNXBAN");
    expect(buildFutures("FINNIFTY", "2026-11-23", "2026-11-20").stockCode).toBe("NIFFIN");
  });

  it("normalizes a DD-MMM-YYYY expiry to the ISO form Breeze accepts", () => {
    const req = buildFutures("NIFTY", "23-Nov-2026", "2026-11-20");
    expect(req.expiryDate).toBe("2026-11-23");
  });

  it("rejects an unparseable expiry or session date", () => {
    expect(buildFutures("NIFTY", "not-a-date", "2026-11-20")).toBeNull();
    expect(buildFutures("NIFTY", "2026-11-23", "not-a-date")).toBeNull();
  });
});
