/**
 * mergeExpiryCandidates — the ONE candidate list a provider chain path may use.
 *
 * Bug locked down: icici-breeze/option-chain.ts built its own naive weekday
 * ladder (every Tuesday, holidays blind). It invented Tue 10-Nov-2026 — a
 * trading holiday; the exchange settled that week on Mon 09-Nov-2026. The UI
 * auto-selected expiries[0] = "10-Nov-2026", the expiry gate rejected it
 * (EXPIRY_UNAVAILABLE → HTTP 400) and the option-chain tab looped on 400s.
 *
 * The merge = expiry-calculator's calendar (exchange-aware + holiday-shift
 * aware) ∪ the provider's real contract dates — normalized, dead sessions
 * dropped, ascending. Offline: no network, no provider calls.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import {
  mergeExpiryCandidates,
  setExchangeExpiries,
  isHoliday,
} from "../src/lib/expiry-calculator";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseBreeze(s: string): Date | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (!m) return null;
  const mo = MONTHS.findIndex((x) => x.toLowerCase() === m![2].toLowerCase());
  if (mo < 0) return null;
  return new Date(+m[3], mo, +m[1]);
}

beforeAll(() => {
  // SENSEX gets an explicit exchange list (Thursday weeklies) — the exchange
  // branch must win over any weekday computation.
  setExchangeExpiries("SENSEX", ["2026-11-12", "2026-11-19", "2026-11-26", "2026-12-03"]);
});

describe("mergeExpiryCandidates", () => {
  test("exchange branch: exactly the published dates, holiday dates never invented", () => {
    const out = mergeExpiryCandidates("SENSEX", []);
    expect(out).toContain("12-Nov-2026");
    expect(out).toContain("19-Nov-2026");
    expect(out).toContain("26-Nov-2026");
    expect(out).toContain("03-Dec-2026");
    // The old naive ladder's output must never appear.
    expect(out).not.toContain("10-Nov-2026");
    expect(out).not.toContain("24-Nov-2026");
  });

  test("provider contract dates survive, normalized to Breeze format, garbage dropped", () => {
    const out = mergeExpiryCandidates("SENSEX", ["15-Jan-2030", "2030-03-05", "not-a-date", ""]);
    expect(out).toContain("15-Jan-2030");
    expect(out).toContain("05-Mar-2030");
    expect(out).not.toContain("not-a-date");
  });

  test("dead sessions are dropped (provider AND calendar side)", () => {
    const out = mergeExpiryCandidates("SENSEX", ["01-Jan-2020", "05-Jun-2026"]);
    expect(out).not.toContain("01-Jan-2020");
    expect(out).not.toContain("05-Jun-2026");
    // nothing in the output is in the past
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (const d of out) {
      const dt = parseBreeze(d)!;
      expect(dt.getTime()).toBeGreaterThanOrEqual(today.getTime());
    }
  });

  test("output is strictly ascending", () => {
    const out = mergeExpiryCandidates("SENSEX", ["15-Jan-2030"]);
    const times = out.map((d) => parseBreeze(d)!.getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });

  test("calendar-only branch (no exchange list): never emits a holiday or weekend date", () => {
    // NIFTYNXT50: Tuesday weeklies in the calendar, no exchange list pushed,
    // no provider dates — pure ladder output.
    const out = mergeExpiryCandidates("NIFTYNXT50", []);
    expect(out.length).toBeGreaterThan(0);
    for (const d of out) {
      const dt = parseBreeze(d)!;
      expect(isHoliday(dt)).toBe(false);
      expect(dt.getDay()).not.toBe(0);
      expect(dt.getDay()).not.toBe(6);
    }
    // THE production bug: a holiday Tuesday is shifted back, never emitted.
    expect(out).not.toContain("10-Nov-2026");
    expect(out).not.toContain("24-Nov-2026");
  });

  test("symbol switch: NIFTY output never contains the holiday Tuesdays either", () => {
    const out = mergeExpiryCandidates("NIFTY", []);
    expect(out).not.toContain("10-Nov-2026");
    expect(out).not.toContain("24-Nov-2026");
    for (const d of out) expect(isHoliday(parseBreeze(d)!)).toBe(false);
  });
});
