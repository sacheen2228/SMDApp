import { describe, test, expect } from "bun:test";
import { toContracts } from "@/lib/oi-units";

// MEASURED against real data (2026-11-06):
//  - NSE bhavcopy NIFTY 25000 CE 09-Nov: OpnIntrst=11,065,470 = live NSE API
//    openInterest 170,238 × lot 65 → bhavcopy/OI is in UNDERLYING UNITS,
//    the live API is in CONTRACTS.
//  - Breeze getOptionChainQuotes for NIFTY returns underlying units too:
//    recorded snapshot 2026-11-06T07:58Z 23250CE oi=101,530 (÷65=1,562),
//    oiChg=-36,205 (÷65=-557), volume=51,870 (÷65=798) — all exact.
//  - BSE live chain is already in CONTRACTS (snapshot ≈ bhavcopy ÷ 20 lot).
describe("toContracts — underlying units → contracts (÷ lot)", () => {
  test("NIFTY: bhavcopy/Breeze OI converts to the live NSE contract count", () => {
    expect(toContracts(11065470, "NIFTY")).toBe(170238);
    expect(toContracts(101530, "NIFTY")).toBe(1562);
    expect(toContracts(14605955, "NIFTY")).toBe(224707);
  });

  test("NIFTY: OI change and volume convert too (negative included)", () => {
    expect(toContracts(-36205, "NIFTY")).toBe(-557);
    expect(toContracts(51870, "NIFTY")).toBe(798);
    expect(toContracts(-894920, "NIFTY")).toBe(-13768);
  });

  test("SENSEX (BSE lot 20) and BANKNIFTY (lot 30) use their own lots", () => {
    expect(toContracts(9000, "SENSEX")).toBe(450);
    expect(toContracts(12000, "BANKNIFTY")).toBe(400);
  });

  test("futures: NIFTY front-month bhavcopy 12,088,505 → 185,977 contracts", () => {
    expect(toContracts(12088505, "NIFTY")).toBe(185977);
  });

  test("unknown symbol (lot 1 per-unit) passes through unchanged — never ÷0", () => {
    expect(toContracts(1000, "NOTAFNO")).toBe(1000);
  });

  test("zero / non-finite inputs pass through", () => {
    expect(toContracts(0, "NIFTY")).toBe(0);
    expect(toContracts(NaN, "NIFTY")).toBeNaN();
  });
});
