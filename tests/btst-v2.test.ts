import { analyzeBTSTv2 } from "../src/lib/btst-v2-engine";

const base = {
  symbol: "RELIANCE",
  price: 2500,
  changePct: 1.2,
  rsi: 58,
  ema9: 2510,
  ema21: 2500,
  ema50: 2480,
  volume: 5_000_000,
  avgVolume20d: 4_000_000,
  deliveryPct: 55,
  atr14: 35,
  sectorStrength: 15,
  relativeStrength: 0.8,
  isFNO: true,
  oiChangePct: 4,
  pcr: 0.95,
  iv: 22,
  alignment: 72,
  avgTurnoverCr: 120,
  isBan: false,
  circuit: false,
  resultsTomorrow: false,
  dataFresh: true,
};

test("BTST v2 BUY with strong inputs", () => {
  const res = analyzeBTSTv2(base, { niftyScore: 70, vix: 18 });
  expect(res.grade).toBe("BUY");
  expect(res.finalGrade).toBeGreaterThanOrEqual("A");
  expect(res.rr).toBeGreaterThanOrEqual(1.8);
});

test("Hard filter fails on ban", () => {
  const res = analyzeBTSTv2({ ...base, isBan: true }, { niftyScore: 70, vix: 18 });
  expect(res.hardFilterPass).toBe(false);
  expect(res.grade).toBe("SKIP");
});

test("Market gate blocks when VIX high", () => {
  const res = analyzeBTSTv2(base, { niftyScore: 70, vix: 30 });
  expect(res.marketGatePass).toBe(false);
});

test("Conflict caps grade at B", () => {
  const res = analyzeBTSTv2({ ...base, alignment: 45 }, { niftyScore: 70, vix: 18 });
  expect(res.conflict).toBe(true);
  expect(res.finalGrade).toBe("B");
});
