/**
 * Order Book analytics tests — pure ingest + scorecard behaviour.
 * Feeds and API contracts are untouched; these cover the client-side
 * bucketing, wall tracking, waiting clocks and the today-scorecard.
 */
import { describe, test, expect } from "bun:test";
import {
  ingest,
  freshSession,
  nearestBig,
  fmtAge,
  istDayStart,
  updateScorecard,
  roundLevels,
  maxPutOiStrike,
  depthQuality,
  WALL_MEMORY_MS,
  type SessionState,
} from "../src/lib/order-book/analytics";
import type { BookSnapshot } from "../src/lib/order-book/types";

const CFG = { lot: 65, step: 5, near: 20 };

function snap(o: Partial<BookSnapshot> = {}): BookSnapshot {
  return {
    ltp: 24500,
    expiry: "2026-11-23",
    low: 24400,
    high: 24600,
    bids: [],
    asks: [],
    levels: 200,
    ts: Date.now(),
    ...o,
  };
}

describe("order-book analytics — ingest", () => {
  test("deep book buckets into 5-pt lots (NIFTY) and drops garbage levels", () => {
    const S = freshSession();
    const r = ingest(
      snap({
        bids: [
          [24497.5, 650], // → bucket 24495, 10 lots
          [24494, 325], //  → bucket 24490, 5 lots
          [0, 999], //       → dropped (no price)
          [24492, 0], //     → dropped (no qty)
        ],
        asks: [[24503, 1300]], // → bucket 24500, 20 lots
        levels: 200,
      }),
      S,
      CFG
    );
    expect(r.sh).toBe(false);
    expect(r.b.get(24495)).toBe(10);
    expect(r.b.get(24490)).toBe(5);
    expect(r.b.has(24492)).toBe(false);
    expect(r.a.get(24500)).toBe(20);
  });

  test("shallow book keeps real price levels (no bucketing)", () => {
    const S = freshSession();
    const r = ingest(
      snap({
        bids: [[24498.5, 65]],
        asks: [[24501.5, 130]],
        levels: 5,
      }),
      S,
      CFG
    );
    expect(r.sh).toBe(true);
    expect(r.b.get(24498.5)).toBe(1);
    expect(r.a.get(24501.5)).toBe(2);
    expect(r.spread).toBeCloseTo(3);
  });

  test("buyers/sellers % counts only lots within `near` of LTP (deep book)", () => {
    const S = freshSession();
    const r = ingest(
      snap({
        ltp: 24500,
        bids: [
          [24499, 3250], // within 20 → 50 lots
          [24400, 6500], // 100 pts away → ignored
        ],
        asks: [
          [24501, 3250], // within 20 → 50 lots
          [24700, 6500], // ignored
        ],
        levels: 200,
      }),
      S,
      CFG
    );
    expect(r.bp).toBe(50);
  });

  test("wall = bucket with > 2.5× mean lots", () => {
    const S = freshSession();
    // 10 levels: nine at 65 (1 lot), one at 325 (5 lots) → mean ≈ 1.4 → wall
    const bids = [[24495, 325]] as Array<[number, number]>;
    for (let i = 0; i < 9; i++) bids.push([24490 - i * 5, 65]);
    const asks = [[24505, 65]] as Array<[number, number]>;
    const r = ingest(snap({ bids, asks }), S, CFG);
    expect(r.walls.length).toBe(1);
    expect(r.walls[0].k).toBe(24495);
    expect(r.walls[0].side).toBe("b");
  });
});

describe("order-book analytics — wall waiting clocks", () => {
  test("first-seen is recorded once and preserved across ingests", () => {
    const S = freshSession();
    const t0 = istDayStart() + 10 * 60_000;
    const bids: Array<[number, number]> = [[24495, 3250]];
    const asks: Array<[number, number]> = [];
    for (let i = 0; i < 9; i++) asks.push([24505 + i * 5, 65]);

    ingest(snap({ bids, asks }), S, CFG, t0);
    expect(S.wallSeen.get("24495|b")).toBe(t0);

    const t1 = t0 + 22_000; // 22s later, same wall still there
    const r2 = ingest(snap({ bids, asks }), S, CFG, t1);
    expect(S.wallSeen.get("24495|b")).toBe(t0); // clock keeps running
    const big = nearestBig(r2.walls, 24500, S, "b", t1);
    expect(big).not.toBeNull();
    expect(big!.seenTs).toBe(t0);
    expect(big!.distance).toBe(5);
  });

  test("vanished wall is forgotten after WALL_MEMORY_MS (clock restarts)", () => {
    const S = freshSession();
    const t0 = istDayStart() + 10 * 60_000;
    // 1 big bid + 9 small asks → mean ~5.9 → bid is a wall
    const withWall = { bids: [[24495, 3250]] as Array<[number, number]>, asks: Array.from({ length: 9 }, (_, i) => [24505 + i * 5, 65] as [number, number]) };
    // same shape but the big level shrunk to a normal 1 lot
    const withoutWall = { bids: [[24495, 65]] as Array<[number, number]>, asks: withWall.asks };

    ingest(snap(withWall), S, CFG, t0);
    expect(S.wallSeen.get("24495|b")).toBe(t0);

    // wall gone, well beyond memory window
    const t1 = t0 + WALL_MEMORY_MS + 60_000;
    ingest(snap(withoutWall), S, CFG, t1);
    expect(S.wallSeen.has("24495|b")).toBe(false);

    // wall returns → new clock
    const t2 = t1 + 5_000;
    ingest(snap(withWall), S, CFG, t2);
    expect(S.wallSeen.get("24495|b")).toBe(t2);
  });
});

describe("order-book analytics — today's scorecard", () => {
  // Constant book shape across ingests (only LTP moves): one big buy wall at
  // 24495 (50 lots) + 9 one-lot asks. Mean ≈ 5.9 lots → the bid is a wall.
  // LTP starts 30 pts ABOVE the wall so the level begins as "watch".
  function book(ltp: number): BookSnapshot {
    return snap({
      ltp,
      bids: [[24495, 3250]],
      asks: Array.from({ length: 9 }, (_, i) => [24505 + i * 5, 65] as [number, number]),
    });
  }

  test("watch → reached → turned (buy wall holds)", () => {
    const S = freshSession();
    const t0 = istDayStart() + 10 * 60_000;

    ingest(book(24530), S, CFG, t0);
    expect(S.score.get("24495|b")!.status).toBe("watch");
    expect(S.score.get("24495|b")!.touchedTs).toBeNull();

    // price approaches within one bucket (5 pts)
    ingest(book(24498), S, CFG, t0 + 5_000);
    expect(S.score.get("24495|b")!.status).toBe("reached");

    // price backs away above the wall → turned
    ingest(book(24520), S, CFG, t0 + 10_000);
    const e = S.score.get("24495|b")!;
    expect(e.status).toBe("turned");
    expect(e.resolvedTs).toBe(t0 + 10_000);
  });

  test("buy wall breaks when price trades through", () => {
    const S = freshSession();
    const t0 = istDayStart() + 10 * 60_000;
    ingest(book(24530), S, CFG, t0);
    expect(S.score.get("24495|b")!.status).toBe("watch");
    ingest(book(24480), S, CFG, t0 + 5_000);
    expect(S.score.get("24495|b")!.status).toBe("broke");
  });

  test("sell wall breaks when price trades above it", () => {
    const S = freshSession();
    const t0 = istDayStart() + 10 * 60_000;
    // one big ask at 24565 (50 lots) + 9 one-lot bids; LTP 30 pts below → watch
    const asks: Array<[number, number]> = [[24565, 3250]];
    const bids: Array<[number, number]> = Array.from({ length: 9 }, (_, i) => [24495 - i * 5, 65] as [number, number]);
    ingest(snap({ ltp: 24500, bids, asks }), S, CFG, t0);
    expect(S.score.get("24565|a")!.status).toBe("watch");
    ingest(snap({ ltp: 24580, bids, asks }), S, CFG, t0 + 5_000);
    expect(S.score.get("24565|a")!.status).toBe("broke");
  });

  test("resolved levels stay resolved (no flicker back to reached)", () => {
    const S = freshSession();
    const t0 = istDayStart() + 10 * 60_000;
    ingest(book(24530), S, CFG, t0);
    ingest(book(24480), S, CFG, t0 + 5_000);
    expect(S.score.get("24495|b")!.status).toBe("broke");
    // price comes back — entry stays broke
    ingest(book(24498), S, CFG, t0 + 9_000);
    expect(S.score.get("24495|b")!.status).toBe("broke");
  });

  test("new IST day resets the scorecard and waiting clocks", () => {
    const S = freshSession();
    const day1 = istDayStart() + 10 * 60_000;
    ingest(book(24530), S, CFG, day1);
    expect(S.score.size).toBeGreaterThan(0);

    const day2 = istDayStart(day1 + 24 * 3600_000) + 10 * 60_000;
    ingest(book(24530), S, CFG, day2);
    expect(S.day).toBe(istDayStart(day2));
    expect(S.score.get("24495|b")!.seenTs).toBe(day2);
    expect(S.score.get("24495|b")!.status).toBe("watch");
  });

  test("updateScorecard is a no-op-safe on empty walls", () => {
    const S = freshSession();
    updateScorecard(24500, [], S, CFG);
    expect(S.score.size).toBe(0);
  });
});

describe("order-book analytics — nearest big levels", () => {
  test("picks the closest buyer below and seller above", () => {
    const S = freshSession();
    const t0 = istDayStart() + 10 * 60_000;
    // 4 big 50-lot levels + 16 one-lot fillers → mean ≈ 10.8 → all four are walls
    const bids: Array<[number, number]> = [
      [24400, 3250],
      [24480, 3250],
      ...Array.from({ length: 8 }, (_, i) => [24395 - i * 5, 65] as [number, number]),
    ];
    const asks: Array<[number, number]> = [
      [24550, 3250],
      [24600, 3250],
      ...Array.from({ length: 8 }, (_, i) => [24605 + i * 5, 65] as [number, number]),
    ];
    const r = ingest(snap({ ltp: 24500, bids, asks }), S, CFG, t0);
    const bb = nearestBig(r.walls, 24500, S, "b", t0);
    const bs = nearestBig(r.walls, 24500, S, "a", t0);
    expect(bb!.k).toBe(24480);
    expect(bb!.distance).toBe(20);
    expect(bs!.k).toBe(24550);
    expect(bs!.distance).toBe(50);
  });

  test("returns null when no big level on that side", () => {
    const S = freshSession();
    expect(nearestBig([], 24500, S, "b")).toBeNull();
    expect(nearestBig([{ k: 24400, side: "b", lots: 50, mult: 3 }], 24500, S, "a")).toBeNull();
  });
});

describe("order-book analytics — misc", () => {
  test("fmtAge renders honest durations", () => {
    expect(fmtAge(0)).toBe("0s");
    expect(fmtAge(42_000)).toBe("42s");
    expect(fmtAge(5 * 60_000)).toBe("5m");
    expect(fmtAge(8 * 3600_000 + 13 * 60_000)).toBe("8h 13m");
    expect(fmtAge(-1)).toBe("—");
    expect(fmtAge(NaN)).toBe("—");
  });

  test("liquidity EMA smooths across ingests (no reset-to-100)", () => {
    const S = freshSession();
    const t0 = istDayStart() + 10 * 60_000;
    const rich = snap({
      bids: Array.from({ length: 40 }, (_, i) => [24500 - (i + 1) * 5, 650] as [number, number]),
      asks: Array.from({ length: 40 }, (_, i) => [24500 + (i + 1) * 5, 650] as [number, number]),
    });
    const thin = snap({
      bids: [[24495, 65]],
      asks: [[24505, 65]],
    });
    const r1 = ingest(rich, S, CFG, t0);
    const d1 = r1.depth;
    const r2 = ingest(thin, S, CFG, t0 + 1_000);
    // EMA has memory: depth collapsed but EMA still well above the thin depth
    expect(r2.depth).toBeLessThan(d1 / 10);
    expect(S.emaDepth).toBeGreaterThan(r2.depth * 2);
  });
});

describe("order-book analytics — round-number levels (Stage 2)", () => {
  test("NIFTY 100-pt grid: below and above a mid-range LTP", () => {
    expect(roundLevels(24573, 100)).toEqual({ below: 24500, above: 24600 });
  });
  test("on-round LTP steps out, never 'just below' the price itself", () => {
    expect(roundLevels(24500, 100)).toEqual({ below: 24400, above: 24600 });
  });
  test("SENSEX 500-pt grid", () => {
    expect(roundLevels(79310, 500)).toEqual({ below: 79000, above: 79500 });
  });
  test("invalid input → null (never invented)", () => {
    expect(roundLevels(0, 100)).toBeNull();
    expect(roundLevels(-5, 100)).toBeNull();
    expect(roundLevels(24500, 0)).toBeNull();
    expect(roundLevels(NaN, 100)).toBeNull();
  });
});

describe("order-book analytics — max put OI strike (Stage 2)", () => {
  test("prefers the heaviest put strike at or below the LTP", () => {
    const rows = [
      { strike: 24000, pe: { oi: 5_000_000 } },
      { strike: 24500, pe: { oi: 8_000_000 } }, // biggest below LTP
      { strike: 24600, pe: { oi: 2_000_000 } },
    ];
    expect(maxPutOiStrike(rows, 24573)).toBe(24500);
  });
  test("falls back to the global max when all puts sit above the LTP", () => {
    const rows = [
      { strike: 24600, pe: { oi: 2_000_000 } },
      { strike: 24700, pe: { oi: 9_000_000 } },
    ];
    expect(maxPutOiStrike(rows, 24573)).toBe(24700);
  });
  test("garbage rows are skipped; empty payload → null", () => {
    expect(maxPutOiStrike([], 24500)).toBeNull();
    expect(maxPutOiStrike(null, 24500)).toBeNull();
    expect(
      maxPutOiStrike(
        [
          { strike: 0, pe: { oi: 5 } },
          { strike: 24500, pe: { oi: null } },
          { strike: "abc", pe: { oi: 7 } },
          { strike: 24600 },
        ],
        24500
      )
    ).toBeNull();
  });
});

describe("order-book analytics — depth quality badge (Stage 2)", () => {
  test("offline when no snapshot ever arrived", () => {
    expect(depthQuality(false, 0, 0)).toBe("offline");
  });
  test("stale when the snapshot is older than FRESH_MS", () => {
    expect(depthQuality(true, 200, 16_000)).toBe("stale");
    expect(depthQuality(true, 5, NaN)).toBe("stale");
  });
  test("shallow vs deep on fresh books", () => {
    expect(depthQuality(true, 5, 1_000)).toBe("shallow");
    expect(depthQuality(true, 200, 1_000)).toBe("deep");
  });
});
