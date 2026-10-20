# Breakout / fakeout validation (step 5)

Applies to **S2 (OI-wall breakout)**, **S4 (opening-range breakout)**, **S6 (short-covering)**
and **any entry taken near a level**. For S1/S5 it applies only when price is breaking a
level. A breakout is **VALID** only when all three MANDATORY checks pass **and at least 5 of
the 8 total checks pass**.

> Thresholds below are STARTING VALUES. Paper-trade them and tune per instrument — change
> `references/breakout-thresholds.json` (single source), never the prose.

## MANDATORY (all three must pass)

**a. Close confirmation** — a 15-minute candle must CLOSE beyond the validated level by at
least `max(0.1% of level, 0.25 × ATR)`. A wick beyond the level is a fakeout.

**b. Volume** — the breakout candle's volume (futures volume for indices) must be at least
`1.5×` the 20-candle average. Low-volume breakouts are fakeouts.

**c. OI confirmation**
- **Upside break**: Call OI at the broken strike is FALLING (writers exiting) and futures OI
  is RISING (or short-covering is visible). Put OI at nearby lower strikes is RISING.
- **Downside break**: Put OI at the broken strike is FALLING and Call OI at nearby higher
  strikes is RISING.
- If the wall OI is still INCREASING while price pushes through it, the wall is being
  defended → **fakeout risk, NO TRADE**.

## SUPPORTING

**d. Hold / retest** — the next candle holds beyond the level, or the retest stays within
`level ± buffer` without a close back inside.

**e. Candle quality** — body ≥ `60%` of the range and the close in the top `25%` (up) or
bottom `25%` (down) of the candle. A candle larger than `2× ATR` is exhaustion: do not
chase — wait for a retest.

**f. Room** — distance to the next opposing level is at least `2×` the stop-loss distance.

**g. Higher-timeframe + breadth alignment** — the 15-min/hourly trend agrees, and the
weighted heavyweights are at least `60%` in the breakout direction on the NSE heatmap:
- NIFTY: HDFCBANK, ICICIBANK, RELIANCE
- BANKNIFTY: HDFCBANK, ICICIBANK, SBIN

**h. Premium response** — the CE (or PE) premium rises with the move and ATM IV is not
falling more than `5%`. If spot breaks but the premium stays flat, treat as suspect.

## FAKEOUT RED FLAGS (any ONE ⇒ NO TRADE / wait)

- Price closes back inside the level within 2 candles.
- Rejection wick of at least `2×` the candle body at the level.
- Breakout volume below average, or declining across successive candles.
- Index breaks but futures OI is falling, or heavyweights diverge.
- Break occurs before 09:30 IST (unless S4), within 30 minutes of a scheduled event, or in
  the last 20 minutes of the session.
- The level has been poked 3 or more times in 60 minutes with no close beyond it.

## FAKEOUT REVERSAL (S3 only)

Enter against the failed break only after a close back inside the range, on above-average
volume, with the opposite wall OI holding or rising. Use the wick extreme as the
invalidation.

## Verdict

| Verdict | Meaning |
|---|---|
| `VALID_BREAKOUT` | all mandatory checks pass, ≥5 of 8 total, no red flag |
| `FAKEOUT` | a mandatory check failed, or a red flag is present |
| `WAIT_FOR_RETEST` | the break is real but the candle is too extended (exhaustion) — wait for a pullback instead of chasing |

`WAIT_FOR_RETEST` is a first-class third verdict: it avoids many false entries.

## Data needed (per snapshot)

- **futures volume and futures OI** (per snapshot) — checks **b** and **c**
- **5-minute and 15-minute candles** — checks **a**, **d**, **e**, **f**
- option chain OI at the broken strike and nearby strikes — check **c**
- heatmap constituents with % change — check **g**
- the previous snapshots (`snapshot_history/`) for OI/volume deltas — check **c**

Without them the affected checks report `UNKNOWN` and the agent cannot pass validation —
never guess a value.

## Usage

```bash
python3 scripts/breakout.py snapshot.json --level 24600 --direction up \
    --history snapshot_history --thresholds references/breakout-thresholds.json
```

Prints `{"breakout_validation": {...}}` ready to embed in the agent JSON output.
