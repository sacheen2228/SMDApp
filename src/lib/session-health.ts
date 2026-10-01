// Session Health — SINGLE OWNER of session-expiry classification, alerting and status.
//
// This module is the only place allowed to send [SYSTEM][SESSION_EXPIRED] Telegram
// alerts (Trade Monitor / telegram-alerts.ts owns TP/SL trade alerts and is untouched).
// Source modules report failures here (reportSessionFailure) and keep their existing
// return contracts (null / [] / failed fetch) — classification, dedup and alerting
// all happen in this one place.
//
// Episode model: an alert fires once per source per failure episode; reportSessionRecovery
// re-arms the source. Non-session kinds (NO_DATA, SOURCE_UNAVAILABLE) are recorded for
// status/Hermes surfaces but never alert — expected gaps must not spam Telegram.

export type SessionSource = "breeze" | "mo" | "nse";
export type FailureKind = "SESSION_EXPIRED" | "NO_DATA" | "SOURCE_UNAVAILABLE";

export interface SourceHealth {
  kind: FailureKind | null;
  detail: string | null;
  since: string | null; // ISO — first failure of current episode
  lastFailureAt: string | null;
  alertSent: boolean;
  recoveredAt: string | null;
  failureCount: number; // failures within current episode
}

export interface SessionSummary {
  anySessionExpired: boolean;
  expiredSources: SessionSource[];
  anyFailure: boolean;
}

const SOURCES: SessionSource[] = ["breeze", "mo", "nse"];

function blankHealth(): SourceHealth {
  return {
    kind: null,
    detail: null,
    since: null,
    lastFailureAt: null,
    alertSent: false,
    recoveredAt: null,
    failureCount: 0,
  };
}

// Process-wide singleton on globalThis: Next.js loads each route as a separate
// module graph (dev + standalone), so plain module-level state would give every
// route its OWN health state — breaking both the status surfaces AND the
// once-per-episode alert dedup. All instances must share one store.
type AlertSender = (message: string) => boolean | void | Promise<boolean | void>;
export type SessionProbeFn = (source: SessionSource) => Promise<SessionProbe>;
export type ApplyBreezeFn = (
  token: string
) => Promise<{ success: boolean; status?: string; error?: string }>;

interface SessionHealthStore {
  state: Record<SessionSource, SourceHealth>;
  alertSender: AlertSender | null;
  probeOverride: SessionProbeFn | null;
  applyBreezeOverride: ApplyBreezeFn | null;
}

const store: SessionHealthStore =
  ((globalThis as any).__SMD_SESSION_HEALTH__ ??= {
    state: { breeze: blankHealth(), mo: blankHealth(), nse: blankHealth() },
    alertSender: null,
    probeOverride: null,
    applyBreezeOverride: null,
  });
const state = store.state;

// ── Classification ──
// Caller-provided kind (reportSessionFailure) wins for known-context callers.
// classifySourceError is for callers that only have an error message.

const AUTH_PATTERNS: RegExp[] = [
  /session\s*expired/i,
  /invalid\s*token/i,
  /unauthorized/i,
  /\b401\b/,
  /\b403\b/,
  /auth\s*token\s*is\s*not\s*verified/i,
  /auth\s*failed/i,
  /could\s*not\s*authenticate/i,
  /check\s*token/i,
  /invalid\s*api\s*session/i,
  /token\s*may\s*be\s*expired/i,
  /not\s*verified/i,
  /update\s*\.env\s*breeze_session_token/i,
  /invalid\s*session/i,
  /session\s*not\s*(available|configured)/i,
];

const NETWORK_PATTERNS: RegExp[] = [
  /capability/i,
  /has no (intraday|index spot)/i,
  /eod daily only/i,
  /derivatives-only/i,
  /timeout/i,
  /fetch\s*failed/i,
  /network/i,
  /econn|socket|etimedout|enotfound/i,
  /not\s*implemented/i,
  /capability/i,
  /no\s*.*candle\s*endpoint/i,
  /unknown\s*symbol/i,
  /not\s*in\s*allowlist/i,
  /current\s*session\s*only/i,
];

const EMPTY_PATTERNS: RegExp[] = [/no\s*(rows|data)/i, /empty/i, /not\s*found/i];

export function classifySourceError(
  source: SessionSource,
  detail: string
): FailureKind {
  // NSE has no token auth — a 403/401 is cookie-blocking/crumb failure, never
  // session expiry. Do not let auth-looking messages fake an expiry alert.
  if (source === "nse") {
    if (EMPTY_PATTERNS.some((p) => p.test(detail))) return "NO_DATA";
    return "SOURCE_UNAVAILABLE";
  }
  if (AUTH_PATTERNS.some((p) => p.test(detail))) return "SESSION_EXPIRED";
  if (NETWORK_PATTERNS.some((p) => p.test(detail))) return "SOURCE_UNAVAILABLE";
  if (EMPTY_PATTERNS.some((p) => p.test(detail))) return "NO_DATA";
  return "NO_DATA";
}

// ── Alert sender (single owner; injectable for tests) ──
// A sender returns whether the message was actually dispatched. Telegram's
// sendTelegramMessage returns false outside the 09:10–15:30 IST window — in
// that case alertSent stays false so the NEXT failure report retries instead
// of silently consuming the one-per-episode alert.

function defaultAlertSender(message: string): Promise<boolean> {
  return import("./telegram")
    .then((m) => m.sendTelegramMessage(message))
    .catch((e) => {
      console.error("[session-health] telegram send failed:", e);
      return false;
    });
}

function buildAlertMessage(source: SessionSource, detail: string): string {
  const lines: string[] = [
    `[SYSTEM][SESSION_EXPIRED] source=${source}`,
    `Since: ${state[source].since ?? "unknown"}`,
    `Detail: ${detail}`,
  ];
  if (source === "breeze") {
    // NOTE: messages go out with parse_mode HTML — literal <token> would be
    // parsed as an unknown tag and Telegram rejects the whole send
    // ("Unsupported start tag"). Escape angle brackets.
    const key = process.env.BREEZE_API_KEY || "&lt;BREEZE_API_KEY&gt;";
    lines.push(
      "Remedy: open https://api.icicidirect.com/apiuser/login?api_key=" +
        key +
        " (browser OTP), then send Hermes: set breeze session &lt;token&gt;"
    );
  } else if (source === "mo") {
    lines.push(
      "Remedy: TOTP auto-recovery was attempted. Verify MOTILAL_TOTP_KEY matches " +
        "the authenticator registered with Motilal Oswal, or re-login to refresh the session."
    );
  }
  return lines.join("\n");
}

function sendAlert(source: SessionSource, detail: string): void {
  const msg = buildAlertMessage(source, detail);
  const confirm = (ok: boolean | void) => {
    if (ok !== false) state[source].alertSent = true;
    // ok === false (e.g. Telegram off-hours window): leave alertSent false so
    // the next failure report retries the send.
  };
  try {
    const res = store.alertSender ? store.alertSender(msg) : defaultAlertSender(msg);
    if (res && typeof (res as Promise<boolean | void>).then === "function") {
      (res as Promise<boolean | void>).then(confirm).catch(() => {});
    } else {
      confirm(res as boolean | void);
    }
  } catch (e) {
    console.error("[session-health] alert sender failed:", e);
  }
}

// ── Reporting API (called from source modules) ──

export function reportSessionFailure(
  source: SessionSource,
  kind: FailureKind,
  detail: string
): void {
  const st = state[source];
  const now = new Date().toISOString();
  st.lastFailureAt = now;
  st.detail = detail;

  if (st.kind === null) {
    // new episode
    st.kind = kind;
    st.since = now;
    st.failureCount = 1;
    st.alertSent = false;
    st.recoveredAt = null;
  } else if (st.kind === kind) {
    st.failureCount += 1;
  } else if (st.kind === "SESSION_EXPIRED") {
    // Never downgrade an active expiry episode with a softer kind (NO_DATA /
    // SOURCE_UNAVAILABLE) — downstream generic errors must not re-arm the alert.
    st.failureCount += 1;
    return;
  } else {
    // upgraded/replaced (e.g. NO_DATA → SESSION_EXPIRED) — new episode state
    st.kind = kind;
    st.since = now;
    st.failureCount = 1;
    st.alertSent = false;
    st.recoveredAt = null;
  }

  if (kind === "SESSION_EXPIRED" && !st.alertSent) {
    // alertSent flips true only once the sender confirms dispatch (sendAlert).
    sendAlert(source, detail);
  }
}

export function reportSessionRecovery(source: SessionSource): void {
  const st = state[source];
  if (st.kind === null) return; // nothing to recover
  st.recoveredAt = new Date().toISOString();
  st.kind = null;
  st.detail = null;
  st.since = null;
  st.failureCount = 0;
  st.alertSent = false;
}

// ── Status surfaces (status route / Hermes) ──

export function getSessionHealth(): Record<SessionSource, SourceHealth> {
  return {
    breeze: { ...state.breeze },
    mo: { ...state.mo },
    nse: { ...state.nse },
  };
}

export function getSessionSummary(): SessionSummary {
  const expired = SOURCES.filter((s) => state[s].kind === "SESSION_EXPIRED");
  const anyFailure = SOURCES.some((s) => state[s].kind !== null);
  return { anySessionExpired: expired.length > 0, expiredSources: expired, anyFailure };
}

// ── LIVE probes (Hermes `check_session_tokens`) — never served from cache ──
// Local session files can claim validity while the server disagrees (observed
// live 2026-09-27: MO local file "valid 22h", server said MO1097 not verified),
// so every probe here hits the source for a real answer.

export interface SessionProbe {
  live: boolean;
  detail: string;
  extra?: Record<string, unknown>;
}
function msg(e: any): string {
  return String(e?.message || e);
}

export async function probeSessionSource(source: SessionSource): Promise<SessionProbe> {
  if (store.probeOverride) return store.probeOverride(source);
  if (source === "breeze") {
    try {
      const m = await import("./icici-breeze/auth");
      // Establish the real session flow first (cache → env token →
      // generateSession). getCustomerDetails on a sessionless client answers
      // nothing useful, and initSession already reports failures into this
      // module (episode + alert), so the probe itself does not double-report.
      const okInit = await m.initSession();
      const ok = okInit ? await m.validateSession() : false;
      if (ok) reportSessionRecovery("breeze"); // live probe re-arms a stale episode
      const st = m.getSessionState();
      return {
        live: ok,
        detail: ok
          ? "live — getCustomerDetails OK"
          : `NOT live — session init ${okInit ? "ok" : "failed"}, status ${st.status}`,
        extra: { status: st.status, expiresAt: st.expiresAt, tokenPrefix: st.sessionToken ?? null },
      };
    } catch (e) {
      return { live: false, detail: `probe failed: ${msg(e)}` };
    }
  }
  if (source === "mo") {
    try {
      const m = await import("./motilal/auth");
      const p = await m.probeSession();
      if (p.ok) reportSessionRecovery("mo");
      return { live: p.ok, detail: p.message, extra: p.local as any };
    } catch (e) {
      return { live: false, detail: `probe failed: ${msg(e)}` };
    }
  }
  // nse — no token auth; liveness = can we reach an authenticated-ish JSON API
  try {
    const m = await import("./nse-api");
    const v = await m.getNSEIndiaVIX();
    if (v) reportSessionRecovery("nse");
    return v
      ? { live: true, detail: `live — allIndices OK (India VIX ${v.value})` }
      : { live: false, detail: "NOT live — allIndices probe empty (cookie/block?)" };
  } catch (e) {
    return { live: false, detail: `probe failed: ${msg(e)}` };
  }
}

// Manual Breeze token handoff (Hermes `set_breeze_session`) — wraps the existing
// generateSession() used by the breeze-connect route, then re-arms the episode.
export async function applyBreezeSession(
  token: string
): Promise<{ success: boolean; status?: string; error?: string }> {
  try {
    let res: { success: boolean; status?: string; error?: string };
    if (store.applyBreezeOverride) {
      res = await store.applyBreezeOverride(token);
    } else {
      const m = await import("./icici-breeze/auth");
      await m.generateSession(token);
      res = { success: true, status: m.getSessionState().status };
    }
    if (res.success) {
      // Fresh token → close the circuit breaker NOW so option-chain/candles
      // use Breeze on the very next request (not after a 1hr OPEN cooldown).
      const { providerHealth } = await import("./provider-health");
      providerHealth.resetProvider("breeze");
      reportSessionRecovery("breeze");
    }
    return res;
  } catch (e) {
    return { success: false, error: msg(e) };
  }
}

// Full payload for Hermes `check_session_tokens` (read-only).
export async function buildSessionStatusReport(
  source: string = "all"
): Promise<Record<string, unknown>> {
  const want = source === "all" ? SOURCES : [source] as SessionSource[];
  const probes: Record<string, SessionProbe> = {};
  for (const s of want) {
    if (!SOURCES.includes(s)) {
      probes[s] = { live: false, detail: `unknown source "${s}" (use breeze|mo|nse|all)` };
      continue;
    }
    probes[s] = await probeSessionSource(s);
  }
  const health = getSessionHealth();
  const summary = getSessionSummary();

  // Recorder candle-chain snapshot — dynamic import (capture.ts statically
  // imports this module; a static import here would be a cycle).
  let lastCandleCapture: unknown = null;
  let recorder: Record<string, unknown> | null = null;
  try {
    const cap = await import("./market/capture");
    const st = cap.getRecorderRuntimeState();
    lastCandleCapture = st.lastCandle;
    recorder = {
      totalCaptures: st.totalCaptures,
      totalFailures: st.totalFailures,
      lastFailure: st.lastFailure,
      lastSuccess: st.lastSuccess,
    };
  } catch (e) {
    recorder = { error: msg(e) };
  }

  const remedies: string[] = [];
  if (probes.breeze && !probes.breeze.live) {
    // HTML-escape <token> — see note in buildSessionMessage()
    const key = process.env.BREEZE_API_KEY || "&lt;BREEZE_API_KEY&gt;";
    remedies.push(
      `breeze: open https://api.icicidirect.com/apiuser/login?api_key=${key} (browser OTP), then send: set breeze session &lt;token&gt;`
    );
  }
  if (probes.mo && !probes.mo.live) {
    remedies.push("mo: verify MOTILAL_TOTP_KEY matches the registered authenticator (TOTP auto-recovery runs on next MO call)");
  }
  if (summary.anySessionExpired) {
    remedies.push(`active SESSION_EXPIRED episode(s): ${summary.expiredSources.join(", ")} — one Telegram alert per episode has been sent`);
  }
  return {
    checkedAt: new Date().toISOString(),
    source,
    probes,
    // recorded episodes incl. candle-chain failures (status surfaces)
    sessionHealth: health,
    summary,
    // last candle-chain result (source actually served, failures, degradation)
    lastCandleCapture,
    recorder,
    remedies,
  };
}

// ── Test seams ──

export function __setSessionAlertSenderForTests(sender: AlertSender | null): void {
  store.alertSender = sender;
}

export function __setSessionProbesForTests(fn: SessionProbeFn | null): void {
  store.probeOverride = fn;
}

export function __setApplyBreezeForTests(fn: ApplyBreezeFn | null): void {
  store.applyBreezeOverride = fn;
}

export function __resetSessionHealthForTests(): void {
  for (const s of SOURCES) state[s] = blankHealth();
  store.probeOverride = null;
  store.applyBreezeOverride = null;
}
