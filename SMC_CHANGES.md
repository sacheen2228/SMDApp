# SMC Structure + OI/Greeks Fusion – Changelog

## New Engine
- `src/lib/smc-engine.ts` – BOS/CHoCH/MSS/OB/FVG/IFVG/BSL/SSL/EQH/EQL/Liquidity Sweep/Displacement detection from real OHLC

## Integration
- ZeroHeroTerminal: Smart Money candidates now require SMC bias + OI/Greeks/VWAP confirmation
- MorningSignalGenerator: Morning scan gated by SMC engine
- WeeklyEquityScannerPanel: Added SMC column + SMC only filter

## Strike Selection
- `src/lib/option-plan.ts` – OI/Greeks-weighted strike selection
- Telegram alerts now include Strike Rationale: OI build %, Delta, Gamma, VWAP

## Data Quality & Freshness
- DataFreshnessBadge added to Institutional Flow, Market Regime, Breadth, CAS
- Fallback chain NSE → BSE → MO → Breeze enforced
- Telegram send window IST fixed, deduped pre-market alerts

## Telegram
- Test endpoint `/api/telegram/test`
- Trade alerts include SMC + OI/Greeks rationale

Date: 2026-11-01
