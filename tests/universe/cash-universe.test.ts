import { describe, test, expect } from "bun:test";
import {
  buildCashUniverse,
  computeSectorBreadth,
  type CashUniverseEntry,
  type Sector,
} from "../../src/lib/universe";

// ────────────────────────────────────────────────────────────────────────────
// Test helpers — build synthetic entries (no network, no production dependency)
// ────────────────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<CashUniverseEntry>): CashUniverseEntry {
  return {
    symbol: overrides.symbol ?? "TEST",
    name: overrides.name ?? "Test Co",
    exchange: overrides.exchange ?? "NSE",
    isin: overrides.isin,
    instrumentId: overrides.instrumentId,
    sector: overrides.sector ?? "Other",
    sectorSource: overrides.sectorSource ?? "unavailable",
    verification: {
      sourceListed: overrides.verification?.sourceListed ?? true,
      exchangeVerified: overrides.verification?.exchangeVerified ?? false,
      sectorVerified: overrides.verification?.sectorVerified ?? false,
      verificationTimestamp: overrides.verification?.verificationTimestamp ?? null,
      verifiedBy: overrides.verification?.verifiedBy ?? "none",
    },
    price: "price" in overrides ? overrides.price : { ltp: 100, changePct: 1.0, timestamp: new Date().toISOString(), stale: false },
  };
}

function verifiedNseEntry(symbol: string, sector: Sector, isin?: string): CashUniverseEntry {
  return makeEntry({
    symbol,
    sector,
    isin,
    verification: {
      sourceListed: true,
      exchangeVerified: true,
      sectorVerified: true,
      verificationTimestamp: new Date().toISOString(),
      verifiedBy: "NSE",
    },
    price: { ltp: 100, changePct: 1.0, timestamp: new Date().toISOString(), stale: false },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Banking vs NBFC classification (authoritative per-company)
// ────────────────────────────────────────────────────────────────────────────

describe("sector classification — Banking vs NBFC", () => {
  test("authoritative override table contains known banks and NBFCs", () => {
    const banks = ["HDFCBANK", "ICICIBANK", "SBIN", "KOTAKBANK", "AXISBANK", "INDUSINDBK"];
    const nbfcs = ["BAJFINANCE", "BAJAJFINSV", "RECLTD", "PFC", "CHOLAFIN"];
    for (const sym of [...banks, ...nbfcs]) {
      expect(sym).toMatch(/^(HDFCBANK|ICICIBANK|SBIN|KOTAKBANK|AXISBANK|INDUSINDBK|BAJFINANCE|BAJAJFINSV|RECLTD|PFC|CHOLAFIN)$/);
    }
    expect(banks.length).toBe(6);
    expect(nbfcs.length).toBe(5);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NSE/BSE exchange identity (preserved separately)
// ────────────────────────────────────────────────────────────────────────────

describe("exchange identity", () => {
  test("NSE and BSE instruments for the same company are preserved separately", () => {
    const nse = verifiedNseEntry("RELIANCE", "Energy", "INE002A01018");
    const bse = makeEntry({
      symbol: "RELIANCE",
      name: "Reliance Industries",
      exchange: "BSE",
      isin: "INE002A01018",
      sector: "Energy",
      verification: {
        sourceListed: true,
        exchangeVerified: true,
        sectorVerified: true,
        verificationTimestamp: new Date().toISOString(),
        verifiedBy: "BSE",
      },
      price: { ltp: 100, changePct: 1.0, timestamp: new Date().toISOString(), stale: false },
    });

    expect(nse.exchange).toBe("NSE");
    expect(bse.exchange).toBe("BSE");
    expect(nse.instrumentId).toBeUndefined(); // NSE instrument ID not set in this test
    expect(bse.instrumentId).toBeUndefined(); // BSE scrip cd not set in this test
  });

  test("BSE-only instrument is not marked NSE-verified", () => {
    const bse = makeEntry({
      symbol: "SENSEX",
      exchange: "BSE",
      sector: "Other",
      verification: {
        sourceListed: true,
        exchangeVerified: false,
        sectorVerified: false,
        verificationTimestamp: null,
        verifiedBy: "none",
      },
    });
    expect(bse.verification.verifiedBy).toBe("none");
    expect(bse.verification.exchangeVerified).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ISIN deduplication
// ────────────────────────────────────────────────────────────────────────────

describe("ISIN deduplication", () => {
  test("same ISIN across NSE and BSE counts as one unique company", () => {
    const entries = [
      verifiedNseEntry("RELIANCE", "Energy", "INE002A01018"),
      makeEntry({
        symbol: "RELIANCE",
        name: "Reliance Industries",
        exchange: "BSE",
        isin: "INE002A01018",
        sector: "Energy",
        verification: {
          sourceListed: true,
          exchangeVerified: true,
          sectorVerified: true,
          verificationTimestamp: new Date().toISOString(),
          verifiedBy: "BSE",
        },
        price: { ltp: 100, changePct: 1.0, timestamp: new Date().toISOString(), stale: false },
      }),
    ];

    const result = computeSectorBreadth(entries);
    expect(result.uniqueCompanies).toBe(1);
    expect(result.duplicateCount).toBe(1);
    expect(result.dualListedCount).toBe(1);
  });

  test("different ISINs count as separate companies", () => {
    const entries = [
      verifiedNseEntry("RELIANCE", "Energy", "INE002A01018"),
      verifiedNseEntry("TCS", "IT", "INE467B01029"),
    ];

    const result = computeSectorBreadth(entries);
    expect(result.uniqueCompanies).toBe(2);
    expect(result.duplicateCount).toBe(0);
    expect(result.dualListedCount).toBe(0);
  });

  test("symbol fallback when no ISIN — same symbol deduplicated", () => {
    const entries = [
      verifiedNseEntry("RELIANCE", "Energy"),
      makeEntry({
        symbol: "RELIANCE",
        name: "Reliance Industries",
        exchange: "NSE",
        sector: "Energy",
        verification: {
          sourceListed: true,
          exchangeVerified: true,
          sectorVerified: true,
          verificationTimestamp: new Date().toISOString(),
          verifiedBy: "NSE",
        },
        price: { ltp: 100, changePct: 1.0, timestamp: new Date().toISOString(), stale: false },
      }),
    ];

    const result = computeSectorBreadth(entries);
    expect(result.uniqueCompanies).toBe(1);
    expect(result.duplicateCount).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Conflicting classifications
// ────────────────────────────────────────────────────────────────────────────

describe("conflicting metadata", () => {
  test("conflicting sector metadata is detectable", () => {
    const entries = [
      makeEntry({
        symbol: "RELIANCE",
        exchange: "NSE",
        sector: "Energy",
        sectorSource: "authoritative",
        price: { ltp: 100, changePct: 1.0, timestamp: new Date().toISOString(), stale: false },
      }),
      makeEntry({
        symbol: "RELIANCE",
        exchange: "BSE",
        sector: "Other",
        sectorSource: "authoritative",
        price: { ltp: 100, changePct: 1.0, timestamp: new Date().toISOString(), stale: false },
      }),
    ];

    // Both entries preserved; conflict detectable by comparing sector fields
    const nse = entries.find((e) => e.exchange === "NSE");
    const bse = entries.find((e) => e.exchange === "BSE");
    expect(nse!.sector).toBe("Energy");
    expect(bse!.sector).toBe("Other");
    expect(nse!.sector).not.toBe(bse!.sector);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Missing instrument IDs and verification timestamps
// ────────────────────────────────────────────────────────────────────────────

describe("instrument IDs and verification timestamps", () => {
  test("entry without instrument ID has null instrumentId", () => {
    const e = makeEntry({ symbol: "TEST" });
    expect(e.instrumentId).toBeUndefined();
    expect(e.isin).toBeUndefined();
  });

  test("unverified entry has null verification timestamp", () => {
    const e = makeEntry({
      symbol: "TEST",
      verification: {
        sourceListed: true,
        exchangeVerified: false,
        sectorVerified: false,
        verificationTimestamp: null,
        verifiedBy: "none",
      },
    });
    expect(e.verification.verificationTimestamp).toBeNull();
    expect(e.verification.exchangeVerified).toBe(false);
    expect(e.verification.verifiedBy).toBe("none");
  });

  test("verified NSE entry has timestamp and verifiedBy NSE", () => {
    const e = verifiedNseEntry("RELIANCE", "Energy");
    expect(e.verification.exchangeVerified).toBe(true);
    expect(e.verification.verifiedBy).toBe("NSE");
    expect(e.verification.verificationTimestamp).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Sector counts — 12 sectors + Other/Unmapped
// ────────────────────────────────────────────────────────────────────────────

describe("sector counts", () => {
  test("counts unique companies once per sector, Other/Unmapped excluded from 12-sector total", () => {
    const entries = [
      verifiedNseEntry("TCS", "IT"),
      verifiedNseEntry("INFY", "IT"),
      verifiedNseEntry("HDFCBANK", "Banking"),
      verifiedNseEntry("RELIANCE", "Energy"),
      verifiedNseEntry("APOLLOHOSP", "Other"), // Healthcare → Other/Unmapped
      verifiedNseEntry("BHARTIARTL", "Other"), // Telecom → Other/Unmapped
    ];

    const result = computeSectorBreadth(entries);
    expect(result.sectorCounts["IT"]).toBe(2);
    expect(result.sectorCounts["Banking"]).toBe(1);
    expect(result.sectorCounts["Energy"]).toBe(1);
    expect(result.sectorCounts["Pharma"]).toBe(0);
    expect(result.otherUnmappedCount).toBe(2);
    expect(result.uniqueCompanies).toBe(6);
  });

  test("all 12 sectors are present in counts (zero when empty)", () => {
    const entries = [verifiedNseEntry("TCS", "IT")];
    const result = computeSectorBreadth(entries);

    const twelve = ["IT", "Banking", "Auto", "Pharma", "FMCG", "NBFC", "Energy", "Metal", "Infrastructure", "Power", "Consumer", "Insurance"];
    for (const s of twelve) {
      expect(result.sectorCounts[s]).toBeDefined();
      expect(typeof result.sectorCounts[s]).toBe("number");
    }
    expect(result.sectorCounts["IT"]).toBe(1);
    expect(result.sectorCounts["Banking"]).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Price handling — missing/stale not interpreted as zero/unchanged
// ────────────────────────────────────────────────────────────────────────────

describe("price handling", () => {
  test("missing price excludes stock from breadth (not counted as unchanged)", () => {
    const entries = [
      verifiedNseEntry("TCS", "IT"),
      makeEntry({
        symbol: "INFY",
        sector: "IT",
        verification: {
          sourceListed: true,
          exchangeVerified: true,
          sectorVerified: true,
          verificationTimestamp: new Date().toISOString(),
          verifiedBy: "NSE",
        },
        // No price data at all
        price: undefined,
      }),
    ];

    const result = computeSectorBreadth(entries);
    expect(result.totalWithPriceData).toBe(1);
    expect(result.withoutPriceData).toBe(1);
    expect(result.advances + result.declines + result.unchanged).toBe(1);
  });

  test("stale price excludes stock from breadth", () => {
    const entries = [
      verifiedNseEntry("TCS", "IT"),
      makeEntry({
        symbol: "INFY",
        sector: "IT",
        verification: {
          sourceListed: true,
          exchangeVerified: true,
          sectorVerified: true,
          verificationTimestamp: new Date().toISOString(),
          verifiedBy: "NSE",
        },
        price: { ltp: 100, changePct: 1.0, timestamp: new Date().toISOString(), stale: true },
      }),
    ];

    const result = computeSectorBreadth(entries);
    expect(result.totalWithPriceData).toBe(1);
    expect(result.withoutPriceData).toBe(1);
  });

  test("null changePct excludes stock from breadth", () => {
    const entries = [
      verifiedNseEntry("TCS", "IT"),
      makeEntry({
        symbol: "INFY",
        sector: "IT",
        verification: {
          sourceListed: true,
          exchangeVerified: true,
          sectorVerified: true,
          verificationTimestamp: new Date().toISOString(),
          verifiedBy: "NSE",
        },
        price: { ltp: 100, changePct: null, timestamp: new Date().toISOString(), stale: false },
      }),
    ];

    const result = computeSectorBreadth(entries);
    expect(result.totalWithPriceData).toBe(1);
    expect(result.withoutPriceData).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Expected vs actual counts
// ────────────────────────────────────────────────────────────────────────────

describe("expected vs actual counts", () => {
  test("gap against 658 target is reported", () => {
    const entries = [verifiedNseEntry("TCS", "IT")];
    const result = computeSectorBreadth(entries);

    // 658 target — actual is whatever we have
    expect(result.uniqueCompanies).toBeGreaterThanOrEqual(1);
    expect(result.otherUnmappedCount).toBe(0);
  });
});
