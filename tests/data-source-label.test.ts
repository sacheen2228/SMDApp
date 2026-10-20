import { describe, it, expect } from "bun:test";
import { dataSourceBadge } from "@/lib/data-source-label";

describe("dataSourceBadge", () => {
  it("maps live exchange/broker sources to badge LIVE + friendly display names", () => {
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
      expect(b.label).toBe("LIVE");
      expect(b.isLive).toBe(true);
      expect(b.display).toBe(display);
    }
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
