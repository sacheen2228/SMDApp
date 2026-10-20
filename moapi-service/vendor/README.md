# Vendored Motilal Oswal OpenAPI (MOAPI) Python SDK

## Upstream

| | |
|---|---|
| Repository | https://github.com/motradingapi/PythonSDK.git |
| File | `MOFSLOPENAPI.py` (single-file SDK, 3250 lines) |
| Upstream version | `sdkversion Python 5.0` — README.txt: *"Implementation guide sdkversion Python 5.0 Release - 01/09/2026"* |
| Upstream commit | `9c4bb24` — *"Major Updates 04092026"* (clone at `/tmp/opencode/moapi-sdk`) |
| Vendored on | 2026-10-20 (this repo) |
| License | The upstream repository ships **no LICENSE file**. The SDK is Motilal Oswal Securities' official client library; it is redistributed here UNMODIFIED for use against the account that owns the API key. Treat it as third-party, vendor-owned code: do not edit it, and re-check the upstream terms before any wider redistribution. The `websocket/` directory is `websocket-client` (Apache License 2.0, © 2022 engn33r) — see the header of `websocket/__init__.py`. |

## What is in this directory

| Path | What it is | Modified? |
|---|---|---|
| `MOFSLOPENAPI.py` | The official Motilal OpenAPI Python SDK, byte-for-byte as upstream. | **No** |
| `websocket/` | `websocket-client` (the SDK does `import websocket`). Upstream copies it inside the SDK repo; the machine already has `websocket-client 1.9.0` installed, which is NEWER than this vendored copy, so the installed package wins (see "Import order" below). | **No** (test dir removed) |
| `geocoder.py` | A STUB written for this repo (not upstream). | **New** |

### Import order (important)

`moapi/client.py` appends this directory to the END of `sys.path`, it does
**not** prepend it. Consequence:

* `import websocket` → the installed `websocket-client 1.9.0` is found first
  (site-packages precedes the appended path). The vendored 2022 copy is only
  used on a machine that has no `websocket-client` installed.
* `import MOFSLOPENAPI` → found here (nothing else provides it).
* `import geocoder` → found here (the real package is not installed).

If you ever `sys.path.insert(0, ...)` this directory instead, the vendored
2022 `websocket-client` will SHADOW the installed 1.9.0. Don't.

## What was stubbed, and WHY

`pip install` is not available in this environment (no PyPI access), and the
upstream `requirements.txt` lists packages that are not installed:

```
requests ✓   websocket ✓   six ✓   urllib3 ✓   pandas ✓
geocoder ✗   pyotp ✗       ratelimit ✗   simplejson ✗   future ✗   WMI ✗
```

| Missing package | Where the SDK needs it | How this repo handles it |
|---|---|---|
| `geocoder` | `import geocoder` at MODULE level (top of `MOFSLOPENAPI.py`) → the entire SDK fails to import. It is used ONLY in the `except` branch of `GetLatitudeLongitude()`, which is unreachable (the function body assigns a literal `[0, 0]` and cannot raise). | **`geocoder.py` stub in this directory.** It returns the fixed coordinate `[19.0760, 72.8777]` — the SAME value the SDK itself hardcodes as its fallback — so the `latitude`/`longitude` headers the SDK sends are identical to upstream. No network call, no IP lookup, no geocoding. |
| `pyotp` | The SDK does **not** import `pyotp`. It takes the TOTP as a parameter: `login(..., f_totp=...)`. | **Nothing to stub.** `moapi-service/totp.py` generates the 6-digit code with the standard library only (`hmac` + `hashlib` + `base64` + `struct`) — RFC 6238, SHA-1, 30-second step, 6 digits. `moapi/totp.py` is a shim that re-exports it (one implementation only). |
| `ratelimit` | Not imported by the SDK. | Nothing to stub. |
| `simplejson` | Not imported by the SDK (`json` from the stdlib is used). | Nothing to stub. |
| `future` | Not imported by the SDK. | Nothing to stub. |
| `WMI` | The SDK has `# import wmi` COMMENTED OUT at the top. | Nothing to stub. |

## Behavioural notes found while integrating (verified live on 2026-10-20)

These are MO platform facts, not SDK bugs. The service encodes them:

1. **Two price units.** `GetLtp` (`/rest/report/v3/getltpdata`) returns prices
   in **PAISE** (integer × 100 of the rupee price). The **websocket broadcast
   feed returns RUPEES**. Verified against the NSE chain: MO `ltp=210635`
   (paise) = NSE lastPrice `2106.35`; broadcast `LTP_Rate=22894.0` = the
   NIFTY future at 22894.
2. **`expirydate` is 10 years off.** MO returns the expiry as an epoch that is
   exactly 10 years in the past (e.g. `1477578600` = 2016-10-27 for the real
   2026-10-27 expiry). The `scripname` carries the true date
   (`"NIFTY 27-Oct-2026 CE 26400"`) — the service parses THAT, and only falls
   back to the epoch (+10 years) when the name has no date.
3. **The cash master has the wrong lot for options.** In the `NSE` (cash)
   master `SBIN EQ` has `marketlot: 1`; in the `NSEFO` master the `SBIN`
   option contract has `marketlot: 750`. Lot sizes must come from the
   **F&O** master.
4. **`/rest/report/v1/*` is dead** ("Invalid Token" on every path even with a
   valid session). Only `/rest/report/v3/*` works. The SDK's
   `GetIndexLTP`/`getindexltpdata` (v1) is therefore unusable.
5. **The REST LTP payload carries NO open interest.** Verified live on
   2026-10-20: the `GetLtp` response is
   `{exchange, scripcode, open, high, low, close, ltp, volume, ask, bid}` —
   there is no OI field. OI (and market depth) exist only on the websocket
   broadcast feed, so the service's `/oi` and `/depth` endpoints need
   `MOAPI_WEBSOCKET=1`; with the feed off they answer 503 with that reason.

## Third-party code

`MOFSLOPENAPI.py` and the `websocket/` directory are third-party code, kept
unmodified on purpose. Bug fixes and platform changes belong upstream
(<https://github.com/motradingapi/PythonSDK.git>); re-vendor rather than
patch in place.
