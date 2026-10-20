# Agent rules, veto catalogue and path mapping

The orchestrator (`scripts/orchestrator.py`) runs a five-agent panel.  Every
rule below is measured, never asserted, and every failed validation is a
**mandatory veto** that ends in NO TRADE.

## 1. The panel

| Agent | Process | Owns | Vote |
|---|---|---|---|
| A | parent (in-process) | the context (`data/context.json`) | **none** - context is not a vote |
| B | child process | chain / OI / PCR / level validation | CE / PE / NEUTRAL |
| C | child process | structure (BOS/CHoCH/sweeps) + breakout/fakeout | CE / PE / NEUTRAL |
| D | child process | the GEX engine's record + its gates | CE / PE / NEUTRAL |
| E | child process | strike, stop, targets, sizing (the sole owner) | the final plan |

**Delegation mechanism (real):** B, C and D are separate `python3` processes
(`scripts/agents/agent_b.py` etc.).  The task is JSON on stdin, the result is
JSON on stdout, and the parent enforces a hard **20 s** budget per agent.
Anything other than a well-formed result is a veto:

| failure | veto |
|---|---|
| the agent exceeded 20 s | `AGENT_TIMEOUT` |
| the process exited non-zero | `AGENT_FAILED` |
| stdout was not JSON | `AGENT_INVALID_JSON` |
| a required field was missing | `AGENT_MISSING_FIELD` |

B, C and D run **concurrently** (a thread pool of child processes).

## 2. Agent A - the context

Reads `data/context.json` (the pre-market bias, the breadth, the movers and
their freshness).  It never votes.

* `OK` - the context is fresh (generated_at within 12 h, not in the future)
* `STALE` / `MISSING` / `CORRUPT` / `FUTURE` - reported, never silently used

A missing or stale context is **not** a veto: a context that is absent cannot
oppose anything.  It DOES disable the A+ escape hatch (see §5), because you
cannot claim a counter-bias setup without knowing the bias.

## 3. Agent B - chain / OI / PCR / levels

Mandatory vetoes (all of them end the run in NO TRADE):

| veto | rule |
|---|---|
| `SNAPSHOT_TIMESTAMP_MISSING` | the snapshot must carry a parseable data timestamp |
| `SNAPSHOT_TIMESTAMP_FUTURE` | the timestamp must not be in the future |
| `SNAPSHOT_STALE` | the snapshot must be <= 15 min old |
| `LIVE_SPOT_UNAVAILABLE` | a live spot is needed to compare the chain against |
| `SPOT_MISMATCH` | chain spot vs live spot <= 0.1% |
| `FROZEN_FEED` | the chain (OI + spot) must change between two snapshots |
| `LEVEL_TWO_SOURCE` | >= 2 independent sources within +-0.15% of the wall |
| `WALL_RATIO` | the wall's OI >= 1.5x the next-strongest strike on the same side |
| `LEVEL_CLOSED_BEYOND` | no 15-minute close beyond the level |
| `LEVEL_UNSTABLE` | the wall must not have migrated by more than one strike |
| `PCR_HISTORY_INSUFFICIENT` | >= 3 snapshots for the PCR trend |
| `PCR_TREND_NOT_ALIGNED` | the PCR must move in the trade direction across those snapshots |

The independent sources for a level are: the OI wall itself, the recent swing
levels (from `scripts/structure.py`), the VWAP, the previous day's
high/low and the classic pivot point.  A side is usable only when it has **no**
veto of its own - the other side's vetoes are not global failures (a CE trade
only needs valid support; a broken resistance is normal).

## 4. Agent C - structure + breakout / fakeout

Structure comes from `scripts/structure.py` (swings, BOS, CHoCH, sweeps -
closed candles only).  The breakout / fakeout validation comes from the skill's
EXISTING `scripts/breakout.py` (close confirmation, volume, OI confirmation,
fakeout red flags, verdict) - it is not re-implemented.

| veto | rule |
|---|---|
| `STRUCTURE_INSUFFICIENT_CANDLES` | >= 6 closed 15-minute bars |
| `STRUCTURE_UNKNOWN` | the structure trend must be resolved |
| `STRUCTURE_NO_EVENT` / `STRUCTURE_STALE_EVENT` | a BOS/CHoCH within the last 3 bars |
| `STRUCTURE_SWEEP_ONLY` | a sweep without a close is not a break |
| `STRUCTURE_OPPOSING_CHOCH` | no CHoCH against the trade direction |
| `STRUCTURE_SWEEP_AGAINST` | no liquidity sweep on the opposite side |
| `BREAKOUT_NOT_APPLICABLE` | a breakout must be applicable at the structure level |
| `BREAKOUT_MANDATORY_FAILED` | close >= 0.1% beyond (or 0.25x ATR), volume >= 1.5x, OI confirmation |
| `BREAKOUT_FAKE_OUT_FLAG` | no fakeout red flag |
| `BREAKOUT_FAKEOUT` / `BREAKOUT_NOT_CONFIRMED` | the verdict must be VALID_BREAKOUT |
| `BREAKOUT_VOLUME_UNMEASURABLE` | the volume ratio must be measurable |

Two documented deviations from `scripts/breakout.py` (the file itself is
frozen and was NOT modified):

1. **Volume** - the NSE index chart carries no volume, so `breakout.py` falls
   back to the snapshot's index-futures volume, but one snapshot has no
   20-bar baseline.  When the candles have no volume, Agent C measures the
   ratio itself from the REAL futures volume in the snapshot history
   (cumulative volume delta per interval vs the average interval delta).  A
   ratio that cannot be measured is UNKNOWN and can never pass.
2. **The "poked N times" red flag** - `breakout.py` counts every snapshot on
   the wrong side of the level, which is a false positive for a level the price
   just broke through from below.  Agent C re-verifies the flag against the
   real level touches (a snapshot whose 15-minute bar actually tested the
   level without closing beyond it).  The flag only survives when the verified
   count reaches the threshold; the re-verification is reported in the notes.

## 5. Consensus and the A+ escape hatch

* The direction needs **>= 2 of {B, C, D}** on the same side (CE or PE).
* A **neutral** vote does not count.
* An **opposing** vote (one CE, one PE) ends the run in NO TRADE.
* Any **mandatory veto** from any agent ends the run in NO TRADE.

**Agent A's context never votes.**  It only detects a CONFLICT: a BULLISH
context against a BUY_PE (or BEARISH against a BUY_CE).  A conflict forces an
objectively measured **A+ setup**, otherwise NO TRADE.  The A+ checklist (all
of them must hold):

| check | measurement |
|---|---|
| `context_fresh` | the context status is OK |
| `level_sources_3` | Agent B: >= 3 sources within +-0.15% of the level |
| `wall_ratio_2x` | Agent B: the wall ratio >= 2.0x |
| `breakout_valid` | Agent C: the verdict is VALID_BREAKOUT |
| `breakout_passes_6` | Agent C: >= 6 of the 8 breakout checks pass |
| `consensus_3of3` | B, C and D all agree on the same direction |
| `gex_clean` | Agent D has no veto |

A+ met => the size is **halved** (and the trade says so).

## 6. Agent D - the GEX engine

`scripts/gex_engine.py` is the ONLY place gamma exposure is computed.  Agent D
never re-derives GEX: it runs the engine, validates the record against
`references/gex-output-schema.json` (a schema error is a veto) and checks the
regime -> strategy mapping:

| regime | strategy |
|---|---|
| `POSITIVE_GEX` | `GEX-1 PIN_FADE` |
| `NEGATIVE_GEX` | `GEX-3 NEG_TREND` (`GEX-4 WALL_BREAK` while net GEX is falling) |
| `TRANSITION` | `GEX-2 FLIP_BREAK` - only after a confirmed 15-minute close beyond the flip |

GEX gates (all of them are hard NO TRADE gates): the snapshot is < 15 min old
(and not in the future), >= 3 history snapshots, the 09:30-15:00 IST session
window, >= 3 h to expiry, a non-frozen feed, and the 30-minute cooldown
between two GEX trades.

**GEX isolation:** `engine="GEX"`, `trade_id` starts with `GEX-`, the alerts go
to the GEX channel only (the outbox record carries the target chat id env
var), the GEX record is never merged into the main bias score and GEX
contributes at most ONE vote to the consensus.

## 7. Agent E - strike, stop, targets, sizing

| rule | threshold |
|---|---|
| delta | 0.50-0.60 preferred, never below 0.35 |
| liquidity | the strike must be in the top-5 OI on the traded side |
| spread | bid-ask <= 2% of the mid |
| lot size | the AUTHORITATIVE contract master (`scripts/contract_master.py` -> `src/lib/symbol-config.ts` / the NSE bhavcopy `NewBrdLotQty`).  A stock never inherits NIFTY's lot; an unknown lot fails closed. |
| premium stop | 25%-30% of the premium, sitting on the underlying invalidation (never beyond it) |
| TP1 | reward:risk >= 1:2 (2R) |
| TP2 | 3R, inside the expected move |
| expiry | < 3 h to expiry -> NO TRADE |
| theta | > 10% of the premium per day -> NO TRADE |
| VIX | > 20 -> half the size |
| lots | min(risk-limited, affordable, strategy cap), always rounded DOWN |
| lots = 0 | NO TRADE |

**Account equity is never hardcoded.**  It comes from a validated source
(`scripts/account_equity.py`): the file `data/account_equity.json`
(`{equity, source, as_of}` - source and as_of are required) or the app's
Breeze funds endpoint (`/api/positions` -> `data.funds.allocated_equity`).
A missing / non-positive / unattributed / stale equity is a NO TRADE.

**Expected move:** the GEX record's `expected_move_1sigma` is the one-day
ATM-IV move (the schema's definition).  The TP2 containment gate uses the
skill's own measure (`references/scoring-rules.md`): 0.85 x the ATM straddle
to expiry.  Both numbers are printed in the check.

## 8. Output

`references/orchestrator-output-schema.json` (validated with
`scripts/jsonschema_mini.py`, stdlib only).  The core keys are the skill's own
`references/output-schema.md` (agent_id, timestamp_ist, instrument, action,
trade, reasons, gates_failed); the extra blocks are additive.

A NO TRADE record names the failed gate, the responsible agent, the observed
value and the threshold (`gates_failed[]`) and carries a three-line
plain-language summary.  No price, level or confidence is ever fabricated.

## 9. Path mapping (the vendored package -> this skill)

| the package's file | where it lives now | note |
|---|---|---|
| `scripts/gex_engine.py` | `scripts/gex_engine.py` | adapted: validated equity (no hardcoded capital), the option math moved to `scripts/option_math.py`, extra gates (>= 3 history snapshots, unknown lot, missing/invalid/future timestamp), GEX-2 restricted to TRANSITION |
| `scripts/structure.py` | `scripts/structure.py` | unchanged - the skill had no structure module |
| `scripts/candle_builder.py` | `scripts/candle_builder.py` | unchanged; the live path uses `scripts/nse_fetch.py`'s chart aggregation + the closed-candle filter in `scripts/gex_snapshot.py` |
| `scripts/eod_fetch.py` | `scripts/eod_fetch.py` | rewritten as a THIN ADAPTER over the skill's existing `scripts/nse_fetch.py` (one NSE client, not two) |
| `scripts/daily_bias.py` | `scripts/daily_bias.py` | unchanged except the data directory default |
| `references/gex-output-schema.json` | `references/gex-output-schema.json` | unchanged |
| `config/crontab.txt` | `config/crontab.txt` | now the MAPPING to the repo's existing scheduler (not an installable crontab) |
| `tests/make_sample.py`, `tests/make_eod_fixture.py` | not vendored | the skill's own fixtures (`tests/orch_fixtures.py`) cover the same ground offline |

New modules: `scripts/orchestrator.py`, `scripts/agents/*`,
`scripts/option_math.py`, `scripts/gex_snapshot.py`,
`scripts/jsonschema_mini.py`, `scripts/contract_master.py`,
`scripts/account_equity.py`, `scripts/gex_exit_monitor.py`,
`scripts/run_gex.py`, `scripts/trading_day.py`, `scripts/cron_job.sh`,
`scripts/live_fetch.sh`, `references/orchestrator-output-schema.json`,
`references/agent-rules.md`, `references/contract-lots.json`.

**Reused, not duplicated:** `scripts/levels.py` (the OI walls / max pain),
`scripts/breakout.py` (the breakout / fakeout validator), `scripts/greeks.py`
(Black-Scholes), `scripts/structure.py` (the swings), `scripts/nse_fetch.py`
(the NSE client).

### The app-side counterparts (not merged, not duplicated)

The app has its own engines for the same concepts.  They stay where they are;
the skill does not fork them and does not re-implement them in the app:

| concept | the app (canonical for the app) | the skill (canonical for the skill) |
|---|---|---|
| option chain reading / OI walls | `src/lib/option-chain-reader.ts` (`read_option_chain`) | `scripts/levels.py` + `scripts/agents/agent_b.py` |
| market structure (HH/LL, BOS, CHoCH, sweeps, FVG) | `src/lib/tech-read.ts` | `scripts/structure.py` + `scripts/agents/agent_c.py` |
| gamma exposure | `src/lib/gex-engine.ts` (per-strike GEX for the app's screens) | `scripts/gex_engine.py` (the GEX-isolated engine: net GEX, flip, walls, regime, the GEX-1..GEX-4 strategies, its own output schema) |
| trade gates / vetoes | `src/lib/signal-veto.ts`, `src/lib/agent-brain-gate.ts` | `scripts/agents/protocol.py` + this document |

The skill's Python modules exist because the skill is a **standalone, offline,
stdlib-only** research tool: it must be runnable (and testable) without the
Next.js runtime, and it must not write into the app's production paths.  The
semantics were kept aligned with the app's engines (the same definitions of a
swing, a BOS, a CHoCH and a sweep; the same "one strike" stability rule; the
same 15-minute / 0.1% / 1.5x breakout thresholds, which live in
`references/breakout-thresholds.json`).

**The GEX engine of this skill is the only one that produces `GEX-*` records.**
The app's `src/lib/gex-engine.ts` is not used by the skill and the skill's
engine is not wired into the app: the GEX records are isolated by design
(`engine="GEX"`, the GEX channel outbox, never the main bias score).

