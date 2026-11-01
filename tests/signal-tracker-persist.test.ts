// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL TRACKER PERSISTENCE TESTS
//
// The Oct-20 duplicate-alert incident: signal dedup lived only in process
// memory (signalTracker Map + telegram.ts recentAlerts + intradayState Set),
// so every server reboot wiped the day's dedup and the same signature was
// re-announced — 5 reboots on Oct 20, duplicates all day.
//
// The hardening (2026-10-21): full-day signatures + short-term throttle keys
// are write-through persisted to data/signal-dedup.json (atomic tmp+rename,
// pruned to today + 2 previous days) and merged back on boot.
//
// These tests are OFFLINE: no Telegram send, no network.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildSignalSignature,
  markSignalSent,
  isSignalAlreadySent,
  isSignalDuplicateOrLowerQuality,
  getTodaySignals,
  restoreRecentAlerts,
  recordRecentAlert,
  dedupFilePath,
  __resetDedupForTests,
} from "../src/lib/signalTracker";

const dir = mkdtempSync(join(tmpdir(), "signal-dedup-test-"));
const FILE = join(dir, "signal-dedup.json");
process.env.SIGNAL_DEDUP_FILE = FILE;

const SIG = buildSignalSignature({ symbol: "NIFTY", strike: 24500, optionType: "PE", direction: "BUY_PE" });

const todayKey = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const dayKeyAdd = (key: string, days: number): string => {
  const d = new Date(`${key}T12:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};

beforeEach(() => {
  process.env.SIGNAL_DEDUP_FILE = FILE;
  __resetDedupForTests();
  rmSync(FILE, { force: true });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("signal-dedup persistence — save → reload → duplicate rejected", () => {
  it("markSignalSent writes through to the store file (atomic, no tmp leftovers)", () => {
    markSignalSent(SIG, 82, "unit-test");
    expect(existsSync(FILE)).toBe(true);
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.days[todayKey()][SIG]).toBeTruthy();
    expect(raw.days[todayKey()][SIG].confidence).toBe(82);
    // atomic write: no orphaned *.tmp file next to the store
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("a simulated reboot still rejects the already-sent signature", () => {
    markSignalSent(SIG, 82, "unit-test");
    // ── REBOOT: process memory wiped, file survives ──
    __resetDedupForTests();

    expect(isSignalAlreadySent(SIG)).toBe(true);
    // same confidence → duplicate, lower confidence → lower-quality re-run, both blocked
    expect(isSignalDuplicateOrLowerQuality(SIG, 82)).toBe(true);
    expect(isSignalDuplicateOrLowerQuality(SIG, 60)).toBe(true);
    // a genuinely HIGHER-confidence re-run is still allowed (quality upgrade)
    expect(isSignalDuplicateOrLowerQuality(SIG, 90)).toBe(false);
  });

  it("boot merge is additive — pre-existing entries survive a later markSignalSent", () => {
    markSignalSent(SIG, 82, "unit-test");
    __resetDedupForTests();

    const other = buildSignalSignature({ symbol: "SENSEX", strike: 78000, optionType: "CE", direction: "BUY_CE" });
    markSignalSent(other, 75, "unit-test");

    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    expect(raw.days[todayKey()][SIG]).toBeTruthy();
    expect(raw.days[todayKey()][other]).toBeTruthy();
    expect(isSignalAlreadySent(SIG)).toBe(true);
  });

  it("getTodaySignals reports persisted entries after a reboot (digest truth)", () => {
    markSignalSent(SIG, 82, "unit-test");
    __resetDedupForTests();
    const today = getTodaySignals();
    expect(today.has(SIG)).toBe(true);
    expect(today.get(SIG)?.source).toBe("unit-test");
  });
});

describe("signal-dedup persistence — bounded store (prune > 2 days)", () => {
  it("drops days older than today-2, keeps today / yesterday / day-before", () => {
    const today = todayKey();
    const y1 = dayKeyAdd(today, -1);
    const y2 = dayKeyAdd(today, -2);
    const y3 = dayKeyAdd(today, -3);
    writeFileSync(FILE, JSON.stringify({
      version: 1,
      days: {
        [y3]: { [SIG]: { sentAt: "2026-01-01T05:00:00.000Z", confidence: 70, source: "old" } },
        [y2]: { [SIG]: { sentAt: "2026-01-01T05:00:00.000Z", confidence: 71, source: "old2" } },
        [y1]: { [SIG]: { sentAt: "2026-01-01T05:00:00.000Z", confidence: 72, source: "yesterday" } },
        [today]: { [SIG]: { sentAt: new Date().toISOString(), confidence: 82, source: "today" } },
      },
      recent: { [SIG]: Date.now(), "STALE|1|CE|BUY": Date.now() - (25 * 60 * 60 * 1000) },
    }));

    __resetDedupForTests();
    getTodaySignals(); // first touch → load + prune + save

    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    expect(Object.keys(raw.days).sort()).toEqual([y1, y2, today].sort());
    // 25-hour-old throttle key pruned with it
    expect(raw.recent[SIG]).toBeTruthy();
    expect(raw.recent["STALE|1|CE|BUY"]).toBeUndefined();
  });
});

describe("signal-dedup persistence — corrupt file tolerance", () => {
  it("ignores an unreadable/corrupt file, starts fresh, and overwrites cleanly", () => {
    writeFileSync(FILE, '{"version":1,"days":{"2026-10-21":{{{NOT JSON');
    __resetDedupForTests();

    // must not throw, must start fresh
    expect(isSignalAlreadySent(SIG)).toBe(false);
    expect(getTodaySignals().size).toBe(0);

    // …and the next write repairs the file
    markSignalSent(SIG, 80, "unit-test");
    const raw = JSON.parse(readFileSync(FILE, "utf8")); // valid JSON again
    expect(raw.days[todayKey()][SIG].confidence).toBe(80);
  });

  it("tolerates a well-formed file with junk sections (merge, not replace)", () => {
    writeFileSync(FILE, JSON.stringify({
      version: 1,
      days: { [todayKey()]: { [SIG]: { sentAt: new Date().toISOString(), confidence: 77, source: "junkfile" } } },
      recent: { "GOOD|1|CE|BUY": Date.now(), "BAD|1|CE|BUY": "not-a-number" },
      unexpected: { a: 1 },
    }));
    __resetDedupForTests();
    expect(isSignalAlreadySent(SIG)).toBe(true);
    const restored = restoreRecentAlerts();
    expect(restored.has("GOOD|1|CE|BUY")).toBe(true);
    expect(restored.has("BAD|1|CE|BUY")).toBe(false);
  });
});

describe("short-term throttle (telegram.ts recentAlerts) survives a reboot", () => {
  it("recordRecentAlert → reboot → restoreRecentAlerts still has the key", () => {
    recordRecentAlert(SIG, Date.now());
    __resetDedupForTests();
    const restored = restoreRecentAlerts();
    expect(restored.has(SIG)).toBe(true);
    expect(Date.now() - (restored.get(SIG) as number)).toBeLessThan(1000);
  });

  it("expired (>24h) throttle keys are not restored", () => {
    recordRecentAlert(SIG, Date.now() - (25 * 60 * 60 * 1000));
    __resetDedupForTests();
    expect(restoreRecentAlerts().has(SIG)).toBe(false);
  });
});

describe("telegram.ts short-term throttle wiring (5-min cooldown is persisted)", () => {
  it("checkTradeDedup writes its throttle key to the store; a reboot still restores it", async () => {
    const { checkTradeDedup } = await import("../src/lib/telegram");
    const sig = buildSignalSignature({ symbol: "WIRED", strike: 111, optionType: "CE", direction: "BUY_CE" });

    // first check: not yet sent, not throttled — but the key IS recorded
    expect(checkTradeDedup("WIRED", "BUY_CE", 111, "CE")).toBe(false);
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    expect(raw.recent[sig]).toBeTruthy();

    // ── REBOOT: in-memory throttle map gone, file survives ──
    __resetDedupForTests();
    expect(restoreRecentAlerts().has(sig)).toBe(true);

    // same process, inside the 5-minute cooldown → throttled
    expect(checkTradeDedup("WIRED", "BUY_CE", 111, "CE")).toBe(true);
  });
});

describe("test-runner default is memory-only (no cross-run dedup leakage)", () => {
  it("without SIGNAL_DEDUP_FILE the store is not loaded or written", () => {
    const saved = process.env.SIGNAL_DEDUP_FILE;
    delete process.env.SIGNAL_DEDUP_FILE;
    try {
      expect(dedupFilePath()).toBeNull(); // NODE_ENV=test → memory-only
      __resetDedupForTests();
      markSignalSent(SIG, 82, "unit-test");
      expect(restoreRecentAlerts().size).toBe(0);
      recordRecentAlert(SIG, Date.now());
      // reboot simulation: memory-only state is simply gone (previous behaviour)
      __resetDedupForTests();
      expect(isSignalAlreadySent(SIG)).toBe(false);
    } finally {
      process.env.SIGNAL_DEDUP_FILE = saved as string;
      __resetDedupForTests();
    }
  });
});
