// scanner-data-quality.test.ts — D-7: 6-state data quality (LIVE/DELAYED/STALE/PARTIAL/CLOSED/ERROR)
//
// The scanner's dataQuality must reflect:
//   - Exchange session (open/closed/pre/post)
//   - Provider timestamp age vs thresholds
//   - Missing data sources (PARTIAL)
//   - Provider errors (ERROR)
//   - Holiday/weekend awareness (CLOSED)
import { describe, test, expect } from "bun:test";
import { classifyScannerDataQuality, type DataQualityInput } from "@/lib/scanner-data-quality";

describe("scanner data quality: 6-state classifier", () => {
  const baseInput: DataQualityInput = {
    chain: { ok: true, ageMs: 30_000, source: "nse" },
    quotes: { ok: true, ageMs: 20_000, source: "nse" },
    daily: { ok: true, count: 50 },
    clock: { isOpen: true, marketState: "Open", tradeDate: new Date().toISOString(), tradeAgeMs: 10_000 },
    errors: [],
  };

  test("LIVE: market open, all sources fresh (< thresholds)", () => {
    const q = classifyScannerDataQuality(baseInput);
    expect(q).toBe("LIVE");
  });

  test("DELAYED: market open, chain fresh but quotes slightly old (DELAYED threshold)", () => {
    const q = classifyScannerDataQuality({ ...baseInput, quotes: { ...baseInput.quotes, ageMs: 200_000 } });
    expect(q).toBe("DELAYED");
  });

  test("STALE: market open, chain age exceeds STALE threshold", () => {
    const q = classifyScannerDataQuality({ ...baseInput, chain: { ...baseInput.chain, ageMs: 700_000 } });
    expect(q).toBe("STALE");
  });

  test("PARTIAL: market open, one source missing (quotes unavailable)", () => {
    const q = classifyScannerDataQuality({ ...baseInput, quotes: { ok: false, ageMs: null, source: "none" } });
    expect(q).toBe("PARTIAL");
  });

  test("CLOSED: market closed (isOpen=false), all sources present but from last session", () => {
    const closedClock = { isOpen: false, marketState: "Close", tradeDate: new Date(Date.now() - 24*3600_000).toISOString(), tradeAgeMs: 24*3600_000 };
    const q = classifyScannerDataQuality({ ...baseInput, clock: closedClock });
    expect(q).toBe("CLOSED");
  });

  test("ERROR: provider exception recorded", () => {
    const q = classifyScannerDataQuality({ ...baseInput, errors: ["NSE timeout"] });
    expect(q).toBe("ERROR");
  });

  test("PARTIAL + CLOSED: market closed with missing source → CLOSED (session trumps)", () => {
    const closedClock = { isOpen: false, marketState: "Close", tradeDate: new Date().toISOString(), tradeAgeMs: 100_000 };
    const q = classifyScannerDataQuality({ ...baseInput, clock: closedClock, quotes: { ok: false, ageMs: null, source: "none" } });
    expect(q).toBe("CLOSED");
  });

  test("ERROR trumps all: provider error even with fresh data", () => {
    const q = classifyScannerDataQuality({ ...baseInput, errors: ["Breeze auth failed"] });
    expect(q).toBe("ERROR");
  });
});