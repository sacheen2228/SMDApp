# Validation Report (2026-07-13T19:17:24.076Z)

## Criteria
- **PASS** = healthy recorder (status HEALTHY, continuity >= 99%, no unexpected gaps).
- **WARNING** = expected gaps (startup/test windows, off-market hours) - degraded but within expected bounds.
- **FAIL** = recorder unhealthy or data integrity compromised.

> Note: the `Integrity Detection (faults injected)` case reports an UNHEALTHY
> recorder **by design** - the harness injected an empty-chain snapshot and a 9-minute
> gap to verify the detector. That UNHEALTHY status is an expected test artifact, not a
> real defect. The clean-baseline case is the true health check (HEALTHY/PASS).

- **PASS** Market Recorder - inserted=true idempotent-skip=true
- **PASS** Market Recorder (manual force) - manual force proceeds, results=1
- **PASS** Canonical Market Snapshot - id=NIFTY-2026-07-13T09:15:00.000Z pcrOi=1 maxPain=24200 atr=9.0 vwap=24525.8 chain=8
- **PASS** Replay Engine - getById=true sessionLen=4 reconstructAt(09:16:30)=2026-07-13T09:16:00.000Z
- **PASS** Scanner Recording - rows=4(exp4) noSnapshotFieldDup=true decisions=[SELL,REJECT,NO_TRADE,BUY]
- **PASS** Snapshot References - all 4 scanner results reference existing snapshots
- **PASS** Database Integrity - scanner.payload+snapshot_id+session_id=true UNIQUE(symbol,timestamp)=true
- **PASS** Recorder Health (clean baseline) - status=HEALTHY continuity=100% missing=0 incomplete=0
- **PASS** Integrity Detection (faults injected) - detector flagged missing=1 incomplete=1; recorder UNHEALTHY HERE is an EXPECTED artifact of injected faults, not a real defect
- **PASS** Duplicate Detection - UNIQUE(symbol,timestamp) enforced -> 0 dups (correct=0)
- **PASS** Missing Interval Detection - detected 1 gap(s) > 90s
- **PASS** Recorder Performance - insert 100=300ms readSession(100)=108ms

**Totals:** PASS=12 WARNING=0 FAIL=0
