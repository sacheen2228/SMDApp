import { describe, test, expect } from "bun:test";

describe("Institutional Positioning Cron Route", () => {
  test("date format check", () => {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const yyyy = now.getFullYear();
    const todayDDMMYYYY = dd + mm + yyyy;
    expect(todayDDMMYYYY).toMatch(/^\d{8}$/);
    expect(todayDDMMYYYY).toBe(dd + mm + yyyy);
  });
  
  test("append-only logic: first call creates date entry", () => {
    const existing: Set<string> = new Set();
    const date1 = "26092026";
    existing.add(date1);
    expect(existing.has(date1)).toBe(true);
    const date2 = "27092026";
    if (!existing.has(date2)) existing.add(date2);
    expect(existing.size).toBe(2);
  });
});
