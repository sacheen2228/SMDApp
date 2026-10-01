import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  classifySourceError,
  reportSessionFailure,
  reportSessionRecovery,
  getSessionHealth,
  getSessionSummary,
  probeSessionSource,
  applyBreezeSession,
  buildSessionStatusReport,
  __setSessionAlertSenderForTests,
  __setSessionProbesForTests,
  __setApplyBreezeForTests,
  __resetSessionHealthForTests,
  type SessionSource,
  type FailureKind,
} from "@/lib/session-health";

describe("session-health classifier", () => {
  test("breeze session-expired messages → SESSION_EXPIRED", () => {
    expect(
      classifySourceError(
        "breeze",
        "Breeze session expired and re-init failed. Update .env BREEZE_SESSION_TOKEN."
      )
    ).toBe("SESSION_EXPIRED");
    expect(classifySourceError("breeze", "Invalid Token")).toBe("SESSION_EXPIRED");
    expect(classifySourceError("breeze", "Unauthorized 401")).toBe("SESSION_EXPIRED");
    expect(classifySourceError("breeze", "Auth Token is not verified")).toBe(
      "SESSION_EXPIRED"
    );
  });

  test("mo auth messages → SESSION_EXPIRED", () => {
    expect(classifySourceError("mo", "Invalid Token")).toBe("SESSION_EXPIRED");
    expect(classifySourceError("mo", "Your Auth Token is not verified")).toBe(
      "SESSION_EXPIRED"
    );
    expect(classifySourceError("mo", "Unauthorized 401")).toBe("SESSION_EXPIRED");
  });

  test("nse NEVER classifies as SESSION_EXPIRED (cookie/block → SOURCE_UNAVAILABLE)", () => {
    expect(classifySourceError("nse", "403 Forbidden")).toBe("SOURCE_UNAVAILABLE");
    expect(classifySourceError("nse", "401 Unauthorized")).toBe("SOURCE_UNAVAILABLE");
    expect(classifySourceError("nse", "session expired")).toBe("SOURCE_UNAVAILABLE");
    expect(classifySourceError("nse", "fetch failed")).toBe("SOURCE_UNAVAILABLE");
    expect(classifySourceError("nse", "no data for symbol")).toBe("NO_DATA");
  });

  test("non-auth failures classified without faking expiry", () => {
    expect(classifySourceError("breeze", "network timeout")).toBe(
      "SOURCE_UNAVAILABLE"
    );
    expect(classifySourceError("breeze", "fetch failed")).toBe(
      "SOURCE_UNAVAILABLE"
    );
    expect(classifySourceError("breeze", "no rows returned")).toBe("NO_DATA");
    expect(classifySourceError("mo", "endpoint not implemented")).toBe(
      "SOURCE_UNAVAILABLE"
    );
  });
});

describe("session-health reporting + single-owner alerting", () => {
  let sent: string[];
  const realSender = (m: string) => { sent.push(m); };

  beforeEach(() => {
    sent = [];
    __resetSessionHealthForTests();
    __setSessionAlertSenderForTests(realSender);
  });
  afterEach(() => {
    __resetSessionHealthForTests();
    __setSessionAlertSenderForTests(null);
  });

  test("SESSION_EXPIRED fires exactly one alert per episode, deduped", () => {
    reportSessionFailure("breeze", "SESSION_EXPIRED", "Breeze session expired and re-init failed");
    reportSessionFailure("breeze", "SESSION_EXPIRED", "Breeze session expired and re-init failed");
    reportSessionFailure("breeze", "SESSION_EXPIRED", "Invalid Token");

    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("[SYSTEM][SESSION_EXPIRED]");
    expect(sent[0]).toContain("breeze");
    expect(sent[0]).toContain("Breeze session expired and re-init failed");
    expect(sent[0]).toContain("set breeze session");

    const h = getSessionHealth().breeze;
    expect(h.kind).toBe("SESSION_EXPIRED");
    expect(h.alertSent).toBe(true);
    expect(h.failureCount).toBe(3);
    expect(h.since).toBeTruthy();
  });

  test("non-session kinds are recorded but never alert", () => {
    reportSessionFailure("mo", "SOURCE_UNAVAILABLE", "no intraday candle endpoint");
    reportSessionFailure("nse", "NO_DATA", "empty chain");
    expect(sent.length).toBe(0);

    const health = getSessionHealth();
    expect(health.mo.kind).toBe("SOURCE_UNAVAILABLE");
    expect(health.mo.alertSent).toBe(false);
    expect(health.nse.kind).toBe("NO_DATA");
    expect(getSessionSummary().anySessionExpired).toBe(false);
  });

  test("recovery re-arms the episode → next expiry alerts again", () => {
    reportSessionFailure("breeze", "SESSION_EXPIRED", "expired once");
    expect(sent.length).toBe(1);

    reportSessionRecovery("breeze");
    expect(sent.length).toBe(1); // recovery itself does not alert
    const h = getSessionHealth().breeze;
    expect(h.kind).toBeNull();
    expect(h.alertSent).toBe(false);
    expect(h.recoveredAt).toBeTruthy();

    reportSessionFailure("breeze", "SESSION_EXPIRED", "expired again");
    expect(sent.length).toBe(2);
    expect(getSessionHealth().breeze.failureCount).toBe(1);
  });

  test("different sources alert independently (dedup is per source)", () => {
    reportSessionFailure("breeze", "SESSION_EXPIRED", "breeze down");
    reportSessionFailure("mo", "SESSION_EXPIRED", "mo down");
    reportSessionFailure("breeze", "SESSION_EXPIRED", "breeze down again");
    expect(sent.length).toBe(2);
    expect(sent.some((m) => m.includes("mo"))).toBe(true);
  });

  test("a generic data-gap report cannot downgrade an active expiry episode", () => {
    reportSessionFailure("breeze", "SESSION_EXPIRED", "token gone");
    expect(sent.length).toBe(1);

    reportSessionFailure("breeze", "NO_DATA", "option chain unavailable for NIFTY");
    const h = getSessionHealth().breeze;
    expect(h.kind).toBe("SESSION_EXPIRED"); // episode preserved
    expect(h.alertSent).toBe(true); // still disarmed for this episode

    reportSessionFailure("breeze", "SESSION_EXPIRED", "still expired");
    expect(sent.length).toBe(1); // no second alert
    expect(getSessionHealth().breeze.failureCount).toBe(3);
  });

  test("summary flags active session expiry for status/Hermes surfaces", () => {
    expect(getSessionSummary().anySessionExpired).toBe(false);
    reportSessionFailure("breeze", "SESSION_EXPIRED", "down");
    const s = getSessionSummary();
    expect(s.anySessionExpired).toBe(true);
    expect(s.expiredSources).toEqual(["breeze"]);
    reportSessionRecovery("breeze");
    expect(getSessionSummary().anySessionExpired).toBe(false);
  });

  test("alert message includes remedy: manual token handoff path", () => {
    reportSessionFailure("breeze", "SESSION_EXPIRED", "token gone");
    expect(sent[0]).toContain("https://api.icicidirect.com/apiuser/login?api_key=");
  });
});

describe("session probes + status report (Hermes check_session_tokens / set_breeze_session)", () => {
  beforeEach(() => {
    __resetSessionHealthForTests();
    __setSessionAlertSenderForTests(() => {});
  });
  afterEach(() => {
    __resetSessionHealthForTests();
    __setSessionAlertSenderForTests(null);
  });

  test("probes are injectable — tests never touch the network", async () => {
    __setSessionProbesForTests(async (s) => ({ live: s === "breeze", detail: `fake ${s}` }));
    expect((await probeSessionSource("breeze")).live).toBe(true);
    expect((await probeSessionSource("mo")).live).toBe(false);
    expect((await probeSessionSource("mo")).detail).toBe("fake mo");
  });

  test("status report bundles live probes + recorded health + remedies", async () => {
    reportSessionFailure("breeze", "SESSION_EXPIRED", "expired");
    __setSessionProbesForTests(async (s) => ({ live: false, detail: `down ${s}` }));
    const r: any = await buildSessionStatusReport("all");
    expect(r.probes.breeze.live).toBe(false);
    expect(r.probes.mo.live).toBe(false);
    expect(r.probes.nse.live).toBe(false);
    expect(r.summary.anySessionExpired).toBe(true);
    expect(r.sessionHealth.breeze.kind).toBe("SESSION_EXPIRED");
    const rem = r.remedies.join(" ");
    expect(rem).toContain("set breeze session");
    expect(rem).toContain("MOTILAL_TOTP_KEY");
    // recorder/candle-chain state included (Hermes gets the full picture)
    expect(r).toHaveProperty("lastCandleCapture");
    expect(r).toHaveProperty("recorder");
    expect(typeof r.recorder.totalCaptures).toBe("number");
  });

  test("single-source report probes only that source", async () => {
    const called: string[] = [];
    __setSessionProbesForTests(async (s) => { called.push(s); return { live: true, detail: "ok" }; });
    const r: any = await buildSessionStatusReport("breeze");
    expect(called).toEqual(["breeze"]);
    expect(r.probes.breeze.live).toBe(true);
    expect(r.probes.mo).toBeUndefined();
  });

  test("unknown source → clear error entry, no throw", async () => {
    const r: any = await buildSessionStatusReport("kraken");
    expect(r.probes.kraken.live).toBe(false);
    expect(r.probes.kraken.detail).toContain("unknown source");
  });

  test("applyBreezeSession success re-arms the breeze episode", async () => {
    reportSessionFailure("breeze", "SESSION_EXPIRED", "expired");
    __setApplyBreezeForTests(async () => ({ success: true, status: "LIVE" }));
    const res = await applyBreezeSession("new-token");
    expect(res.success).toBe(true);
    expect(res.status).toBe("LIVE");
    expect(getSessionHealth().breeze.kind).toBeNull(); // recovered
  });

  test("applyBreezeSession failure surfaces error and keeps the episode", async () => {
    reportSessionFailure("breeze", "SESSION_EXPIRED", "expired");
    __setApplyBreezeForTests(async () => ({ success: false, error: "token rejected" }));
    const res = await applyBreezeSession("bad");
    expect(res.success).toBe(false);
    expect(res.error).toBe("token rejected");
    expect(getSessionHealth().breeze.kind).toBe("SESSION_EXPIRED");
  });

  test("applyBreezeSession success resets the breeze circuit breaker immediately", async () => {
    const { providerHealth } = await import("@/lib/provider-health");
    try {
      // Drive the circuit OPEN (as after a long auth-outage night)
      for (let i = 0; i < 8; i++) {
        providerHealth.recordFailure("breeze", "AUTH", "simulated expired session");
      }
      expect(providerHealth.shouldSkip("breeze")).toBe(true);

      __setApplyBreezeForTests(async () => ({ success: true, status: "LIVE" }));
      const res = await applyBreezeSession("fresh-token");
      expect(res.success).toBe(true);

      // Fresh token must be usable at once — no cooldown wait
      expect(providerHealth.shouldSkip("breeze")).toBe(false);
    } finally {
      __setApplyBreezeForTests(null);
      providerHealth.resetProvider("breeze");
    }
  });

  test("applyBreezeSession failure leaves the circuit alone", async () => {
    const { providerHealth } = await import("@/lib/provider-health");
    try {
      for (let i = 0; i < 8; i++) {
        providerHealth.recordFailure("breeze", "AUTH", "simulated expired session");
      }
      expect(providerHealth.shouldSkip("breeze")).toBe(true);

      __setApplyBreezeForTests(async () => ({ success: false, error: "bad token" }));
      const res = await applyBreezeSession("bad-token");
      expect(res.success).toBe(false);

      // Failed apply must NOT open the gates
      expect(providerHealth.shouldSkip("breeze")).toBe(true);
    } finally {
      __setApplyBreezeForTests(null);
      providerHealth.resetProvider("breeze");
    }
  });
});

describe("alert dispatch confirmation", () => {
  beforeEach(() => __resetSessionHealthForTests());
  afterEach(() => {
    __resetSessionHealthForTests();
    __setSessionAlertSenderForTests(null);
  });

  test("sender returning false (Telegram off-hours) does NOT consume the one-per-episode alert", () => {
    let calls = 0;
    __setSessionAlertSenderForTests(() => { calls++; return false; });
    reportSessionFailure("breeze", "SESSION_EXPIRED", "expired");
    expect(getSessionHealth().breeze.alertSent).toBe(false);
    expect(calls).toBe(1);

    reportSessionFailure("breeze", "SESSION_EXPIRED", "expired again");
    expect(calls).toBe(2); // retried, not deduped into a lost alert

    __setSessionAlertSenderForTests(() => { calls++; return true; });
    reportSessionFailure("breeze", "SESSION_EXPIRED", "still");
    expect(calls).toBe(3);
    expect(getSessionHealth().breeze.alertSent).toBe(true);

    reportSessionFailure("breeze", "SESSION_EXPIRED", "still");
    expect(calls).toBe(3); // confirmed → deduped
  });

  test("SDK auth wording classifies as SESSION_EXPIRED", () => {
    expect(classifySourceError("breeze", "Could not authenticate credentials. Please check token and keys")).toBe("SESSION_EXPIRED");
  });
});
