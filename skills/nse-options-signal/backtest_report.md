# nse-options-signal — 6-month backtest report

Generated: 2026-09-24 23:40:57.408734  
Period: **2026-03-20 → 2026-09-24** · **125 sessions** (6.0 months) · modes: ±40 (spec), ±20, ±15

## Executive Summary

- **SPEC ±40**: 0 signals over 125 sessions (100.0% NO_TRADE).
- **RELAXED ±20**: 32 signals · 34.4% WR · avg 6.15%/trade · total 196.9% · maxDD 99.13% · PF 1.32.
- **RELAXED ±15**: 38 signals · 28.9% WR · avg 0.45%/trade · total 16.9% · maxDD 99.7% · PF 1.02.
- Score sign direction accuracy: **48.4%** (60/124) — *score sign = regime/bias indicator, not necessarily a next-session predictor*.
- Buy-and-hold NIFTY over period: **-0.22%** (context only).
- ⚠ Sample-size warnings: ±40 — see Statistical Summary.

## Comparison

| Mode | Signals | CE | PE | Win% | Avg/Trade | Total | Max DD | PF |
|---|---|---|---|---|---|---|---|---|
| ±40 | 0 | 0 | 0 | — | —% | 0% | 0.0% | — |
| ±20 | 32 | 0 | 32 | 34.4 | 6.15% | 196.9% | 99.13% | 1.32 |
| ±15 | 38 | 0 | 38 | 28.9 | 0.45% | 16.9% | 99.7% | 1.02 |

## Trade List — mode ±40

_No trades._

## Trade List — mode ±20

| date | signal | score | option | strike | entry | SL | TP1 | exit | return | result | next NIFTY |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-03-23 | BUY_PE | -25 | NIFTY 22500PE | 22500 | 195.0 | 136.5 | 273.0 | SL 136.5 | -30.0% | LOSS | +1.78% |
| 2026-03-27 | BUY_PE | -20 | NIFTY 22800PE | 22800 | 203.05 | 142.13 | 284.27 | TP1+CLOSE 380.88 | +87.6% | WIN | -2.14% |
| 2026-04-09 | BUY_PE | -20 | NIFTY 23800PE | 23800 | 192.05 | 134.44 | 268.87 | SL 134.44 | -30.0% | LOSS | +1.16% |
| 2026-04-16 | BUY_PE | -20 | NIFTY 24200PE | 24200 | 193.2 | 135.24 | 270.48 | SL 135.24 | -30.0% | LOSS | +0.65% |
| 2026-04-22 | BUY_PE | -20 | NIFTY 24400PE | 24400 | 231.5 | 162.05 | 324.1 | TP1+CLOSE 324.7 | +40.3% | WIN | -0.84% |
| 2026-04-23 | BUY_PE | -20 | NIFTY 24150PE | 24150 | 181.0 | 126.7 | 253.4 | TP1+CLOSE 283.32 | +56.5% | WIN | -1.14% |
| 2026-04-24 | BUY_PE | -25 | NIFTY 23900PE | 23900 | 165.2 | 115.64 | 231.28 | SL 115.64 | -30.0% | LOSS | +0.81% |
| 2026-05-08 | BUY_PE | -22 | NIFTY 24200PE | 24200 | 135.8 | 95.06 | 190.12 | TP1+CLOSE 271.61 | +100.0% | WIN | -1.49% |
| 2026-05-11 | BUY_PE | -22 | NIFTY 23800PE | 23800 | 73.7 | 51.59 | 103.18 | TP1+CLOSE 261.04 | +254.2% | WIN | -1.83% |
| 2026-05-15 | BUY_PE | -23 | NIFTY 23650PE | 23650 | 166.7 | 116.69 | 233.38 | SL 116.69 | -30.0% | LOSS | +0.03% |
| 2026-05-21 | BUY_PE | -23 | NIFTY 23650PE | 23650 | 178.4 | 124.88 | 249.76 | SL 124.88 | -30.0% | LOSS | +0.27% |
| 2026-05-29 | BUY_PE | -22 | NIFTY 23550PE | 23550 | 76.2 | 53.34 | 106.68 | SL 53.34 | -30.0% | LOSS | -0.70% |
| 2026-06-05 | BUY_PE | -22 | NIFTY 23350PE | 23350 | 107.0 | 74.9 | 149.8 | TP1+CLOSE 195.8 | +83.0% | WIN | -1.04% |
| 2026-06-08 | BUY_PE | -25 | NIFTY 23100PE | 23100 | 83.15 | 58.2 | 116.41 | SL 58.2 | -30.0% | LOSS | +0.52% |
| 2026-06-10 | BUY_PE | -20 | NIFTY 23200PE | 23200 | 158.8 | 111.16 | 222.32 | SL 111.16 | -30.0% | LOSS | -0.23% |
| 2026-06-19 | BUY_PE | -25 | NIFTY 24000PE | 24000 | 85.95 | 60.16 | 120.33 | SL 60.16 | -30.0% | LOSS | +0.37% |
| 2026-06-29 | BUY_PE | -22 | NIFTY 23950PE | 23950 | 71.15 | 49.8 | 99.61 | SL 49.8 | -30.0% | LOSS | -0.34% |
| 2026-07-03 | BUY_PE | -20 | NIFTY 24250PE | 24250 | 75.6 | 52.92 | 105.84 | SL 52.92 | -30.0% | LOSS | +0.66% |
| 2026-07-08 | BUY_PE | -28 | NIFTY 23900PE | 23900 | 198.0 | 138.6 | 277.2 | SL 138.6 | -30.0% | LOSS | +0.34% |
| 2026-07-15 | BUY_PE | -28 | NIFTY 24100PE | 24100 | 178.9 | 125.23 | 250.46 | SL 125.23 | -30.0% | LOSS | -0.02% |
| 2026-07-22 | BUY_PE | -28 | NIFTY 24000PE | 24000 | 161.8 | 113.26 | 226.52 | TP1+CLOSE 213.79 | +32.1% | WIN | -0.53% |
| 2026-07-23 | BUY_PE | -25 | NIFTY 23850PE | 23850 | 115.95 | 81.16 | 162.33 | TP1+CLOSE 150.69 | +30.0% | WIN | -0.43% |
| 2026-08-05 | BUY_PE | -25 | NIFTY 24600PE | 24600 | 136.35 | 95.44 | 190.89 | SL 95.44 | -30.0% | LOSS | +0.05% |
| 2026-08-07 | BUY_PE | -25 | NIFTY 24550PE | 24550 | 83.0 | 58.1 | 116.2 | SL 58.1 | -30.0% | LOSS | +0.05% |
| 2026-08-12 | BUY_PE | -22 | NIFTY 24450PE | 24450 | 126.3 | 88.41 | 176.82 | TIME_CLOSE 105.25 | -16.7% | LOSS | -0.16% |
| 2026-08-19 | BUY_PE | -25 | NIFTY 24100PE | 24100 | 109.1 | 76.37 | 152.74 | SL 76.37 | -30.0% | LOSS | +0.64% |
| 2026-08-24 | BUY_PE | -28 | NIFTY 24200PE | 24200 | 58.25 | 40.77 | 81.55 | SL 40.77 | -30.0% | LOSS | +0.48% |
| 2026-09-02 | BUY_PE | -25 | NIFTY 23900PE | 23900 | 116.2 | 81.34 | 162.68 | SL 81.34 | -30.0% | LOSS | -0.17% |
| 2026-09-03 | BUY_PE | -22 | NIFTY 23850PE | 23850 | 74.7 | 52.29 | 104.58 | SL 52.29 | -30.0% | LOSS | +0.10% |
| 2026-09-07 | BUY_PE | -22 | NIFTY 23800PE | 23800 | 63.95 | 44.77 | 89.53 | TP1+CLOSE 128.62 | +101.1% | WIN | -0.61% |
| 2026-09-09 | BUY_PE | -22 | NIFTY 23450PE | 23450 | 95.7 | 66.99 | 133.98 | TIME_CLOSE 106.65 | +11.4% | WIN | +0.20% |
| 2026-09-10 | BUY_PE | -28 | NIFTY 23500PE | 23500 | 132.8 | 92.96 | 185.92 | TP1+CLOSE 155.91 | +17.4% | WIN | -0.34% |

## Trade List — mode ±15

| date | signal | score | option | strike | entry | SL | TP1 | exit | return | result | next NIFTY |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-03-23 | BUY_PE | -25 | NIFTY 22500PE | 22500 | 195.0 | 136.5 | 273.0 | SL 136.5 | -30.0% | LOSS | +1.78% |
| 2026-03-27 | BUY_PE | -20 | NIFTY 22800PE | 22800 | 203.05 | 142.13 | 284.27 | TP1+CLOSE 380.88 | +87.6% | WIN | -2.14% |
| 2026-04-02 | BUY_PE | -17 | NIFTY 22700PE | 22700 | 280.3 | 196.21 | 392.42 | SL 196.21 | -30.0% | LOSS | +1.12% |
| 2026-04-09 | BUY_PE | -20 | NIFTY 23800PE | 23800 | 192.05 | 134.44 | 268.87 | SL 134.44 | -30.0% | LOSS | +1.16% |
| 2026-04-16 | BUY_PE | -20 | NIFTY 24200PE | 24200 | 193.2 | 135.24 | 270.48 | SL 135.24 | -30.0% | LOSS | +0.65% |
| 2026-04-22 | BUY_PE | -20 | NIFTY 24400PE | 24400 | 231.5 | 162.05 | 324.1 | TP1+CLOSE 324.7 | +40.3% | WIN | -0.84% |
| 2026-04-23 | BUY_PE | -20 | NIFTY 24150PE | 24150 | 181.0 | 126.7 | 253.4 | TP1+CLOSE 283.32 | +56.5% | WIN | -1.14% |
| 2026-04-24 | BUY_PE | -25 | NIFTY 23900PE | 23900 | 165.2 | 115.64 | 231.28 | SL 115.64 | -30.0% | LOSS | +0.81% |
| 2026-05-04 | BUY_PE | -19 | NIFTY 24100PE | 24100 | 83.1 | 58.17 | 116.34 | SL 58.17 | -30.0% | LOSS | -0.36% |
| 2026-05-08 | BUY_PE | -22 | NIFTY 24200PE | 24200 | 135.8 | 95.06 | 190.12 | TP1+CLOSE 271.61 | +100.0% | WIN | -1.49% |
| 2026-05-11 | BUY_PE | -22 | NIFTY 23800PE | 23800 | 73.7 | 51.59 | 103.18 | TP1+CLOSE 261.04 | +254.2% | WIN | -1.83% |
| 2026-05-15 | BUY_PE | -23 | NIFTY 23650PE | 23650 | 166.7 | 116.69 | 233.38 | SL 116.69 | -30.0% | LOSS | +0.03% |
| 2026-05-21 | BUY_PE | -23 | NIFTY 23650PE | 23650 | 178.4 | 124.88 | 249.76 | SL 124.88 | -30.0% | LOSS | +0.27% |
| 2026-05-29 | BUY_PE | -22 | NIFTY 23550PE | 23550 | 76.2 | 53.34 | 106.68 | SL 53.34 | -30.0% | LOSS | -0.70% |
| 2026-06-01 | BUY_PE | -19 | NIFTY 23400PE | 23400 | 76.2 | 53.34 | 106.68 | SL 53.34 | -30.0% | LOSS | +0.43% |
| 2026-06-05 | BUY_PE | -22 | NIFTY 23350PE | 23350 | 107.0 | 74.9 | 149.8 | TP1+CLOSE 195.8 | +83.0% | WIN | -1.04% |
| 2026-06-08 | BUY_PE | -25 | NIFTY 23100PE | 23100 | 83.15 | 58.2 | 116.41 | SL 58.2 | -30.0% | LOSS | +0.52% |
| 2026-06-10 | BUY_PE | -20 | NIFTY 23200PE | 23200 | 158.8 | 111.16 | 222.32 | SL 111.16 | -30.0% | LOSS | -0.23% |
| 2026-06-19 | BUY_PE | -25 | NIFTY 24000PE | 24000 | 85.95 | 60.16 | 120.33 | SL 60.16 | -30.0% | LOSS | +0.37% |
| 2026-06-29 | BUY_PE | -22 | NIFTY 23950PE | 23950 | 71.15 | 49.8 | 99.61 | SL 49.8 | -30.0% | LOSS | -0.34% |
| 2026-07-03 | BUY_PE | -20 | NIFTY 24250PE | 24250 | 75.6 | 52.92 | 105.84 | SL 52.92 | -30.0% | LOSS | +0.66% |
| 2026-07-08 | BUY_PE | -28 | NIFTY 23900PE | 23900 | 198.0 | 138.6 | 277.2 | SL 138.6 | -30.0% | LOSS | +0.34% |
| 2026-07-15 | BUY_PE | -28 | NIFTY 24100PE | 24100 | 178.9 | 125.23 | 250.46 | SL 125.23 | -30.0% | LOSS | -0.02% |
| 2026-07-22 | BUY_PE | -28 | NIFTY 24000PE | 24000 | 161.8 | 113.26 | 226.52 | TP1+CLOSE 213.79 | +32.1% | WIN | -0.53% |
| 2026-07-23 | BUY_PE | -25 | NIFTY 23850PE | 23850 | 115.95 | 81.16 | 162.33 | TP1+CLOSE 150.69 | +30.0% | WIN | -0.43% |
| 2026-08-05 | BUY_PE | -25 | NIFTY 24600PE | 24600 | 136.35 | 95.44 | 190.89 | SL 95.44 | -30.0% | LOSS | +0.05% |
| 2026-08-07 | BUY_PE | -25 | NIFTY 24550PE | 24550 | 83.0 | 58.1 | 116.2 | SL 58.1 | -30.0% | LOSS | +0.05% |
| 2026-08-12 | BUY_PE | -22 | NIFTY 24450PE | 24450 | 126.3 | 88.41 | 176.82 | TIME_CLOSE 105.25 | -16.7% | LOSS | -0.16% |
| 2026-08-19 | BUY_PE | -25 | NIFTY 24100PE | 24100 | 109.1 | 76.37 | 152.74 | SL 76.37 | -30.0% | LOSS | +0.64% |
| 2026-08-21 | BUY_PE | -17 | NIFTY 24250PE | 24250 | 62.9 | 44.03 | 88.06 | SL 44.03 | -30.0% | LOSS | -0.14% |
| 2026-08-24 | BUY_PE | -28 | NIFTY 24200PE | 24200 | 58.25 | 40.77 | 81.55 | SL 40.77 | -30.0% | LOSS | +0.48% |
| 2026-08-27 | BUY_PE | -19 | NIFTY 24100PE | 24100 | 62.15 | 43.5 | 87.01 | SL 43.5 | -30.0% | LOSS | +0.35% |
| 2026-09-02 | BUY_PE | -25 | NIFTY 23900PE | 23900 | 116.2 | 81.34 | 162.68 | SL 81.34 | -30.0% | LOSS | -0.17% |
| 2026-09-03 | BUY_PE | -22 | NIFTY 23850PE | 23850 | 74.7 | 52.29 | 104.58 | SL 52.29 | -30.0% | LOSS | +0.10% |
| 2026-09-07 | BUY_PE | -22 | NIFTY 23800PE | 23800 | 63.95 | 44.77 | 89.53 | TP1+CLOSE 128.62 | +101.1% | WIN | -0.61% |
| 2026-09-09 | BUY_PE | -22 | NIFTY 23450PE | 23450 | 95.7 | 66.99 | 133.98 | TIME_CLOSE 106.65 | +11.4% | WIN | +0.20% |
| 2026-09-10 | BUY_PE | -28 | NIFTY 23500PE | 23500 | 132.8 | 92.96 | 185.92 | TP1+CLOSE 155.91 | +17.4% | WIN | -0.34% |
| 2026-09-17 | BUY_PE | -17 | NIFTY 23250PE | 23250 | 89.8 | 62.86 | 125.72 | SL 62.86 | -30.0% | LOSS | +0.33% |

## Gate Summary

| Gate | Sessions | % of sessions |
|---|---|---|
| <3 hours to expiry: extreme theta, no fresh buys | 26 | 20.8% |

Score-band (|score| below ±40) NO_TRADE sessions: 99 (79.2%).

Missing-data groups (score 0, not explicit gates):

| Group | In score_signal.py? | EOD available? | Sessions scored 0 |
|---|---|---|---|
| breadth (gainers/losers) | yes | no | 125 |
| heatmap (NSE+BSE) | no | no | 125 |
| OI spurts | no | no | 125 |
| pre-open | no | no | 125 |
| 52-week | no | no | 125 |
| BSE FII | no | no | 125 |
| participant-OI FII | yes | yes | 0 |

## CE vs PE

| Mode | Side | Count | Win% | Avg | Total | PF |
|---|---|---|---|---|---|---|
| ±40 | CE | 0 | — | —% | 0% | — |
| ±40 | PE | 0 | — | —% | 0% | — |
| ±20 | CE | 0 | — | —% | 0% | — |
| ±20 | PE | 32 | 34.4 | 6.15% | 196.9% | 1.32 |
| ±15 | CE | 0 | — | —% | 0% | — |
| ±15 | PE | 38 | 28.9 | 0.45% | 16.9% | 1.02 |

Regime caveat: do not read PE superiority from a sample drawn inside one market regime.

## Direction Analysis

- Score-sign vs next-session NIFTY direction: **48.4%** (60/124)
  - *score sign = regime/bias indicator, not necessarily a next-session predictor*
- ±40 CE signal → next session up: —% | PE signal → next session down: —%
- ±20 CE signal → next session up: —% | PE signal → next session down: 50.0%
- ±15 CE signal → next session up: —% | PE signal → next session down: 47.4%

## Regime Analysis (analysis-only buckets; not strategy inputs)

Definitions: bullish/bearish/sideways = session-D move vs D-1 close (> +0.25% / < -0.25% / ±0.25%); VIX buckets use greeks.py thresholds (>20 high, <12 low); expiry = NIFTY weekly expiry session.

### Mode ±40

**by_session_direction**

| bucket | n | WR% | avg% | total% | PF |
|---|---|---|---|---|---|
| bullish_day(> +0.25%) | 0 | — | — | 0 | — |
| bearish_day(< -0.25%) | 0 | — | — | 0 | — |
| sideways(±0.25%) | 0 | — | — | 0 | — |

**by_vix_skill_thresholds**

| bucket | n | WR% | avg% | total% | PF |
|---|---|---|---|---|---|
| higher_vix(>20, greeks.py) | 0 | — | — | 0 | — |
| mid_vix(12-20) | 0 | — | — | 0 | — |
| lower_vix(<12, greeks.py) | 0 | — | — | 0 | — |
| vix_unknown | 0 | — | — | 0 | — |

**by_expiry**

| bucket | n | WR% | avg% | total% | PF |
|---|---|---|---|---|---|
| expiry_day_session | 0 | — | — | 0 | — |
| non_expiry_session | 0 | — | — | 0 | — |

**by_weekday**

| bucket | n | WR% | avg% | total% | PF |
|---|---|---|---|---|---|
| Mon | 0 | — | — | 0 | — |
| Tue | 0 | — | — | 0 | — |
| Wed | 0 | — | — | 0 | — |
| Thu | 0 | — | — | 0 | — |
| Fri | 0 | — | — | 0 | — |

### Mode ±20

**by_session_direction**

| bucket | n | WR% | avg% | total% | PF |
|---|---|---|---|---|---|
| bullish_day(> +0.25%) | 1 | 0.0 | -30.0 | -30.0 | 0.0 |
| bearish_day(< -0.25%) | 20 | 45.0 | 19.16 | 383.2 | 2.16 |
| sideways(±0.25%) | 11 | 18.2 | -14.21 | -156.3 | 0.39 |

**by_vix_skill_thresholds**

| bucket | n | WR% | avg% | total% | PF |
|---|---|---|---|---|---|
| higher_vix(>20, greeks.py) | 3 | 33.3 | 9.19 | 27.6 | 1.46 |
| mid_vix(12-20) | 20 | 35.0 | 10.3 | 206.1 | 1.53 |
| lower_vix(<12, greeks.py) | 9 | 33.3 | -4.08 | -36.7 | 0.78 |
| vix_unknown | 0 | — | — | 0 | — |

**by_expiry**

| bucket | n | WR% | avg% | total% | PF |
|---|---|---|---|---|---|
| expiry_day_session | 0 | — | — | 0 | — |
| non_expiry_session | 32 | 34.4 | 6.15 | 196.9 | 1.32 |

**by_weekday**

| bucket | n | WR% | avg% | total% | PF |
|---|---|---|---|---|---|
| Mon | 6 | 33.3 | 39.22 | 235.3 | 2.96 |
| Tue | 0 | — | — | 0 | — |
| Wed | 10 | 30.0 | -11.28 | -112.8 | 0.43 |
| Thu | 7 | 42.9 | -2.3 | -16.1 | 0.87 |
| Fri | 9 | 33.3 | 10.06 | 90.6 | 1.5 |

### Mode ±15

**by_session_direction**

| bucket | n | WR% | avg% | total% | PF |
|---|---|---|---|---|---|
| bullish_day(> +0.25%) | 2 | 0.0 | -30.0 | -60.0 | 0.0 |
| bearish_day(< -0.25%) | 22 | 40.9 | 14.69 | 323.2 | 1.83 |
| sideways(±0.25%) | 14 | 14.3 | -17.59 | -246.3 | 0.29 |

**by_vix_skill_thresholds**

| bucket | n | WR% | avg% | total% | PF |
|---|---|---|---|---|---|
| higher_vix(>20, greeks.py) | 4 | 25.0 | -0.61 | -2.4 | 0.97 |
| mid_vix(12-20) | 23 | 30.4 | 5.05 | 116.1 | 1.24 |
| lower_vix(<12, greeks.py) | 11 | 27.3 | -8.79 | -96.7 | 0.57 |
| vix_unknown | 0 | — | — | 0 | — |

**by_expiry**

| bucket | n | WR% | avg% | total% | PF |
|---|---|---|---|---|---|
| expiry_day_session | 0 | — | — | 0 | — |
| non_expiry_session | 38 | 28.9 | 0.45 | 16.9 | 1.02 |

**by_weekday**

| bucket | n | WR% | avg% | total% | PF |
|---|---|---|---|---|---|
| Mon | 8 | 25.0 | 21.91 | 175.3 | 1.97 |
| Tue | 0 | — | — | 0 | — |
| Wed | 10 | 30.0 | -11.28 | -112.8 | 0.43 |
| Thu | 10 | 30.0 | -10.61 | -106.1 | 0.49 |
| Fri | 10 | 30.0 | 6.06 | 60.6 | 1.29 |

## Statistical Summary

| Metric | ±40 | ±20 | ±15 |
|---|---|---|---|
| signals | 0 | 32 | 38 |
| win_rate_pct | — | 34.4 | 28.9 |
| avg_return_pct | — | 6.15 | 0.45 |
| median_return_pct | — | -30.0 | -30.0 |
| p25_pct | — | -30.0 | -30.0 |
| p75_pct | — | 30.5 | 15.91 |
| avg_win | — | 73.96 | 73.96 |
| avg_loss | — | -29.37 | -29.51 |
| largest_win | — | 254.19 | 254.19 |
| largest_loss | — | -30.0 | -30.0 |
| win_loss_ratio | — | 0.52 | 0.41 |
| expectancy_pct | — | 6.15 | 0.45 |
| stdev_pct | — | 63.15 | 59.33 |
| profit_factor | — | 1.32 | 1.02 |
| max_drawdown_pct | 0.0 | 99.13 | 99.7 |
| max_consecutive_losses | 0 | 7 | 9 |
| bootstrap95_ci_avg_pct | — | [-12.95, 29.69] | [-16.2, 20.84] |
| sample_warning | n=0: no trades at this threshold | — | — |

## Benchmarks

| Mode | strawman always-CE | strawman always-PE | buy&hold NIFTY |
|---|---|---|---|
| ±40 | n=98 WR 29.6% tot -835.4% | n=98 WR 31.6% tot -77.7% | -0.22% |
| ±20 | n=98 WR 29.6% tot -835.4% | n=98 WR 31.6% tot -77.7% | -0.22% |
| ±15 | n=98 WR 29.6% tot -835.4% | n=98 WR 31.6% tot -77.7% | -0.22% |

Always-long-CE/PE are **strawman benchmarks** (no filter), not realistic strategies. Benchmarks are context only — not proof of superiority.

## Data Validation

- Real historical data: NSE FO bhavcopy archives + Yahoo (^NSEI, ^INDIAVIX) + NSE participant-OI CSVs. Synthetic prices: **none**.
- No look-ahead: signals computed from session-D data only (bhavcopy D, spot D 14:00, VIX D, FII D); D+1 OHLC used only for post-entry trade management
- TradDt == session date mismatches: none
- Expiry weekdays observed: {'Tue': 118, 'Mon': 7} (NIFTY weekly = Tuesday)
- Skill scripts byte-identical before/after run: **True**
- Missing sessions (reported, not fabricated): 0
- Missing-data behavior unchanged (score 0 / NO_TRADE per skill rules).


### Calendar integrity (post-run audit)
- Actual NSE sessions in span: **126**; tested as signal days: **125**.
- **2026-09-22 untested**: NSE traded (bhavcopy verified, 1.16 MB) but Yahoo ^NSEI close was null → excluded from calendar. Reported, not fabricated.
- All other Yahoo exclusions (2026-03-26, 03-31, 04-03, 04-14, 05-01, 05-28, 06-26, 09-14) verified as **NSE holidays** (FO bhavcopy 404 → no session) → correctly excluded.
- One pair (2026-09-21 → 2026-09-23) has a stretched management window that skips 09-22. The +16 CE signal on 09-21 was skipped (nearest expiry 2026-09-22 had no post-expiry quote on 09-23 → data unavailable). **Trades relying on an incomplete management window: 0.**

## Files

- `skills/nse-options-signal/scripts/backtest_history.py` (harness only)
- `skills/nse-options-signal/backtest_report.json`
- `skills/nse-options-signal/backtest_report.md`

*Research/backtest only — production strategy unchanged.*
