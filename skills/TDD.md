# Test-Driven Development (SMDApp)

## Core Principle

Write the test first. Watch it fail. Write minimal code to pass.

**If you didn't watch the test fail, you don't know if it tests the right thing.**

## When to Use

**Always:**
- New engines (scoring, analysis, detection)
- Bug fixes in existing logic
- Refactoring scoring weights or thresholds
- New API route logic

**Exceptions (ask first):**
- UI-only changes (component styling, layout)
- Config file updates (.env, prisma schema)
- Data source wiring (API fetch + fallback chain — test with real calls)

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over. No "keep as reference."

## Red-Green-Refactor Cycle

```
RED → Write failing test → Verify it fails correctly
GREEN → Minimal code to pass → Verify all tests pass
REFACTOR → Clean up → Keep tests green
```

### RED — Write Failing Test

One behavior per test. Clear name. Real code, not mocks.

```typescript
// src/lib/__tests__/sdm-engine.test.ts
import { describe, it, expect } from "bun:test";
import { computeSDMScore } from "../sdm-engine";

describe("computeSDMScore", () => {
  it("returns 0 for NO_DATA regime when all sources unavailable", () => {
    const result = computeSDMScore({
      regime: "NO_DATA",
      vix: null,
      spot: null,
      // ... minimal inputs
    });
    expect(result.score).toBe(0);
    expect(result.regime).toBe("NO_DATA");
  });
});
```

### Verify RED — Watch It Fail

```bash
bun test src/lib/__tests__/sdm-engine.test.ts
```

Confirm: test fails (not errors). Failure message is expected.

### GREEN — Minimal Code

Write simplest code to pass. Don't add features beyond the test.

### Verify GREEN — Watch It Pass

```bash
bun test
```

All tests pass. Output pristine.

### REFACTOR — Clean Up

After green only. Remove duplication. Improve names. Keep tests green.

## What to Test in SMDApp

| Component | What to Test | How |
|---|---|---|
| **Scoring engines** (SDM, ORCA, CAS) | Score calculation, regime detection, thresholds | Unit tests with fixed inputs |
| **Detection engines** (breakout, pullback, etc.) | Signal classification, scoring | Unit tests with known patterns |
| **Data fallback chains** | Breeze → NSE → Yahoo fallback order | Mock fetch, verify chain order |
| **Greeks calculator** | Black-Scholes math, edge cases | Known analytical values |
| **Backtest engines** | Trade replay, P&L calculation, MFE/MAE | Fixed trade + candle data |
| **CAS time engine** | Window detection, confirmation scoring | Fixed time + config inputs |
| **API routes** | Response shape, error handling | Integration tests with mocked fetch |
| **Trade state machine** | State transitions, guard conditions | Unit tests per transition |

## What NOT to Test

- UI rendering (use visual inspection)
- Prisma schema (use `bun run db:push`)
- External API response shape (we don't control it)
- Node/Next.js framework behavior

## Test File Location

```
src/lib/__tests__/<module-name>.test.ts    # unit tests
src/app/api/__tests__/<endpoint>.test.ts   # API route tests
```

## Running Tests

```bash
bun test                          # all tests
bun test src/lib/__tests__/       # specific directory
bun test --watch                  # watch mode
```

## Verification Checklist

Before marking work complete:
- [ ] Every new engine/function has a test
- [ ] Watched each test fail before implementing
- [ ] Each test failed for expected reason
- [ ] Wrote minimal code to pass
- [ ] All tests pass (`bun test`)
- [ ] No mocks unless absolutely unavoidable
