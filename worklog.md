---
Task ID: 1
Agent: Main
Task: Fix .env and MO API integration code for local deployment with live data

Work Log:
- Updated .env with correct MO API credentials including Secret Key
- Fixed MO API base URL (confirmed: https://openapi.motilaloswal.com)
- Researched official MO API docs for exact endpoint formats
- Fixed login endpoint: uses `userid` field (not `clientcode`), SHA-256(password + apiKey) hash
- Added `apisecretkey` header to all authenticated API calls
- Added `browsername` and `browserversion` headers (required for WEB source)
- Fixed LTP endpoint: uses `scripcode` (number) for options, separate index LTP endpoint
- Added paisa-to-rupees conversion (MO API returns values in paisa)
- Fixed Scrip Master endpoint: uses `exchangename` field (not `exchange`)
- Added LiveDataSetupDialog component to UI with setup guide
- Updated footer with Wifi/WifiOff icons for data source status
- App compiles and runs successfully

Stage Summary:
- MO API integration code is now fully corrected per official documentation
- Key fixes: apisecretkey header, paisa conversion, correct field names, 2FA support
- User needs to add MO_TWO_FA (date of birth in DD/MM/YYYY) for login to work
- App must run from whitelisted IP (100.89.231.43) for MO API to work
- Graceful fallback: MO API → Yahoo Finance → Simulation
