/// <reference types="bun-types" />
// The DEFAULT expiry must never be a dead contract.
//
// The exchange lists today's contract FIRST. After its 15:30 IST expiry
// session ends that contract is dead, and every "pick the first expiry"
// consumer used to serve it — the DD tab was analysing a contract that had
// already expired while the Option Chain tab had moved on to the next one.

import { describe, expect, test } from "bun:test";
import {
  isExpiryExpired,
  selectNearestLiveExpiry,
  toIsoDate,
} from "@/lib/expiry-date";

/** 2026-11-26 is a Thursday; 15:30 IST = 10:00 UTC. */
const EXPIRY_DAY = "26-Nov-2026";
const NEXT_WEEKLY = "03-Dec-2026";
const AFTER_CLOSE_IST = new Date("2026-11-26T11:00:00.000Z"); // 16:30 IST
const DURING_SESSION_IST = new Date("2026-11-26T06:00:00.000Z"); // 11:30 IST

describe("selectNearestLiveExpiry — the one default-expiry rule", () => {
  test("during the expiry session today's contract is still live", () => {
    expect(isExpiryExpired(EXPIRY_DAY, DURING_SESSION_IST)).toBe(false);
    expect(selectNearestLiveExpiry([EXPIRY_DAY, NEXT_WEEKLY], DURING_SESSION_IST)).toBe(EXPIRY_DAY);
  });

  test("after the expiry session the dead contract is skipped", () => {
    expect(isExpiryExpired(EXPIRY_DAY, AFTER_CLOSE_IST)).toBe(true);
    expect(selectNearestLiveExpiry([EXPIRY_DAY, NEXT_WEEKLY], AFTER_CLOSE_IST)).toBe(NEXT_WEEKLY);
  });

  test("a contract from a previous day is never live", () => {
    expect(isExpiryExpired("25-Nov-2026", DURING_SESSION_IST)).toBe(true);
  });

  test("the list is sorted by date, not by the exchange's order", () => {
    expect(
      selectNearestLiveExpiry(
        ["10-Dec-2026", "03-Dec-2026", "26-Nov-2026"],
        AFTER_CLOSE_IST,
      ),
    ).toBe("03-Dec-2026");
  });

  test("never invents a date that is not in the list", () => {
    expect(selectNearestLiveExpiry(["garbage", ""], AFTER_CLOSE_IST)).toBeNull();
    expect(selectNearestLiveExpiry(null, AFTER_CLOSE_IST)).toBeNull();
    expect(selectNearestLiveExpiry(undefined, AFTER_CLOSE_IST)).toBeNull();
  });

  test("every live expiry still parses to a comparable ISO date", () => {
    expect(toIsoDate(EXPIRY_DAY)).toBe("2026-11-26");
    expect(toIsoDate(NEXT_WEEKLY)).toBe("2026-12-03");
  });
});
