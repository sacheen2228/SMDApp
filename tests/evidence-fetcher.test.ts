import { describe, test, expect, afterEach } from "bun:test";
import { fetchTradeEvidence, setSnapshotsProvider } from "@/lib/evidence-fetcher";

afterEach(() => {
  // reset to default (null → defaultSnapshotsProvider hits sidecar, but these
  // tests always inject, and every test here injects)
  setSnapshotsProvider(null as any);
});

describe("fetchTradeEvidence failure-reason split", () => {
  const input = {
    symbol: "NIFTY",
    entryTime: "2026-09-27T10:00:00.000Z",
    spotFallback: 25000,
  };

  test("provider throw → 'recorder lookup failed: <msg>' (not a data-gap claim)", async () => {
    setSnapshotsProvider(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4001");
    });
    const ev = await fetchTradeEvidence(input);
    expect(ev.available).toBe(false);
    expect(ev.unavailableReason).toBe(
      "recorder lookup failed: connect ECONNREFUSED 127.0.0.1:4001"
    );
  });

  test("provider OK but empty → data-gap wording (unchanged)", async () => {
    setSnapshotsProvider(async () => []);
    const ev = await fetchTradeEvidence(input);
    expect(ev.available).toBe(false);
    expect(ev.unavailableReason).toBe(
      "historical OI/Greeks data not accessible for this date"
    );
  });
});
