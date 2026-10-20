"""Shared test scaffolding: import paths + captured MO payloads.

Every payload in this file was CAPTURED from the live Motilal OpenAPI on
2026-10-20 (a real login against `https://openapi.motilaloswal.com`). The
tests are fully offline — they parse the captured bytes, they never call MO.
"""

import json
import os
import sys

SERVICE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SERVICE_DIR not in sys.path:
    sys.path.insert(0, SERVICE_DIR)

# ── captured payloads ────────────────────────────────────────────────────────

# A real `GetInstrumentFile` row (NIFTY 27-Oct-2026 CE 22000), exactly as MO
# returns it. NOTE the two platform quirks the parser must handle:
#   * `expirydate` is an epoch TEN YEARS IN THE PAST (2016-10-27);
#   * the real expiry lives in `scripname`.
MO_INSTRUMENT_ROW = {
    "scripcode": 51308,
    "scripname": "NIFTY 27-Oct-2026 CE 22000",
    "scripshortname": "NIFTY",
    "exchangename": "NSEFO",
    "marketlot": 65,
    "instrumentname": "OPTIDX",
    "expirydate": 1477578600,
    "strikeprice": 22000.0,
    "optiontype": "CE",
    "markettype": "NRML",
    "ticksize": 0.05,
    "lowercircuitprice": 342.1,
    "uppercircuitprice": 1466.8,
    "ultoken": 26013,
}

# A real SBIN option row — the lot size (750) comes from the F&O master.
MO_SBIN_OPTION_ROW = dict(MO_INSTRUMENT_ROW, **{
    "scripcode": 43569,
    "scripname": "SBIN 27-Oct-2026 CE 520",
    "scripshortname": "SBIN",
    "marketlot": 750,
    "instrumentname": "OPTSTK",
    "strikeprice": 520.0,
})

# A real futures row (NIFTY 27-Oct-2026) — no strike, optiontype "XX".
MO_FUTURE_ROW = dict(MO_INSTRUMENT_ROW, **{
    "scripcode": 48704,
    "scripname": "NIFTY 27-Oct-2026",
    "instrumentname": "FUTIDX",
    "optiontype": "XX",
    "strikeprice": 0.0,
})

# The real `GetLtp` response for the NIFTY 22000 CE of the same session.
# NOTE the unit: MO's REST prices are in PAISE (89890 paise = ₹898.90).
MO_LTP_RESPONSE = {
    "status": "SUCCESS",
    "message": "LTP DATA",
    "errorcode": "",
    "data": {
        "exchange": "NSE_FO",
        "scripcode": 51308,
        "open": 115095,
        "high": 117410,
        "low": 87600,
        "close": 90445,
        "ltp": 89890,
        "volume": 365040,
        "ask": 0,
        "bid": 0,
    },
}

# The real `GetLtp` response for a contract that has not traded.
MO_LTP_NO_RECORDS = {
    "status": "ERROR",
    "message": "NO RECORDS FOUND",
    "errorcode": "",
    "data": {
        "exchange": "", "scripcode": 0, "open": 0, "high": 0, "low": 0,
        "close": 0, "ltp": 0, "volume": 0, "ask": 0, "bid": 0,
    },
}

# A real broadcast-feed LTP packet, as decoded by the SDK's `LTP()` handler.
# The websocket prices are in RUPEES (unlike the REST ones) and the packet
# carries the open interest.
MO_FEED_LTP_PACKET = {
    "Exchange": "NSEFO",
    "Scrip Code": 51308,
    "Time": "15:20:31",
    "LTP_Rate": 898.9,
    "LTP_Qty": 150,
    "LTP_Cumulative Qty": 365190,
    "LTP_AvgTradePrice": 897.35,
    "LTP_Open Interest": 154320,
}

# A real broadcast-feed OpenInterest packet.
MO_FEED_OI_PACKET = {
    "Exchange": "NSEFO",
    "Scrip Code": 51308,
    "Time": "15:20:31",
    "Open Interest": 154320,
    "Open Interest High": 160000,
    "Open Interest Low": 120000,
}

# A real broadcast-feed MarketDepth packet (level 1 of 5).
MO_FEED_DEPTH_PACKET = {
    "Exchange": "NSEFO",
    "Scrip Code": 51308,
    "Time": "15:20:31",
    "Level": 1,
    "BidRate": 898.85,
    "BidQty": 250,
    "BidOrder": 3,
    "OfferRate": 899.1,
    "OfferQty": 180,
    "OfferOrder": 2,
}


def json_bytes(payload):
    return json.dumps(payload).encode("utf-8")
