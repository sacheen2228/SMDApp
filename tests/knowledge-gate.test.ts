/// <reference types="bun-types" />
// Knowledge gate — playbook/how-to/explain questions must skip hermesPro
// (which returns RESEARCH_ONLY after hours and an analysis panel during
// market hours) and reach agentRespondLLM where read_playbook /
// hedge_calculator / strike_selector live.

import { describe, it, expect } from "bun:test";
import { isKnowledgeQuery } from "@/lib/agent-engine";

describe("isKnowledgeQuery — doc/playbook requests", () => {
  it("matches reading playbook/docs/checklists", () => {
    expect(isKnowledgeQuery("read me the hedging playbook")).toBe(true);
    expect(isKnowledgeQuery("open the option buying playbook reference doc")).toBe(true);
    expect(isKnowledgeQuery("what is the scoring checklist for a trade setup?")).toBe(true);
    expect(isKnowledgeQuery("explain the black-scholes formula and expected move math")).toBe(true);
    expect(isKnowledgeQuery("show me the journal template")).toBe(true);
  });
});

describe("isKnowledgeQuery — hedging requests", () => {
  it("matches hedge / debit spread / profit protection", () => {
    expect(isKnowledgeQuery("how do I hedge my NIFTY 25100 call, reduce my loss?")).toBe(true);
    expect(isKnowledgeQuery("protect profit on this PE with a debit spread")).toBe(true);
    expect(isKnowledgeQuery("portfolio hedge with index puts")).toBe(true);
    expect(isKnowledgeQuery("should I hedge before expiry?")).toBe(true);
  });

  it("hedge wins over target/stop args (they are hedge_calculator inputs)", () => {
    expect(isKnowledgeQuery("how do I hedge my NIFTY 25100 call? spot 25100, VIX 22, 4 days to expiry, target 25250, stop 25040")).toBe(true);
  });

  it("explicit buy/sell still wins over hedge", () => {
    expect(isKnowledgeQuery("buy 1 lot and protect profit")).toBe(false);
    expect(isKnowledgeQuery("sell my call and hedge the rest")).toBe(false);
  });
});

describe("isKnowledgeQuery — educational explain / what-is", () => {
  it("matches explain/what-is/how-to against trading concepts", () => {
    expect(isKnowledgeQuery("explain delta and theta for a beginner")).toBe(true);
    expect(isKnowledgeQuery("what is max pain and how is it calculated")).toBe(true);
    expect(isKnowledgeQuery("how to calculate position size for options")).toBe(true);
    expect(isKnowledgeQuery("why is IV crushed after expiry")).toBe(true);
    expect(isKnowledgeQuery("what are greeks in options trading")).toBe(true);
  });
});

describe("isKnowledgeQuery — trade questions stay with hermes", () => {
  it("execution language always → false", () => {
    expect(isKnowledgeQuery("buy NIFTY 25000 CE now")).toBe(false);
    expect(isKnowledgeQuery("mujhe ek trade do")).toBe(false);
    expect(isKnowledgeQuery("which strike should I buy for tomorrow")).toBe(false);
    expect(isKnowledgeQuery("give me today's best trade")).toBe(false);
    expect(isKnowledgeQuery("sell the PE at entry with target 50")).toBe(false);
    expect(isKnowledgeQuery("place order for BANKNIFTY 54000 CE")).toBe(false);
  });
});

describe("isKnowledgeQuery — ambiguous stays with hermes", () => {
  it("market-state / data questions → false (hermes priority)", () => {
    expect(isKnowledgeQuery("market kaisa chal raha hai")).toBe(false);
    expect(isKnowledgeQuery("VIX kitna hai")).toBe(false);
    expect(isKnowledgeQuery("trend")).toBe(false);
    expect(isKnowledgeQuery("")).toBe(false);
    expect(isKnowledgeQuery("ok")).toBe(false);
  });
});
