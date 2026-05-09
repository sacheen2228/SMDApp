---
Task ID: 2
Agent: Main
Task: Integrate Motilal Oswal live API for real market data

Work Log:
- Created .env with MO API credentials (API key, TOTP secret)
- Installed otplib for TOTP code generation
- Created /src/lib/motilal-oswal-api.ts - Full MO OpenAPI integration service
  - TOTP-based authentication with authdirectapi endpoint
  - Access token generation
  - Scrip master data fetching (NFO instruments)
  - LTP data fetching for individual and batch symbols
  - Option chain data assembly from live market data
- Created /src/lib/greeks.ts - Black-Scholes Greeks calculator (extracted for reuse)
- Updated /src/app/api/option-chain/route.ts:
  - Tries live MO data first, falls back to simulated data
  - Calculates Greeks (Delta, Gamma, Theta, Vega) for live data
  - Estimates IV from option prices using Newton-Raphson
  - Returns isLive flag in response
- Updated frontend to show LIVE/SIMULATED indicator in footer
  - Green "LIVE · Motilal Oswal" when connected
  - Amber "SIMULATED · Demo Data" when using fallback

Stage Summary:
- MO API integration is complete but requires MO_USER_ID and MO_PASSWORD to activate
- Current state: falls back to simulated data (isLive: false)
- User needs to provide their Motilal Oswal trading account credentials to go live
- Server running stably with PM2
