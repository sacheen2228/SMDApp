import { describe, it, expect } from "bun:test";
import { dataSourceBadge } from "@/lib/data-source-label";

describe("dataSourceBadge", () => {
  it("maps live exchange/broker sources to their friendly display names", () => {
    const cases: Array<[string, string]> = [
      ["nse-api", "NSE"],
      ["bse-api", "BSE"],
      ["motilal-api", "MO"],
      ["icici-breeze", "Breeze"],
      ["NSE", "NSE"],
      ["BSE", "BSE"],
      ["MO", "MO"],
    ];
    for (const [input, display] of cases) {
      const b = dataSourceBadge(input);
      expect(b.display).toBe(display);
    }
  });

  it("claims LIVE only when the exchange-aware freshness label says LIVE", () => {
    for (const input of ["nse-api", "bse-api", "motilal-api", "icici-breeze"]) {
      const live = dataSourceBadge(input, "LIVE");
      expect(live.label).toBe("LIVE");
      expect(live.isLive).toBe(true);
    }
  });

  it("does NOT claim LIVE from the provider name alone", () => {
    // A provider name is not a freshness claim — the same provider serves a
    // closed-market snapshot. Without a freshness label the badge shows the
    // provider only and never asserts LIVE.
    const b = dataSourceBadge("nse-api");
    expect(b.label).not.toBe("LIVE");
    expect(b.isLive).toBe(false);
    expect(b.display).toBe("NSE");
  });

  it("shows the freshness label for non-live data", () => {
    const stale = dataSourceBadge("nse-api", "STALE");
    expect(stale.label).toBe("STALE");
    expect(stale.isLive).toBe(false);
    expect(stale.display).toContain("STALE");

    const fresh = dataSourceBadge("nse-api", "FRESH");
    expect(fresh.label).toBe("FRESH");
    expect(fresh.isLive).toBe(false);
  });

  it("maps NO_DATA / empty to NO DATA", () => {
    for (const input of ["NO_DATA", "", null, undefined]) {
      const b = dataSourceBadge(input);
      expect(b.label).toBe("NO DATA");
      expect(b.display).toBe("NO DATA");
      expect(b.isLive).toBe(false);
    }
  });

  it("maps simulation to DEMO", () => {
    const b = dataSourceBadge("simulation");
    expect(b.label).toBe("DEMO");
    expect(b.display).toBe("DEMO");
    expect(b.isLive).toBe(false);
  });

  it("never renders Yahoo for live sources; unknown sources shown as-is", () => {
    expect(dataSourceBadge("nse-api").label).not.toBe("Yahoo");
    expect(dataSourceBadge("nse-api").display).not.toContain("Yahoo");
    expect(dataSourceBadge("some-new-provider").label).toBe("SOME-NEW-PROVIDER");
    expect(dataSourceBadge("some-new-provider").display).toBe("some-new-provider");
  });
});
