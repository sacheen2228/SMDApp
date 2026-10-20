"""Instrument master parsing — the AUTHORITATIVE contract master (lot sizes).

Source of truth: Motilal OpenAPI `GetInstrumentFile` (the SDK's
`/rest/report/v3/getscripsbyexchangename`).

Row shape (verified live 2026-10-20):

    {scripcode, scripname, scripshortname, exchangename, marketlot,
     instrumentname, expirydate, strikeprice, optiontype, markettype,
     ticksize, lowercircuitprice, uppercircuitprice, ultoken, ...}

Three platform facts this module encodes (all verified live):

1. `expirydate` is an epoch **10 years in the past**. The real date is in
   `scripname` ("NIFTY 27-Oct-2026 CE 26400") — parsed first; the epoch
   (+10 years) is only a fallback.
2. The **cash** master carries `marketlot: 1` for equities (SBIN EQ) while
   the **F&O** master carries the real OPTION lot (SBIN → 750). Lot sizes
   must therefore be read from the F&O rows, never from the cash master.
3. `optiontype` is "CE"/"PE" for options, "XX" for futures and "EQ" for
   cash equity.
"""

import re

_MONTHS = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}

_MONTH_NAMES = {num: name for name, num in _MONTHS.items()}

# "NIFTY 27-Oct-2026 CE 26400" / "SBIN 29-Dec-2026 CE 1400" / "NIFTY 23-Nov-2026"
_NAME_RE = re.compile(
    r"^(?P<symbol>[A-Za-z0-9&.\-_]+)\s+"
    r"(?:(?P<day>\d{1,2})-(?P<mon>[A-Za-z]{3})-(?P<year>\d{4}))?"
    r"(?:\s+(?P<type>CE|PE))?"
    r"(?:\s+(?P<strike>\d+(?:\.\d+)?))?\s*$"
)

# The tradingsymbol we expose is the NSE convention:
#   <UNDERLYING><YY><MMM><YYYY><STRIKE><CE|PE>   e.g. SBIN26OCT2026750CE
_TS_RE = re.compile(
    r"^(?P<symbol>[A-Za-z0-9&.\-_]+?)(?P<yy>\d{2})(?P<mon>JAN|FEB|MAR|APR|MAY|JUN|"
    r"JUL|AUG|SEP|OCT|NOV|DEC)(?P<year>\d{4})(?P<strike>\d+(?:\.\d+)?)(?P<type>CE|PE)$"
)

OPTION_INSTRUMENTS = ("OPTSTK", "OPTIDX")
FUTURE_INSTRUMENTS = ("FUTSTK", "FUTIDX")

# Bump whenever the SHAPE of a parsed contract changes. The on-disk instrument
# cache stores the PARSED contracts, so a stale cache would silently serve the
# old shape (e.g. the version without `tradingsymbol`). The service compares
# this value with the one in the cache file and re-fetches on a mismatch.
PARSER_VERSION = 2


def _num(value, default=0.0):
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _int(value, default=0):
    try:
        if value is None or value == "":
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


def parse_expiry_from_name(scripname):
    """Return the expiry as `YYYY-MM-DD` parsed out of the scrip name.

    Returns None when the name carries no date (cash rows, some futures).
    """
    if not scripname:
        return None
    match = _NAME_RE.match(str(scripname).strip())
    if not match or not match.group("year"):
        return None
    mon = _MONTHS.get((match.group("mon") or "").upper())
    if not mon:
        return None
    day = _int(match.group("day"), 0)
    if day <= 0:
        return None
    return "%04d-%02d-%02d" % (_int(match.group("year")), mon, day)


def expiry_from_epoch(epoch):
    """MO's expiry epoch is 10 years behind — correct it and return YYYY-MM-DD."""
    value = _int(epoch, 0)
    if value <= 0:
        return None
    import datetime
    corrected = value + 315360000  # +10 years, in seconds
    try:
        return datetime.datetime.utcfromtimestamp(corrected).strftime("%Y-%m-%d")
    except (ValueError, OverflowError, OSError):
        return None


def build_tradingsymbol(symbol, expiry, strike, option_type):
    """Build the NSE-style tradingsymbol for an option contract.

    `expiry` is `YYYY-MM-DD`; `option_type` is CE/PE.
    """
    sym = str(symbol or "").strip().upper()
    if not sym or not expiry or not option_type:
        return None
    try:
        year, month, _day = str(expiry).split("-")
    except ValueError:
        return None
    mon = _MONTH_NAMES.get(int(month), None)
    if not mon:
        return None
    strike_txt = str(_int(strike, 0))
    if strike_txt == "0":
        return None
    return "%s%s%s%s%s%s" % (sym, year[2:], mon, year, strike_txt, str(option_type).upper())


def build_future_tradingsymbol(symbol, expiry):
    """Build the tradingsymbol for a futures contract (`<SYM><YY><MMM><YYYY>FUT`).

    Futures have no strike, so they need their own builder. Returns None when
    the symbol or the expiry is missing.
    """
    sym = str(symbol or "").strip().upper()
    if not sym or not expiry:
        return None
    try:
        year, month, _day = str(expiry).split("-")
    except ValueError:
        return None
    mon = _MONTH_NAMES.get(int(month), None)
    if not mon:
        return None
    return "%s%s%s%sFUT" % (sym, year[2:], mon, year)


def parse_tradingsymbol(tradingsymbol):
    """Inverse of `build_tradingsymbol` — returns a dict or None."""
    if not tradingsymbol:
        return None
    match = _TS_RE.match(str(tradingsymbol).strip().upper())
    if not match:
        return None
    mon = _MONTHS[match.group("mon")]
    strike = _num(match.group("strike"))
    return {
        "symbol": match.group("symbol"),
        "expiry": "%s-%02d-01" % (match.group("year"), mon),
        "strike": strike,
        "optionType": match.group("type"),
    }


def normalise_row(row, exchange=None):
    """Turn one MO instrument row into the service's contract shape.

    Returns None for rows that are not usable contracts.
    """
    if not isinstance(row, dict):
        return None
    symbol = str(row.get("scripshortname") or "").strip().upper()
    if not symbol:
        return None
    scripcode = _int(row.get("scripcode"), 0)
    if scripcode <= 0:
        return None
    exch = str(row.get("exchangename") or exchange or "").strip().upper()
    instrument = str(row.get("instrumentname") or "").strip().upper()
    option_type = str(row.get("optiontype") or "").strip().upper()
    if option_type in ("XX", "EQ", ""):
        option_type = ""
    strike = _num(row.get("strikeprice"), 0.0)
    scrip_name = str(row.get("scripname") or "").strip()
    expiry = parse_expiry_from_name(scrip_name) or expiry_from_epoch(row.get("expirydate"))
    lot = _int(row.get("marketlot"), 0)
    tick = _num(row.get("ticksize"), 0.0)
    lower = _num(row.get("lowercircuitprice"), 0.0)
    upper = _num(row.get("uppercircuitprice"), 0.0)

    is_option = option_type in ("CE", "PE")
    tradingsymbol = None
    if is_option and expiry and strike > 0:
        tradingsymbol = build_tradingsymbol(symbol, expiry, strike, option_type)
    elif not is_option and expiry and instrument in FUTURE_INSTRUMENTS:
        tradingsymbol = build_future_tradingsymbol(symbol, expiry)

    return {
        "tradingsymbol": tradingsymbol,
        "symbol": symbol,
        "exchange": exch,
        "scripcode": scripcode,
        "ultoken": _int(row.get("ultoken"), 0),
        "scripname": scrip_name,
        "expiry": expiry,
        "strike": strike if is_option else None,
        "optionType": option_type if is_option else None,
        "instrumentType": instrument or None,
        "lotSize": lot if lot > 0 else None,
        "tickSize": tick if tick > 0 else None,
        "lowerCircuit": lower if lower > 0 else None,
        "upperCircuit": upper if upper > 0 else None,
    }


def parse_master(payload, exchange=None):
    """Parse a full `GetInstrumentFile` payload into a list of contracts.

    `payload` is the raw MO response dict (or an already-unwrapped list).
    Rows that are not contracts are dropped; the row count that was dropped
    is reported by the caller through `master_stats`.
    """
    rows = []
    if isinstance(payload, dict):
        if payload.get("status") not in (None, "SUCCESS"):
            return []
        rows = payload.get("data") or []
    elif isinstance(payload, list):
        rows = payload
    out = []
    for row in rows:
        contract = normalise_row(row, exchange)
        if contract:
            out.append(contract)
    return out


def is_option_contract(contract):
    return bool(contract) and contract.get("optionType") in ("CE", "PE")


def lot_sizes_from_contracts(contracts):
    """Map underlying symbol -> contract lot size.

    Only F&O contracts (options and futures) contribute: the CASH master
    reports `marketlot: 1` for every equity, which would silently destroy
    the real option lot size (SBIN: 1 instead of 750).

    When a symbol has both an option row and a future row, the OPTION lot
    wins — that is the lot we size positions with.
    """
    lots = {}
    is_option = {}
    for contract in contracts or []:
        if not contract:
            continue
        instrument = (contract.get("instrumentType") or "").upper()
        option_row = is_option_contract(contract)
        if instrument:
            if instrument not in OPTION_INSTRUMENTS + FUTURE_INSTRUMENTS:
                continue
        elif not option_row:
            continue
        symbol = contract.get("symbol")
        lot = contract.get("lotSize")
        if not symbol or not lot or lot <= 0:
            continue
        if symbol not in lots:
            lots[symbol] = lot
            is_option[symbol] = option_row
        elif option_row and not is_option.get(symbol):
            lots[symbol] = lot
            is_option[symbol] = True
    return lots


def index_by_tradingsymbol(contracts):
    """tradingsymbol -> contract (last row wins; MO has no duplicate tradingsymbols)."""
    out = {}
    for contract in contracts or []:
        ts = contract.get("tradingsymbol")
        if ts:
            out[ts.upper()] = contract
    return out


def index_by_contract_key(contracts):
    """(SYMBOL, EXPIRY, STRIKE, CE/PE) -> contract."""
    out = {}
    for contract in contracts or []:
        if not is_option_contract(contract):
            continue
        key = (
            contract.get("symbol"),
            contract.get("expiry"),
            float(contract.get("strike") or 0),
            contract.get("optionType"),
        )
        out[key] = contract
    return out


def find_option_contracts(contracts, symbol, expiry=None, strike=None, option_type=None):
    """All option contracts matching a symbol (+ optional expiry/strike/type)."""
    sym = str(symbol or "").strip().upper()
    out = []
    for contract in contracts or []:
        if not is_option_contract(contract):
            continue
        if contract.get("symbol") != sym:
            continue
        if expiry and contract.get("expiry") != expiry:
            continue
        if strike is not None and float(contract.get("strike") or 0) != float(strike):
            continue
        if option_type and contract.get("optionType") != str(option_type).upper():
            continue
        out.append(contract)
    return out


def expiries_for(contracts, symbol, min_expiry=None):
    """Sorted list of expiries (YYYY-MM-DD) for a symbol.

    `min_expiry` (YYYY-MM-DD) drops the contracts that have already expired —
    MO keeps them in the master, and a stale weekly would be the "nearest"
    one to an old date.
    """
    seen = set()
    for contract in contracts or []:
        if contract.get("symbol") != str(symbol or "").strip().upper():
            continue
        expiry = contract.get("expiry")
        if not expiry:
            continue
        if min_expiry and expiry < min_expiry:
            continue
        seen.add(expiry)
    return sorted(seen)


def future_for(contracts, symbol, expiry=None):
    """The futures contract for a symbol (nearest expiry when not given)."""
    sym = str(symbol or "").strip().upper()
    candidates = []
    for contract in contracts or []:
        if contract.get("symbol") != sym:
            continue
        instrument = (contract.get("instrumentType") or "").upper()
        if instrument not in FUTURE_INSTRUMENTS:
            continue
        if expiry and contract.get("expiry") != expiry:
            continue
        candidates.append(contract)
    if not candidates:
        return None
    candidates.sort(key=lambda c: (c.get("expiry") or ""))
    return candidates[0]
