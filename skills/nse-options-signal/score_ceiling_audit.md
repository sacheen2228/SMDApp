# Score Ceiling Audit — nse-options-signal

**AUDIT ONLY — diagnosis of why scores ranged −28..+19 and CE signals were 0.**
No scoring rules, thresholds, gates, entry/exit logic or skill scripts were changed.
No missing value was replaced with a fabricated value; no future information was used.

- Period: 2026-03-20 → 2026-09-24 (125 sessions)
- Generated: 2026-09-25T00:59:41.724891+05:30
- Production skill scripts byte-identical before/after: **True** (mismatches: none)
- Desktop `.skill` unchanged: **True** (sha256 `34107e3f98503a93…`)
- Cross-validation vs `backtest_report.json`: ±20 exact=True (32/32), ±15 exact=True (38/38)
- Verification: every session re-asserted (mirror == production scorer for all 4 components; components sum == bias_score). per-session: oc mirror == production option_chain_score; fii mirror == production fii_score; greek sub-parts sum == production greek_score; components sum == bias_score (all 125 sessions, 0 failures)

---

## 1. Score component and its contribution — all 125 sessions

Full per-session record (score, every component, every sub-part, gates, zero causes) is in `score_ceiling_audit.json` → `sessions[]` (125 records). Format per record:

```
{"date","score","components":{option_chain,fii,breadth,greeks},
 "option_chain_detail":{pcr,pcr_tier_raw,pcr_capped,resist,support,res_dist_pct,
   sup_dist_pct,wall_adj,d_pe,d_ce,oi_adj,oi_tie,...},
 "fii_detail":{score,available,net,bucket},
 "greeks_detail":{skew,flip,skew_contrib,skew_cause,flip_contrib,flip_cause,
   iv_rows,iv_present,greek_score,hours_to_expiry,atm_iv,net_gex,vix},
 "breadth_detail":{score=0,available=false,cause}, "gates", "zero_causes"}
```

Extremes (from the same records):

| Session | Score | OC | FII | Breadth | Greeks | Note |
|---|---|---|---|---|---|---|
| 2026-07-08 | **-28** | -16 | -6 | 0 | -6 | — |
| 2026-07-15 | **-28** | -16 | -6 | 0 | -6 | — |
| 2026-07-22 | **-28** | -16 | -6 | 0 | -6 | — |
| 2026-04-21 | **19** | 16 | -3 | 0 | 6 | THETA-GATE |
| 2026-09-21 | **16** | 22 | -6 | 0 | 0 | — |
| 2026-05-25 | **14** | 17 | -6 | 0 | 3 | — |
| 2026-06-24 | **14** | 17 | -6 | 0 | 3 | — |

## 2–5. Positive / negative / zero contribution counts (500 component-cells)

| Component | Positive | Negative | Zero | Zero from UNAVAILABLE data | Zero genuine | Observed range | Mean |
|---|---|---|---|---|---|---|---|
| option_chain | 57 | 64 | 4 | 0 | 4 | [-22, 22] | -1.896 |
| fii | 0 | 125 | 0 | 0 | 0 | [-6, -3] | -5.208 |
| breadth | 0 | 0 | 125 | 125 | 0 | [0, 0] | 0.0 |
| greeks | 21 | 66 | 38 | 0 | 38 | [-6, 6] | -1.656 |
| **TOTAL (500)** | **78** | **255** | **167** | **125** | **42** | | |

Zero-cause detail (from `sessions[].zero_causes`):

- **Unavailable-data zeros = 125 — all breadth** (harness builds empty `gainers/losers` every session).
- FII zeros = 0 (component fired every session; never unavailable, never neutral).
- Greeks zeros = 38, all genuine: 28 = skew +3 (call skew) cancelled by flip −3; 9 = skew in neutral band [−1,+2] + no zero-cross; 1 = skew −3 cancelled by flip +3. **IV inversion never failed** (`iv_present` true all 125, `skew=None` count = 0).
- Option-chain zeros = 4 (genuine arithmetic cancellation; chain present all sessions).

## 6. Maximum possible contribution per component

**As coded (score_signal.py / greeks.py):**

| Component | Min | Max | Constraint from code |
|---|---|---|---|
| option_chain | -22 | **22** | pcr(-8..+8, >1.7 cap -> +4) + wall(+/-6) + OI-chg(+/-8); code clamp is +/-30 but inner math max is +/-22 |
| fii | -6 | **6** | cash-flow buckets only (fed with index-futures proxy) |
| breadth | -5 | **5** | F&O adv/dec only; heavyweights +/-10 (spec line 27) not implemented |
| greeks | -6 | **6** | skew(+/-3)+flip(+/-3); code clamp +/-10 unreachable by math |
| **TOTAL implemented (with breadth)** | **-39** | **39** | |
| **TOTAL harness actually provides** | **-34** | **34** | breadth unavailable in harness -> +/-34 hard ceiling |

**Per `references/scoring-rules.md` (8 groups, clipped ±100):**

| Group | Spec max | Implemented in score_signal.py | Data provided by harness |
|---|---|---|---|
| 1 Option chain | ±25 | partial — pcr/wall/OI-change only (22 of 25; OI-shift ±4, maxpain ±2 missing) | yes |
| 2 FII / institutional | ±15 | partial — cash bucket only, **fed index-futures proxy**; futures% ±8, options ±3, DII-halving, BSE ±3 missing | proxy |
| 3 OI spurts | ±12 | **NO** | data already in bhavcopy, not built |
| 4 Pre-open / closing auction | ±8 | **NO** | pre-open: no EOD archive found (A) |
| 5 Gainers/losers + volume | ±10 | partial — breadth ±5 only (heavyweights ±10 missing) | **NO (empty snapshot)** |
| 6 52-week highs | ±10 | **NO** | reconstructable (B) |
| 7 Greeks | ±10 | partial — skew ±3 + flip ±3 (IV-confirm ±2, GEX modifier missing) | yes (IV-inverted) |
| 8 Heatmap NSE+BSE | ±10 | **NO** | reconstructable (B) |
| **SPEC TOTAL** | **±100** | | |

**Structural consequence:** `score = oc + f + b + g` with `BUY_CE` at `>= 40` (score_signal.py:66-67). Implemented math max = **+39** (even granting breadth), harness-data max = **+34** → **BUY_CE is structurally unreachable; the ±40 threshold can only be met by the full 8-group spec (±100).**

## 7. Components responsible for the negative score bias

| Component | Mean | Negative sessions | Sum over 125 | Share of total negative mass (−1095) |
|---|---|---|---|---|
| fii | -5.208 | 125/125 | -651 | 59.5% |
| option_chain | -1.896 | 64/125 | -237 | 21.6% |
| greeks | -1.656 | 66/125 | -207 | 18.9% |
| breadth | 0.0 | 0/125 | 0 | 0.0% |

**Ranking of bias responsibility:**

1. **FII (−651, 59.5% of negative mass)** — the single largest bias driver: **negative in 125/125 sessions, positive in 0**. Mean −5.21 vs its own range [−6, −3]. Root cause: the harness feeds *index-futures net contracts/100* (`backtest_history.py participant_oi`) into a bucket function written for *cash flow in ₹ crore* (`spec: FII cash net (crore)`). FII index futures were net short every session of the sample, so the +6/+3 buckets never once fired (observed max = −3). This is real positioning data but a **spec metric mismatch** (see §14 B-conditional), and it drags even the best sessions (Sep 21: OC +22 → final +16).
2. **Option chain (−237, 21.6%)** — real OI structure: PCR tiers negative in 79/125 sessions (raw tiers: −8×39, −3×40, +3×33, +8×13), OI-change −8 in 65 sessions vs +8 in 60, wall adjustments symmetric. Component did reach both extremes (−22 and +22).
3. **Greeks (−207, 18.9%)** — driven by gamma-flip position: **spot below flip in 84 sessions (−3 each), above in only 7 (+3)**; no-flip 34. Skew actually tilts positive (+3 fires 46× vs −3 fires 38×; neutral band [−1,+2] is asymmetric toward positive).
4. **Breadth (0, 0%)** — unavailable; contributes neither direction (125 unavailable zeros).

## 8. What prevents the score from reaching +20 and +40

**+40 (BUY_CE):**

- Sessions ≥ +40: **0** (max observed **+19**).
- Structural ceiling with harness data: **+34**; with breadth provided: **+39**; spec full: **+100**.
- → **BUY_CE (>=40) is STRUCTURALLY UNREACHABLE in score_signal.py even with every implemented input present (max +39). With harness data (+/-34) the gap is 6-21 points.**
- The 4 unimplemented groups (OI spurts 12, pre-open 8, 52-week 10, heatmap 10) hold exactly **±40** of spec score — precisely the missing swing to the ±40 threshold.

**+20 (near-miss):**

- Arithmetically reachable (ceiling 34) but sessions with OC+FII+Greeks ALL positive: **0** — impossible while FII is negative every session.
- Sessions ≥ +15: **2**; ≥ +10: **5**; ≥ +20: **0**.

| Near-miss | Score | OC | FII | Greeks | What consumed the headroom |
|---|---|---|---|---|---|
| 2026-04-21 | **19** | 16 | -3 | 6 | FII -1739.5 (−3) blocked it — without FII drag score would be 22; OC had +0 wall, +8 OI-adj, pcr=1.5187; **<3 hours to expiry: extreme theta, no fresh buys** |
| 2026-09-21 | **16** | 22 | -6 | 0 | FII -2905.5 (−6) blocked it — without FII drag score would be 22; OC had +6 wall, +8 OI-adj, pcr=1.4646 |

- Headroom statistics: OC ≥ +16 in 14 sessions (max +22); OC positive 57/125; FII positive **0/125**; Greeks positive 21/125.
- Verdict: +20 is arithmetically reachable with implemented data, but requires simultaneous positive OC+FII+Greeks; joint-positive sessions in this sample: 0. OI-adj −8 fired on 65 sessions (d_pe < d_ce majority; the tie subcase never fired), wall −6 and the always-negative FII buckets consume most sessions' positive headroom.

## 9. Why CE never triggered (all thresholds)

- Score ≥ +40: **0 sessions** — impossible by construction (implemented ceiling +34/+39 < 40).
- Score ≥ +20: **0 sessions** — both near-misses kept out by the always-negative FII component (see §8).
- Score ≥ +15: **2 sessions** (Apr 21 +19, Sep 21 +16) — Apr 21 was blocked by the `<3 hours to expiry` theta gate; Sep 21 had nearest expiry next day (no post-expiry CE management window → skipped by trade model, not by score).
- Structural reason: implemented ceiling +34 (harness) / +39 (code) < threshold +40.
- Spec reachability: full 8-group spec sums to +/-100; +/-40 requires the 4 missing groups (max +/-40 combined) plus corrected FII group.

Top positive sessions with full breakdown:

| Date | Score | OC | FII | Grk | Gates | pcr (tier, capped) | wall | OI-adj | skew (contrib) | flip (contrib) |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-04-21 | **19** | 16 | -3 | 6 | ['<3 hours to expiry: extreme theta, no fresh buys'] | 1.5187 (8, n) | +0 | +8 | -4.23 (3) | 23100 (3) |
| 2026-09-21 | **16** | 22 | -6 | 0 | — | 1.4646 (8, n) | +6 | +8 | -0.5 (0) | None (0) |
| 2026-05-25 | **14** | 17 | -6 | 3 | — | 1.2995 (3, n) | +6 | +8 | -2.85 (3) | None (0) |
| 2026-06-24 | **14** | 17 | -6 | 3 | — | 1.2089 (3, n) | +6 | +8 | 0.49 (0) | 20000 (3) |
| 2026-07-02 | **10** | 16 | -6 | 0 | — | 1.335 (8, n) | +0 | +8 | 0.98 (0) | None (0) |
| 2026-05-06 | **8** | 11 | -3 | 0 | — | 1.183 (3, n) | +0 | +8 | -3.92 (3) | 26400 (-3) |
| 2026-07-01 | **8** | 17 | -6 | -3 | — | 1.1055 (3, n) | +6 | +8 | 0.52 (0) | 24950 (-3) |
| 2026-07-27 | **8** | 11 | -6 | 3 | — | 1.1196 (3, n) | +0 | +8 | -2.74 (3) | None (0) |
| 2026-08-20 | **8** | 11 | -6 | 3 | — | 1.0969 (3, n) | +0 | +8 | -1.89 (3) | None (0) |
| 2026-09-11 | **8** | 11 | -6 | 3 | — | 1.0567 (3, n) | +0 | +8 | -1.07 (3) | None (0) |
| 2026-09-18 | **8** | 17 | -6 | -3 | — | 1.1213 (3, n) | +6 | +8 | 1.42 (0) | 24000 (-3) |
| 2026-04-06 | **7** | 16 | -6 | -3 | — | 1.428 (8, n) | +0 | +8 | 1.29 (0) | 24550 (-3) |

## 10. Are PE signals genuine bearish evidence or missing-data asymmetry?

**Verdict: genuine bearish evidence within the implemented scope — missing-data asymmetry did NOT cause the PE signals.**

- Fired PE sessions (±20, ungated): 32. Negative score mass over all score ≤ −20 sessions: OC **-570**, FII **-213**, Greeks **-120**, breadth **0**.
- Sessions with OC < 0: **100.0%**; FII < 0: **100.0%**; Greeks < 0: 71.8% — all from real session-D data (FO bhavcopy OI, participant OI, IV-inverted greeks).
- Breadth contributed exactly 0 everywhere: unavailable zeros cannot push scores negative.
- Rule-asymmetry deepening on PE sessions: OI-tie → −8 fired **0 times** in score ≤ −20 sessions (tie rule never triggered in the sample at all). PCR positive-cap fired once (June 12, positive side).
- Fabricated inputs: none.
- Honest caveat: the 4 unimplemented spec groups (±40 combined) were not consulted — their data does not exist in this run, so they can neither confirm nor cancel the bearish picture. That uncertainty is exactly what the final requirements section removes.

Component means by score band (also item 13):

| Score group | n | Mean score | OC | FII | Breadth | Greeks |
|---|---|---|---|---|---|---|
| ≥ +15 (CE side) | 2 | 17.5 | 19.0 | -4.5 | 0.0 | 3.0 |
| +5..+14 | 20 | 7.7 | 13.4 | -5.25 | 0.0 | -0.45 |
| −5..0 | 16 | -2.12 | 6.12 | -5.44 | 0.0 | -2.81 |
| −15..−5 | 18 | -11.67 | -7.33 | -4.67 | 0.0 | 0.33 |
| ≤ −15 (PE side) | 49 | -22.04 | -14.27 | -5.39 | 0.0 | -2.39 |
| ≤ −20 | 39 | -23.15 | -14.62 | -5.46 | 0.0 | -3.08 |
| fired PE ±20 | 32 | -23.41 | -14.78 | -5.44 | 0.0 | -3.19 |

## 11. Score distribution (n = 125)

min **-28** · p05 -25.0 · median **-9** · mean **-8.76** · p95 8.0 · max **19** · stdev 12.461

| Bin | n | bar |
|---|---|---|
| [-30,-25) | 5 | █████ |
| [-25,-20) | 24 | ████████████████████████ |
| [-20,-15) | 20 | ████████████████████ |
| [-15,-10) | 13 | █████████████ |
| [-10,-5) | 5 | █████ |
| [-5,0) | 16 | ████████████████ |
| [0,5) | 20 | ████████████████████ |
| [5,10) | 17 | █████████████████ |
| [10,15) | 3 | ███ |
| [15,20) | 2 | ██ |
| [20,25) | 0 |  |
| [25,+inf) | 0 |  |

Positive scores: 41 · negative: 83 · zero: 1. Ceiling explanation: upper bound = OC +22 + Greeks +6 + breadth 0 + FII ≥ −6 observed best → observed +19; lower bound ≈ OC −22 + FII −6 + Greeks −6 = −34 theoretical → observed −28.

## 12. Component correlation with final score

| Component | r vs score | r vs next-session return |
|---|---|---|
| option_chain | 0.9634 | 0.0776 |
| greeks | 0.194 | -0.0865 |
| fii | 0.038 | -0.069 |
| breadth | undefined (zero variance) | undefined |
| score (vs next-session return) | — | 0.047 |

- Option chain dominates the score (r = 0.9634). FII's r is small (0.038) because it has near-zero variance (always −3/−6) — yet it owns 59.5% of the negative *mass* and blocks every near-miss.
- Component inter-correlations ≈ 0 ({'option_chain~fii': -0.0525, 'option_chain~greeks': -0.0538, 'fii~greeks': -0.0651}): the four implemented components are effectively independent signals — no redundancy, no hidden grouping.
- All correlations with next-session return ≈ 0 (score 0.047): consistent with the earlier 48.4% sign-accuracy finding.

## 13. CE-side vs PE-side component analysis

CE side (score ≥ +15, n=2): mean OC **+19.0**, mean Greeks **+3.0**, but mean FII **−4.5** — even the best sessions carry negative FII; breadth always 0 (would need to supply the missing +5..+10 spec weight).
PE side (score ≤ −15, n=49): mean OC **−14.3**, FII **−5.4**, Greeks **−2.4** — three independent real-data components agree negative.
Asymmetry between sides: the CE side is structurally handicapped — FII can never add (0/125 positive), breadth can never add (unavailable), Greek flip sits below spot in 84/125 sessions, while OC alone (max +22) must carry the score past thresholds set for a ±100 scale.

## 14. Unavailable / unimplemented inputs — A/B/C classification

A = truly impossible to reconstruct historically · B = historically reconstructable without look-ahead · C = currently missing only because the harness does not provide it

### breadth (gainers/losers, spec group 5)
- Spec max: +/-10 (F&O breadth +/-5 + heavyweights +/-10) · Implemented: partial (breadth +/-5 only) · Current state: always 0 — harness builds empty gainers/losers
- **Classification: C — currently missing only because the harness does not provide it**
- Feasibility/evidence: underlying adv/dec + volume reconstructable without look-ahead from daily CM equity bhavcopy (probe-verified: content/cm/BhavCopy_NSE_CM_... 200, 2668 EQ rows, OHLC+volume)

### heatmap (NSE+BSE, spec group 8)
- Spec max: +/-10 · Implemented: NO · Current state: absent from scorer AND harness
- **Classification: B — historically reconstructable without look-ahead (constituent daily returns from CM bhavcopy/Yahoo; weights from pre-D data)**
- Feasibility/evidence: probe-verified data availability

### OI spurts (spec group 3)
- Spec max: +/-12 · Implemented: NO · Current state: absent from scorer AND snapshot builder
- **Classification: C — data ALREADY in downloaded FO bhavcopy (ChngInOpnIntrst + prev/close prices, both days cached); only the snapshot group is not built**
- Feasibility/evidence: no new download needed

### pre-open / closing auction (spec group 4)
- Spec max: +/-8 · Implemented: NO · Current state: absent
- **Classification: A for the pre-open indicative half — no EOD archive found (CM bhavcopy contains only regular session SsnId=F1, no pre-open rows; old-format probes 404). B for the 'close near day high' half — derivable from CM bhavcopy OHLC; true closing-auction imbalance volumes not archived (A).**
- Feasibility/evidence: partial only

### 52-week highs (spec group 6)
- Spec max: +/-10 · Implemented: NO · Current state: absent
- **Classification: B — reconstructable without look-ahead from >=52 weeks of per-stock daily closes (Yahoo 2y / CM bhavcopy history), evaluated at D only**
- Feasibility/evidence: data exists; scorer group also missing (architecture)

### BSE FII summary (spec line 63-66)
- Spec max: +/-3 (inside group 2) · Implemented: NO · Current state: absent
- **Classification: C (not fetched) with availability unverified — spec itself sanctions 0 with note 'BSE unavailable' (line 66)**
- Feasibility/evidence: requires BSE archive verification (not done)

### FII cash flow (spec group 2 core, +/-6 bucket)
- Spec max: inside +/-15 · Implemented: partial (bucket code exists) · Current state: fed with PROXY metric: index-futures net contracts/100 (backtest_history.py participant_oi), not spec's 'FII cash net (crore)'; 3 NSE archive paths probed 404
- **Classification: B-conditional — daily FII cash flows are published EOD and mirrored by third parties (app has 60-day MrChartist history), but no NSE archive path verified; futures-long% (+8), options (+3), DII-halving, BSE (+3) sub-rules unimplemented**
- Feasibility/evidence: needs verified daily EOD source; metric mismatch must be resolved

### India VIX
- Spec max: notes/size modifiers (not scored) · Implemented: notes only · Current state: provided (Yahoo ^INDIAVIX)
- **Classification: available**
- Feasibility/evidence: n/a

### IV for greeks/skew/flip
- Spec max: inside +/-10 · Implemented: partial (skew+flip) · Current state: provided — back-derived from real option closes (BS inversion)
- **Classification: available (harness-derived, real inputs, no fabrication)**
- Feasibility/evidence: n/a

### OC sub-rules: OI-shift lower strikes +/-4, maxpain +/-2
- Spec max: +/-6 inside group 1 · Implemented: NO · Current state: data present in built chain (OI per strike; maxpain computable)
- **Classification: C — computable from data the harness already provides; scorer does not implement these lines**
- Feasibility/evidence: architecture gap

### Greeks sub-rules: IV-confirm +/-2, GEX 0.8 modifier, 4-of-8 agreement gate
- Spec max: modifiers/gates · Implemented: NO · Current state: absent
- **Classification: C (computable from gk outputs already produced)**
- Feasibility/evidence: architecture gap

Probe evidence collected this run (read-only):

- CM equity bhavcopy `content/cm/BhavCopy_NSE_CM_0_0_0_20260923_F_0000.csv.zip` → **200**, 3,696 rows, 2,668 EQ, columns include OpnPric/HghPric/LwPric/ClsPric/PrvsClsgPric/TtlTradgVol — session `SsnId=F1` only (**no pre-open rows**).
- Old-format equity bhavcopy probe → 404. FII/cash archive probes (3 candidate NSE paths) → 404.
- No archive was reconstructed; nothing was substituted.

## Asymmetric-scoring audit (could rules structurally favor negative scores?)

1. **PCR positive-cap (score_signal.py:21)** — `min(s,4)` applies ONLY when pcr > 1.7; the negative −8 has no cap. Fired **1 session** (['2026-06-12']), positive side only.
2. **OI-change tie rule (line 27)** — `+8 if d_pe > d_ce else -8`: a tie (or both-zero) would get −8 instead of 0. **Exact ties observed: 0**; both-zero: 0 — asymmetry exists in code but **never fired in this sample** (distribution: {'-8': 65, '8': 60}).
3. **PCR bucket boundary** — pcr ∈ (0.8, 1.0] and pcr exactly 1.0 land on −3 (raw tier counts: {'-8': 39, '-3': 40, '3': 33, '8': 13}); negative tiers fired 79/125 vs positive 46/125 — reflects genuinely bearish PCR, not just boundary placement.
4. **Greeks skew band** — neutral band [−1,+2]: +3 needs only skew < −1, −3 needs skew > 2 → asymmetric toward **POSITIVE** (observed: {'neutral': 41, '>2(-3)': 38, '<-1(+3)': 46}).
5. **Gamma flip** — spot below flip 84 sessions vs above 7: driven by real GEX/OI data, not by a rule asymmetry.
6. **Breadth unavailable** — symmetric removal of ±5 (and ±10 spec): cannot bias direction; it shrinks the achievable range toward zero from both sides.
7. **FII thresholds** — symmetric (±500/±2000); bias comes from the *proxy metric* being one-sided in this sample, not from the bucket rules.

Net: code-level asymmetries (1) and (2) favor negatives but fired **once** and **zero** times respectively; the sample's negative bias is driven by real inputs (FII proxy, PCR, flip position), not by rule asymmetry.

---

## WHAT MUST CHANGE BEFORE A FAIR CE/PE BACKTEST

Concrete data/architecture requirements only (no rule tuning, no threshold changes):

1. **Full 8-group scorer architecture** — `score_signal.py` implements 4 of 8 spec groups (hard ceiling +34/+39 < 40): implement OI-spurts, pre-open/auction, 52-week, heatmap groups and the missing sub-rules (OI-shift ±4, maxpain ±2, FII futures%/options/DII-halving, IV-confirm, GEX modifier, 4-of-8 agreement gate) per `scoring-rules.md`. Until then ±40 thresholds cannot fire BY CONSTRUCTION and no CE backtest is meaningful.
2. **Breadth feed (C)** — harness must build real `gainers`/`losers` from the daily CM equity bhavcopy (probe-verified available) instead of empty dicts; include the heavyweights ±10 sub-rule data (top-gainer/loser + volume flags, also in CM bhavcopy).
3. **OI-spurt snapshot builder (C)** — construct group-3 snapshot from `ChngInOpnIntrst` + price change already present in the downloaded FO bhavcopy (both days cached); no new data source required.
4. **52-week feed (B)** — ≥52 weeks of per-stock daily closes (Yahoo 2y / CM bhavcopy history), evaluated strictly at date D.
5. **Heatmap feed (B)** — NIFTY50/BANKNIFTY constituent day-D returns (CM bhavcopy) with index weights fixed from pre-D data; Sensex cross-check from BSE equivalents.
6. **Pre-open/closing-auction source decision (A for pre-open, B for 'close near high')** — no EOD pre-open archive found in probes; strategy owner must either supply a verified historical source or formally waive group 4 with a documented note (no silent fabrication).
7. **FII metric alignment (B-conditional + proxy fix)** — replace the index-futures contracts/100 proxy with spec's daily FII cash net (₹ crore) from a verified EOD source (NSE archive path unresolved: 3 probes 404; third-party mirrors unverified), plus the unimplemented futures-long% (+8), options (+3), DII-halving and BSE cross-check (±3). The current proxy is negative 125/125 and alone supplies 59.5% of negative score mass.
8. **BSE FII archive verification** — confirm BSE fiisummary historical availability; if unavailable, record the spec-sanctioned 0 with note 'BSE unavailable' (scoring-rules line 66).
9. **Per-session snapshot persistence** — store the complete 8-group snapshot JSON per session (auditable inputs, replayable scoring) instead of recomputing chains at audit time.
10. **NSE trading-calendar source of truth** — replace Yahoo date extraction (Sep 22 gap: traded but untested) so session sets are exact before any CE/PE statistics are compared.

## Files modified (this audit)

- `skills/nse-options-signal/score_ceiling_audit.md` (created)
- `skills/nse-options-signal/score_ceiling_audit.json` (created)

Read-only: all skill scripts, references, `backtest_report.*`, production strategy files, and `/home/sachin/Desktop/nse-options-signal.skill` (sha256 unchanged: `34107e3f98503a93…`).

Cross-validation: recomputed ±20/±15 fired sets are **exact matches** to `backtest_report.json` trade lists (32/32, 38/38) — audit reproduces the original run bit-for-bit on decisions.
