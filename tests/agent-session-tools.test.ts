import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { executeTool, AGENT_TOOLS } from "@/lib/agent-brain";
import {
  __setSessionAlertSenderForTests,
  __setSessionProbesForTests,
  __setApplyBreezeForTests,
  __resetSessionHealthForTests,
  reportSessionFailure,
} from "@/lib/session-health";

describe("Hermes session tools (executeTool glue)", () => {
  beforeEach(() => {
    __resetSessionHealthForTests();
    __setSessionAlertSenderForTests(() => {});
  });
  afterEach(() => {
    __resetSessionHealthForTests();
    __setSessionAlertSenderForTests(null);
  });

  const ctx = { symbol: "NIFTY", spotPrice: 25000, analysis: {}, summary: {} };

  test("both tools are registered in AGENT_TOOLS", () => {
    const names = AGENT_TOOLS.map((t: any) => t.function.name);
    expect(names).toContain("check_session_tokens");
    expect(names).toContain("set_breeze_session");
  });

  test("check_session_tokens returns live probes + recorded episodes as JSON", async () => {
    reportSessionFailure("breeze", "SESSION_EXPIRED", "token gone");
    __setSessionProbesForTests(async (s) => ({ live: s === "nse", detail: `probe ${s}` }));
    const out = await executeTool("check_session_tokens", { source: "all" }, ctx as any);
    const r = JSON.parse(out);
    expect(r.probes.breeze.live).toBe(false);
    expect(r.probes.nse.live).toBe(true);
    expect(r.sessionHealth.breeze.kind).toBe("SESSION_EXPIRED");
    expect(r.summary.anySessionExpired).toBe(true);
    expect(r.remedies.join(" ")).toContain("set breeze session");
  });

  test("check_session_tokens passes source through", async () => {
    const called: string[] = [];
    __setSessionProbesForTests(async (s) => { called.push(s); return { live: true, detail: "ok" }; });
    const r = JSON.parse(await executeTool("check_session_tokens", { source: "mo" }, ctx as any));
    expect(called).toEqual(["mo"]);
    expect(r.probes.mo.live).toBe(true);
    expect(r.probes.breeze).toBeUndefined();
  });

  test("set_breeze_session without token → clear error", async () => {
    const r = JSON.parse(await executeTool("set_breeze_session", {}, ctx as any));
    expect(r.success).toBe(false);
    expect(r.error).toContain("token required");
  });

  test("set_breeze_session with token → applies + re-arms episode", async () => {
    reportSessionFailure("breeze", "SESSION_EXPIRED", "token gone");
    let got = "";
    __setApplyBreezeForTests(async (t) => { got = t; return { success: true, status: "LIVE" }; });
    const r = JSON.parse(await executeTool("set_breeze_session", { token: "fresh-token" }, ctx as any));
    expect(r.success).toBe(true);
    expect(got).toBe("fresh-token");
    const { getSessionHealth } = await import("@/lib/session-health");
    expect(getSessionHealth().breeze.kind).toBeNull();
  });
});
