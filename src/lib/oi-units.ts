// oi-units — the ONE place source units are converted to the canonical chain unit.
//
// CANONICAL UNIT = CONTRACTS (the NSE option-chain-v3 API's own unit; the NSE
// website renders the same API, and every downstream consumer — PCR, gamma/GEX,
// gates, the OI panel — reads contract counts).
//
// Sources measured on 2026-11-06 (see tests/oi-units.test.ts for the numbers):
//   NSE live API      → CONTRACTS   (no conversion)
//   BSE live API      → CONTRACTS   (no conversion; snapshot ≈ bhavcopy ÷ lot)
//   Breeze SDK        → UNDERLYING UNITS (contracts × lot) — convert with toContracts
//   NSE/BSE bhavcopy  → UNDERLYING UNITS (OpnIntrst ÷ lot = participant OI) — convert
//   TtlTradgVol       → CONTRACTS already (both exchanges) — never convert volume
//     from the bhavcopy; Breeze's total_quantity_traded IS in units → convert.
//
// Unknown symbol: getLotSize() returns PER_UNIT_LOT_SIZE (1) → value passes
// through unchanged. Never divides by zero, never guesses NIFTY's 65.

import { getLotSize } from "@/lib/symbol-config";

/** Convert an underlying-units value (contracts × lot) to CONTRACTS. */
export function toContracts(value: number, symbol: string): number {
  if (!Number.isFinite(value)) return value;
  const lot = getLotSize(symbol);
  if (lot <= 1) return value; // per-unit (unknown) or bogus lot → leave as-is
  return Math.round(value / lot);
}
