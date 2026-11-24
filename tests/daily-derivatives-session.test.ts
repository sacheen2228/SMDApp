// ═══════════════════════════════════════════════════════════════════════════
// Daily Derivatives — the card must say WHY there are no candles.
//
// On a non-trading day the report has candleCount 0 and latestSignals [], so
// the panel fell through to "Engine warming up — 0/30 bars" — implying data
// was about to arrive when the exchange was shut all day. The session module
// already knows (`getCurrentSession()` → "Non-trading day (weekend or exchange
// holiday)"); the report just never carried it.
//
// These tests pin: the report interface exposes the session, the service
// fills it from the shared session module, and the panel consults it BEFORE
// the warm-up message.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DD = readFileSync(join(process.cwd(), "src/lib/DailyDerivatives.ts"), "utf-8");
const PANEL = readFileSync(join(process.cwd(), "src/components/daily/DailyDerivativesPanel.tsx"), "utf-8");

describe("Daily Derivatives — session on the report", () => {
  it("the report interface carries the market session", () => {
    expect(DD).toMatch(/marketSession\??:\s*\{[^}]*isMarketOpen/);
    expect(DD).toMatch(/marketSession\??:\s*\{[^}]*description/);
  });

  it("the service fills it from the shared session module (one source of truth)", () => {
    expect(DD).toMatch(/getCurrentSession/);
    expect(DD).toMatch(/marketSession:/);
  });

  it("the panel consults the session BEFORE the warm-up message", () => {
    // Find the Latest Signals empty-state block.
    const start = PANEL.indexOf("Latest Technical Signals");
    const block = PANEL.slice(start, start + 2200);
    expect(block).toContain("Engine warming up");
    expect(block).toContain("marketSession");

    // The closed-session message must appear ahead of the warm-up text, so a
    // non-trading day can never render "warming up".
    const closedIdx = block.search(/marketClosed|Market closed|Non-trading day/i);
    const warmIdx = block.indexOf("Engine warming up");
    expect(closedIdx).toBeGreaterThan(-1);
    expect(warmIdx).toBeGreaterThan(-1);
    expect(closedIdx).toBeLessThan(warmIdx);
  });

  it("the candle footer also stops claiming 'warming up' when the market is shut", () => {
    const footerIdx = PANEL.indexOf("Candles: {report.candleCount}");
    expect(footerIdx).toBeGreaterThan(-1);
    const footer = PANEL.slice(footerIdx, footerIdx + 500);
    expect(footer).toMatch(/marketSession/);
  });
});
