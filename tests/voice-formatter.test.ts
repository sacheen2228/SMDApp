/// <reference types="bun-types" />
// Voice formatter — structured event → short spoken text.
// CRITICAL RULES (spec §20/§21/§22):
//   - Only structured event data is spoken. Never parse LLM/free text for prices.
//   - Missing data is OMITTED, never invented.
//   - SELL signals are spoken as alerts, never as approved/confirmed entries.

import { describe, it, expect } from "bun:test";
import { formatVoiceEvent, type VoiceEvent } from "@/lib/voice/voiceFormatter";

const base = (over: Partial<VoiceEvent>): VoiceEvent => ({
  eventType: "TRADE_SIGNAL",
  timestamp: Date.now(),
  ...over,
});

describe("voice formatter — trade signals", () => {
  it("formats BUY CE trade signal with all fields", () => {
    const r = formatVoiceEvent(base({
      eventType: "TRADE_SIGNAL",
      symbol: "NIFTY", strike: 24500, optionType: "CE", side: "BUY",
      confidence: 82, entryPrice: 125, stopLoss: 92, target: 178,
    }));
    expect(r).toContain("Alert.");
    expect(r).toContain("NIFTY 24500 Call");
    expect(r).toContain("Confluence score 82 percent.");
    expect(r).toContain("Entry 125.");
    expect(r).toContain("Stop loss 92.");
    expect(r).toContain("Target 178.");
  });

  it("formats BUY PE as Put", () => {
    const r = formatVoiceEvent(base({
      symbol: "BANKNIFTY", strike: 52000, optionType: "PE",
      entryPrice: 250, stopLoss: 180, target: 340,
    }));
    expect(r).toContain("BANKNIFTY 52000 Put");
    expect(r).not.toContain("Call");
  });

  it("omits missing fields instead of inventing them", () => {
    const r = formatVoiceEvent(base({ symbol: "NIFTY", strike: 24500, optionType: "CE" }));
    expect(r).toContain("NIFTY 24500 Call");
    expect(r).not.toMatch(/Entry|Stop loss|Target|percent/);
  });

  it("speaks SELL as alert, never as confirmed/approved entry", () => {
    const r = formatVoiceEvent(base({
      eventType: "ENTRY", symbol: "SENSEX", strike: 80000, optionType: "PE",
      side: "SELL", entryPrice: 100, stopLoss: 140, target: 60,
    }));
    expect(r!.toLowerCase()).not.toContain("confirmed");
    expect(r!.toLowerCase()).not.toContain("approved");
    expect(r).toContain("Alert.");
    expect(r).toContain("SENSEX 80000 Put");
  });

  it("formats entry confirmation for BUY", () => {
    const r = formatVoiceEvent(base({
      eventType: "ENTRY", symbol: "NIFTY", strike: 24500, optionType: "CE",
      side: "BUY", entryPrice: 125, stopLoss: 92, target: 178,
    }));
    expect(r).toContain("Entry confirmed.");
    expect(r).toContain("NIFTY 24500 Call");
  });
});

describe("voice formatter — TP / SL", () => {
  it("formats target one achieved", () => {
    const r = formatVoiceEvent(base({
      eventType: "TP_HIT", targetNumber: 1,
      symbol: "NIFTY", strike: 24500, optionType: "CE", premium: 155,
    }));
    expect(r).toContain("Target one achieved.");
    expect(r).toContain("NIFTY 24500 Call");
    expect(r).toContain("Current premium 155.");
    expect(r).not.toContain("Position remains active.");
  });

  it("formats target two with position active", () => {
    const r = formatVoiceEvent(base({
      eventType: "TP_HIT", targetNumber: 2,
      symbol: "NIFTY", strike: 24500, optionType: "CE",
    }));
    expect(r).toContain("Target two achieved.");
    expect(r).toContain("Position remains active.");
  });

  it("formats stop loss in controlled voice", () => {
    const r = formatVoiceEvent(base({
      eventType: "SL_HIT",
      symbol: "NIFTY", strike: 24500, optionType: "CE",
    }));
    expect(r).toContain("Stop loss triggered.");
    expect(r).toContain("NIFTY 24500 Call");
    expect(r).toContain("Position exit required.");
  });
});

describe("voice formatter — no trade / wait / news / system", () => {
  it("speaks NO_TRADE with engine-supplied reason only", () => {
    const r = formatVoiceEvent(base({ eventType: "NO_TRADE", reason: "Market confirmation is insufficient." }));
    expect(r).toContain("No trade.");
    expect(r).toContain("Market confirmation is insufficient.");
  });

  it("never invents a NO_TRADE reason", () => {
    const r = formatVoiceEvent(base({ eventType: "NO_TRADE" }));
    expect(r).toBe("No trade.");
  });

  it("formats WAIT with reason", () => {
    const r = formatVoiceEvent(base({ eventType: "WAIT", reason: "Option-chain confirmation is incomplete." }));
    expect(r).toContain("Standing by.");
    expect(r).toContain("Option-chain confirmation is incomplete.");
  });

  it("formats verified news, refuses unverified", () => {
    const ok = formatVoiceEvent(base({ eventType: "NEWS_ALERT", headline: "RBI policy announcement detected.", verified: true }));
    expect(ok).toContain("News alert.");
    expect(ok).toContain("RBI policy announcement detected.");
    expect(ok).toContain("Market impact assessment is pending.");

    const bad = formatVoiceEvent(base({ eventType: "NEWS_ALERT", headline: "unverified rumor text", verified: false }));
    expect(bad).toContain("News information is unverified.");
    expect(bad).toContain("No action is recommended.");
    expect(bad).not.toContain("rumor");
  });

  it("formats system warning/error without stack traces or JSON", () => {
    const r = formatVoiceEvent(base({
      eventType: "SYSTEM_ERROR",
      reason: 'fetch failed at /src/lib/nse-api.ts:142 TypeError: {"code":503} {"stack":"Error: x\\n at foo"}',
    }));
    expect(r).toContain("System error.");
    expect(r).not.toContain("{");
    expect(r).not.toContain("/src/");
    expect(r!.length).toBeLessThan(200);
  });

  it("formats startup once-style system ready", () => {
    expect(formatVoiceEvent(base({ eventType: "SYSTEM_START" })))
      .toBe("SMDApp systems online. Market intelligence services are ready.");
    expect(formatVoiceEvent(base({ eventType: "SYSTEM_READY" })))
      .toBe("SMDApp systems online. Market intelligence services are ready.");
  });
});

describe("voice formatter — market briefing", () => {
  it("briefs with real values only", () => {
    const r = formatVoiceEvent(base({
      eventType: "MARKET_BRIEFING",
      symbol: "NIFTY", trend: "bullish", vix: 12.3, pcr: 1.05,
      spotPrice: 22421.95, chainStatus: "pending",
    }));
    expect(r).toContain("SMDApp intelligence systems are online.");
    expect(r).toContain("NIFTY structure is bullish.");
    expect(r).toContain("India VIX is 12.3.");
    expect(r).toContain("Option-chain confirmation is pending.");
    expect(r).toContain("I am monitoring the market.");
  });

  it("reports incomplete data instead of fabricating", () => {
    const r = formatVoiceEvent(base({ eventType: "MARKET_BRIEFING" }));
    expect(r).toBe("Market data is incomplete. I am standing by.");
  });
});

describe("voice formatter — safety", () => {
  it("returns null for empty/unknown event", () => {
    expect(formatVoiceEvent(base({ eventType: "TRADE_SIGNAL" }))).toBeNull(); // no symbol, no data
    expect(formatVoiceEvent(base({ eventType: "TRADE_SIGNAL", symbol: "NIFTY" }))).toContain("NIFTY");
  });

  it("never echoes internal ids or debug payloads", () => {
    const r = formatVoiceEvent(base({
      eventType: "SL_HIT", symbol: "NIFTY", strike: 24500, optionType: "CE",
      tradeId: "trade_9f8e7d6c", reason: '{"debug":true}',
    }));
    expect(r).not.toContain("trade_9f8e7d6c");
    expect(r).not.toContain("debug");
  });

  it("maps abbreviations to spoken words", () => {
    const r = formatVoiceEvent(base({ eventType: "NO_TRADE", reason: "PCR and OI and VIX are conflicting" }));
    expect(r).toContain("Put-call ratio"); // PCR spoken out — via sanitize map? (see implementation)
  });
});
