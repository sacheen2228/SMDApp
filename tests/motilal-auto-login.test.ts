/**
 * autoLogin OTP-dispatch guards (bug: background auto-recovery rotated the
 * AuthToken on every attempt, re-queueing OTP SMS — MO throttled, nothing
 * arrived, and a delivered OTP would verify against a stale token).
 *
 * Guards under test:
 *  1. a pending UNVERIFIED session is reused — no new OTP-flow dispatch
 *  2. explicit dispatches are throttled by a cooldown window
 *  3. after the cooldown a fresh dispatch is allowed (recovery path)
 *
 * Hermetic under full-suite ordering:
 *  - the module may already be imported by other suites (candle-chain etc.)
 *    with .env's MOTILAL_TOTP_KEY captured → TOTP attempts are failed by the
 *    mock (body contains `totp`) so the OTP logic under test always runs
 *  - MOTILAL_SESSION_FILE redirects save/restore/unlink away from the live
 *    app's /tmp/motilal-session.json
 *
 * Offline: global fetch mocked; no network.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, unlinkSync, existsSync } from "fs";

const SESSION_FILE = "/tmp/motilal-auto-login-test-session.json";

type FetchCall = { url: string; isTotp: boolean };
let calls: FetchCall[] = [];
let authdirectapiRespond: () => Record<string, unknown> = () => ({
  status: "SUCCESS",
  AuthToken: "T-TEST",
  isAuthTokenVerified: "FALSE",
});

function resp(payload: Record<string, unknown>) {
  return { json: async () => payload } as Response;
}

function installFetch() {
  (globalThis as any).fetch = async (url: any, init?: any) => {
    const u = String(url);
    let body: any = {};
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    } catch {
      /* ignore */
    }
    const isTotp = u.includes("authdirectapi") && !!body.totp;
    calls.push({ url: u, isTotp });
    if (isTotp) return resp({ status: "FAILED", message: "Invalid TOTP Value" });
    if (u.includes("authdirectapi")) return resp(authdirectapiRespond());
    return resp({ status: "SUCCESS" });
  };
}

let auth: typeof import("../src/lib/motilal/auth");

beforeAll(async () => {
  process.env.MOTILAL_USERID = "TESTUSER";
  process.env.MOTILAL_PASSWORD = "pw";
  process.env.MOTILAL_DOB = "01011990";
  // MOTILAL_TOTP_KEY is intentionally NOT touched — .env may supply it and an
  // earlier suite may have already imported the module with it captured.
  process.env.MOTILAL_SESSION_FILE = SESSION_FILE;

  installFetch();
  auth = await import("../src/lib/motilal/auth");

  // hard-reset whatever session state the shared module imported with
  await auth.logout(); // unlinks via sessionFile() → test path only
  auth.clearOtpDispatchCooldown(); // an earlier suite may have armed it
  writeFileSync(
    SESSION_FILE,
    JSON.stringify({
      sessionToken: "SEED-PENDING",
      accessToken: null,
      sessionExpiry: Date.now() + 60 * 60 * 1000,
      isVerified: false,
    })
  );
  auth.reloadSession(); // memory now holds the pending unverified SEED
});

afterAll(() => {
  try {
    if (existsSync(SESSION_FILE)) unlinkSync(SESSION_FILE);
  } catch {
    /* ignore */
  }
});

// OTP-flow dispatches only — TOTP attempts are expected noise (mock fails them)
const count = () => calls.filter((c) => c.url.includes("authdirectapi") && !c.isTotp).length;

test("pending unverified session is reused — no new authdirectapi dispatch", async () => {
  calls = [];
  const ok = await auth.autoLogin();
  expect(ok).toBe(true);
  expect(count()).toBe(0); // the OTP for SEED-PENDING must not be re-queued
});

test("after logout the first call dispatches once; the next reuses the pending token", async () => {
  await auth.logout();
  calls = [];

  authdirectapiRespond = () => ({
    status: "SUCCESS",
    AuthToken: "T-1",
    isAuthTokenVerified: "FALSE",
  });

  expect(await auth.autoLogin()).toBe(true);
  expect(count()).toBe(1);

  expect(await auth.autoLogin()).toBe(true);
  expect(count()).toBe(1); // pending reuse, not a second dispatch
});

test("within cooldown, with no session, autoLogin does not dispatch; after cooldown it does", async () => {
  await auth.logout(); // session gone, cooldown still armed from the dispatch above
  calls = [];

  expect(await auth.autoLogin()).toBe(false);
  expect(count()).toBe(0); // suppressed by cooldown — no SMS re-queue

  const realNow = Date.now;
  Date.now = () => realNow() + 3 * 60 * 1000; // step past the 2-minute window
  try {
    expect(await auth.autoLogin()).toBe(true);
    expect(count()).toBe(1); // recovery dispatch allowed again
  } finally {
    Date.now = realNow;
  }
});
