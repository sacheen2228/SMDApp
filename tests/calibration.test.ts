import { describe, test, expect } from "bun:test";
import {
  bandOf, reliabilityTable, bandCalibration, calibratedConfidence, calibrationDrift,
} from "@/lib/confidence-calibration";

describe("confidence calibration", () => {
  test("bands map stated confidence", () => {
    expect(bandOf(0).band).toBe("0-20");
    expect(bandOf(35).band).toBe("21-40");
    expect(bandOf(55).band).toBe("41-60");
    expect(bandOf(70).band).toBe("61-80");
    expect(bandOf(95).band).toBe("81-100");
  });

  test("reliability table reports n, realized WR and expectancy R", () => {
    const samples = [
      ...Array.from({ length: 30 }, () => ({ stated: 70, won: true, r: 1 })),
      ...Array.from({ length: 20 }, () => ({ stated: 70, won: false, r: -1 })),
      ...Array.from({ length: 10 }, () => ({ stated: 40, won: false, r: -1 })),
    ];
    const t = reliabilityTable(samples);
    const b70 = t.find((x) => x.band === "61-80")!;
    expect(b70.n).toBe(50);
    expect(b70.realizedWR).toBeCloseTo(0.6, 5);
    expect(b70.expectancyR).toBeCloseTo((30 * 1 - 20) / 50, 5);
  });

  test("a band needs 20 samples before it can calibrate", () => {
    const few = reliabilityTable(Array.from({ length: 10 }, () => ({ stated: 70, won: true, r: 1 })));
    expect(bandCalibration(few, 70)).toEqual({});
    const many = reliabilityTable(Array.from({ length: 25 }, () => ({ stated: 70, won: true, r: 1 })));
    expect(bandCalibration(many, 70)).toEqual({ realizedHitPct: 100, n: 25 });
  });

  test("calibrated confidence uses the measured band, otherwise the default haircut", () => {
    const many = reliabilityTable([
      ...Array.from({ length: 30 }, () => ({ stated: 70, won: true, r: 1 })),
      ...Array.from({ length: 20 }, () => ({ stated: 70, won: false, r: -1 })),
    ]);
    expect(calibratedConfidence(70, many)).toBe(60);
    expect(calibratedConfidence(70, [])).toBe(63); // 70 × 0.9, no history
  });

  test("drift compares the current window with the reference", () => {
    const now = reliabilityTable(Array.from({ length: 30 }, () => ({ stated: 70, won: true, r: 1 })));
    const ref = reliabilityTable(Array.from({ length: 30 }, () => ({ stated: 70, won: false, r: -1 })));
    const d = calibrationDrift(now, ref).find((x) => x.band === "61-80")!;
    expect(d.drift).toBeCloseTo(1, 5);
    expect(d.n).toBe(30);
  });
});
