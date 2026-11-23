import { describe, it, expect } from "bun:test";
import {
  futuresFlowRelativeVolume,
  parseIstBarMs,
  istDateStr,
} from "@/lib/market/futures-flow";

const bar = (time: string, volume: number) => ({
  time,
  open: 100,
  high: 101,
  low: 99,
  close: 100.5,
  volume,
});

describe("parseIstBarMs", () => {
  it("parses the Breeze bar format as IST wall-clock", () => {
    const ms = parseIstBarMs("20-Nov-2026 09:15:00");
    expect(ms).toBe(Date.UTC(2026, 10, 20, 3, 45, 0));
  });

  it("returns null for junk", () => {
    expect(parseIstBarMs("not-a-time")).toBeNull();
    expect(parseIstBarMs("")).toBeNull();
  });
});

describe("istDateStr", () => {
  it("returns the IST calendar day (never UTC)", () => {
    const d = istDateStr(0, Date.UTC(2026, 10, 20, 20, 0, 0));
    expect(d).toBe("2026-11-21");
  });
});

describe("futuresFlowRelativeVolume", () => {
  it("compares the last closed bar with the prior 20-bar average", () => {
    const candles = Array.from({ length: 25 }, (_, i) =>
      bar(`20-Nov-2026 ${String(9 + Math.floor(i / 12)).padStart(2, "0")}:${String((i * 5) % 60).padStart(2, "0")}:00`, 100)
    );
    candles[24] = bar("20-Nov-2026 11:00:00", 300);

    const read = futuresFlowRelativeVolume(candles as any, { nowMs: Date.UTC(2026, 10, 20, 6, 0, 0) });
    expect(read).not.toBeNull();
    expect(read!.current).toBe(300);
    expect(read!.average).toBeCloseTo(100, 6);
    expect(read!.ratio).toBeCloseTo(3, 6);
  });

  it("ignores the still-forming bar", () => {
    const candles = Array.from({ length: 25 }, (_, i) =>
      bar(`20-Nov-2026 ${String(9 + Math.floor(i / 12)).padStart(2, "0")}:${String((i * 5) % 60).padStart(2, "0")}:00`, 100)
    );
    candles[24] = bar("20-Nov-2026 11:00:00", 300);
    candles.push(bar("20-Nov-2026 11:05:00", 10)); // forming bar — partial volume

    const read = futuresFlowRelativeVolume(candles as any, { nowMs: Date.UTC(2026, 10, 20, 5, 36, 0) });
    expect(read).not.toBeNull();
    expect(read!.current).toBe(300);
  });

  it("returns null when there is not enough history", () => {
    const candles = [bar("20-Nov-2026 09:15:00", 100), bar("20-Nov-2026 09:20:00", 120)];
    expect(futuresFlowRelativeVolume(candles as any)).toBeNull();
  });
});
